#!/usr/bin/env bun
/**
 * pkg-cli - A monorepo cli tool that bootstraps and builds a JS application in a monorepo, with
 * careful handling of crosslinks to mimic the install behavior of published npm packages.
 *
 * Motivation:
 *   1. Existing monorepo tools mismanage crosslinks in a monorepo, by linking them via a basic symlink.
 *     This causes many issues, such as:
 *     1. deeply nested node_modules folders
 *     2. devDependencies of the crosslinks being installed
 *     3. dependencies being in diff places vs if installed as an npm package
 *     4. symlink issues todo with the way that node resolves modules
 *   2. Existing monorepo tools don't allow for each package to have it's own package manager and lock
 *      file, which dramatically decreases flexibility, while dramatically increasing cost of adoption
 *
 *   Example crosslink conflicts in existing tools:
 *   - a React app may have deps that have devDeps with diff version of React. This causes typescript
 *     and bundlers to include multiple versions of React, which blows up the bundle size,
 *     causes runtime errors, and typescript errors.
 *   - symlink resolution conflict: if "libA" depends on lodash, and "libB" depends on lodash and
 *     "libA", nested libA will use it's own copy of lodash instead of libB's.
 *
 * Goal: De-conflict nested dependencies
 *
 * Assumptions:
 *  - This script is called from either the root of the monorepo, or from a package directory
 *  - The crosslinks of the package are already built and packed into package.tgz
 */
import arg from "arg";
import chokidar from "chokidar";
import {
  cachify,
  Dict,
  fs,
  Log,
  logDefault,
  O,
  P,
  PReturnType,
  sh,
  stepErr,
  stepErrCb,
  str,
  Time,
  UTIL_ENV,
} from "./util.js";
import path from "path";

const ENV = {
  logLevel: Number(process.env.LOG ?? 1),
  ci: process.env.CI === "1" ? true : false,
};

const log = new Log({ prefix: "pkg-cli:" });
const log0 = log.l0;
const log1 = log.l1;
const log2 = log.l2;
const log3 = log.l3;
const log4 = log.l4;
const log5 = log.l5;
const log9 = log.l9;

async function main() {
  const usage = `
  Usage: bun pkg-cli.ts {action} {pkgPathOrBasename}

  Env:
  LOG=n: sets log level, 1-4 (default 1)
  DOMAIN_DEFAULT=@app: sets the default domain (default @app) for
    package names. You may omit the domain if using the default.

  Actions:
  bootstrap:
    - re-installs cross-linked packages as if they were
      file dependencies
  build: bootstrap + build + pack
  sync: rsyncs the builds of all cross-linked packages with 
  watch: sync with watch mode
  `;

  const args = arg({
    "--ci": String,
    "--help": Boolean,
    "--loglevel": Number,
    "--verbose": arg.COUNT, // Counts the number of times --verbose is passed

    // Aliases
    "-h": "--help",
    "-v": "--verbose",
  });

  if (args["--help"]) return console.log(usage);

  ENV.ci = UTIL_ENV.ci =
    args["--ci"] && ["1", "true"].includes(args["--ci"]) ? true : ENV.ci;
  ENV.logLevel = UTIL_ENV.logLevel =
    (ENV.logLevel > 1 && ENV.logLevel) ||
    args["--loglevel"] ||
    (args["--verbose"] ?? 0) + 1;

  let action = args._?.[0];
  if (!action) return console.log(usage);

  /** We don't support multple pkgs  */
  const pkgPathOrBasename = args._?.[1];
  if (!pkgPathOrBasename) return console.log(usage);

  log4(`pkg-cli->start: ${action} ${pkgPathOrBasename}`);
  log4(`pkg-cli->start: CI=${ENV.ci} logLevel=${ENV.logLevel}`);

  const pkg = await Pkg.getPkgC(pkgPathOrBasename, true);

  try {
    switch (action) {
      case "bootstrap": {
        await pkg.bootstrap();
        break;
      }
      case "build": {
        await pkg.build();
        break;
      }
      case "sync": {
        await pkg.syncCrosslinks();
        break;
      }
      case "watch": {
        await pkg.syncCrosslinks({ watch: true });
        break;
      }
      default:
        return console.log(usage);
    }
  } catch (e) {
    console.log("Full-log:", Log.file);
    throw e;
  }

  console.log("\nFull-log:", Log.file);
}

export class Pkg {
  constructor(
    public basename: string,
    public baz: {
      text: string;
      depsStartsAt: number;
      depsEndsAt: number;
      deps: string[];
      dirty: string[];
    },
    public clTreeFlat: Dict<Pkg>,
    public clTree: Dict<Pkg>,
    public json: {
      name: string;
      dependencies: Dict<string>;
      devDependencies: Dict<string>;
      peerDependencies: Dict<string>;
    },
    public jsonF: PReturnType<typeof fs.getPkgJsonFile>,
    public pathAbs: string,
    public pathRel: string,
    public pathWs: string,
    public text: string
  ) {}

  // assert that the bazel deps are correct in the BUILD.bazel file
  assertBazelDeps = async () => {
    log4(`assertBaz->${this.basename}`);
    if (this.baz.dirty.length) {
      const errMsg = `ERROR: You dependencies in your BUILD.bazel file are out of date in ${this.basename}.`;
      log1(errMsg);
      log1("You need to update your BUILD.bazel file with:");
      log1(this.baz.dirty.join("\n"));
      log1(
        "We tried to correct it for you, and you'll need to re-start this build"
      );
      await this.fixBazel();
      throw stepErr(Error(errMsg), "fixBaz-bail");
    }
    log3(`assertBaz->end ${this.basename}`);
  };

  bootstrap = async () => {
    log1(`bootstrap->${this.basename}`);
    const start = Date.now();
    try {
      await this.yarnPreinstall();
      await this.yarnInstall();
      await this.reset();
      if (this.baz.dirty.length) {
        await this.fixBazel();
      }
    } catch (e: any) {
      await this.reset();
      throw stepErr(e, "bootstrap");
    }
    log1(`bootstrap->end ${Time.diff(start)}`);
  };

  build = async () => {
    log1(`build->${this.basename}`);
    const start = Date.now();
    try {
      await this.assertBazelDeps();
      await this.bootstrap();
      await this.yarnPrebuild();
      await this.yarnBuild();
      await this.yarnPrepack();
      await this.yarnPack();
      await this.yarnPostpack();
    } catch (e: any) {
      log1(e);
      log1(`BUILD:ERROR! STEP=${e?.step ?? "unknown"}`);
      log1(`BUILD:ERRORJSON->${str(e)}`);
      throw e;
    }
    log1(`build->end ${Time.diff(start)}`);
  };

  /** Fixes a broken BUILD.bazel */
  fixBazel = async () => {
    log4(`fixBaz->${this.basename}`);
    try {
      const bazDeps = O.keys(this.clTreeFlat);
      this.baz.text = this.baz.text.replace(
        this.baz.text.slice(this.baz.depsStartsAt, this.baz.depsEndsAt),
        JSON.stringify(bazDeps.map((d) => `//packages/${d}:package.tgz`).sort())
      );
      fs.writeFile(`packages/${this.basename}/BUILD.bazel`, this.baz.text);
    } catch (e) {
      stepErrCb("fixBaz");
    }
    log3(`fixBaz->end ${this.basename}`);
  };

  reset = async () => {
    log4(`reset->${this.basename}`);
    try {
      await P.all([
        // FIXME: using fs would be faster than sh.exec
        sh.exec(`sed -i '' -n '/@..\\//,/^$/!p' yarn.lock`, {
          wd: this.pathAbs,
        }),
        this.jsonF.reset(),
      ]);
    } catch (e: any) {
      throw stepErr(e, "reset");
    }
    log3(`reset->end ${this.basename}`);
  };

  yarnCleanCache = async () => {
    log4(`cleanCache->${this.basename}`);
    try {
      // # FIXME: rimrafing the cache may be faster than calling yarn clean {pkg}. Would need to test though.
      await sh.exec(`yarn cache clean ${this.json.name}`, {
        wd: this.pathAbs,
      });
      await sh.exec(
        `find $(yarn cache dir)/.tmp -name package.json -exec grep -sl ${this.json.name} {} \\; ` +
          `| xargs dirname | xargs rm -rf`,
        {
          wd: this.pathAbs,
        }
      );
    } catch (e) {
      stepErrCb("cleanCache");
    }
    log3(`cleanCache->end ${this.basename}`);
  };

  /**
   * Preps the package for install by:
   * 1. removing cls from yarn.lock
   * 2. upserting cls as ../[pkg]/package.tgz to package.json
   */
  yarnPreinstall = async () => {
    log4(`yarnPreinstall->${this.basename}`);
    try {
      // 1. remove cls from yarn.lock so yarn fresh installs
      await sh.exec(
        '[ -f yarn.lock ] && sed -i "" -n "/@..\\//,/^$/!p" yarn.lock',
        { wd: this.pathAbs }
      );

      // 2. upsert cls (incl nested) as ../[pkg]/package.tgz to package.json

      // swap out the workspace:* (aka cls) with relative paths and add nested
      const pjs = this.json;
      O.values(this.clTreeFlat).forEach((cl) => {
        const name = cl.json.name;
        if (pjs.dependencies?.[name]) {
          pjs.dependencies[name] = `../${cl.basename}/package.tgz`;
        } else {
          if (!pjs.devDependencies) pjs.devDependencies = {};
          pjs.devDependencies[name] = `../${cl.basename}/package.tgz`;
        }
      });
      // scrub out workspace:* (aka cls) from peerDependencies
      if (pjs.peerDependencies)
        pjs.peerDependencies = O.fromEntries(
          O.entries(pjs.peerDependencies).filter(([, v]) => v !== "workspace:*")
        );

      // commit to filesystem
      await this.jsonF.save();
    } catch (e: any) {
      throw stepErr(e, "preinstall");
    }
    log3(`yarnPreinstall->end ${this.basename}`);
  };
  yarnInstall = async () => {
    log4(`yarnInstall->${this.basename}`);
    await sh
      .exec(`yarn install --mutex file`, { wd: this.pathAbs })
      .catch(stepErrCb("install"));
    log3(`yarnInstall->end ${this.basename}`);
  };

  /** Remove all crosslinks from package.json */
  yarnPrepack = async () => {
    log4(`yarnPrepack->${this.basename}`);
    try {
      const pjs = this.json;
      const rm = (deps: Record<string, string> = {}) =>
        Object.entries(deps)
          .filter(([d, v]) => v.startsWith("../") || v === "workspace:*")
          .forEach(([d, v]) => delete deps[d]);
      rm(pjs.dependencies);
      rm(pjs.devDependencies);
      rm(pjs.peerDependencies);
      await this.jsonF.save();
    } catch (e: any) {
      throw stepErr(e, "prepack");
    }
    log3(`yarnPrepack->end ${this.basename}`);
  };
  yarnPack = async () => {
    log4(`yarnPack->${this.basename}`);
    await sh
      .exec(`yarn pack -f package.tgz`, { wd: this.pathAbs })
      .catch(stepErrCb("pack"));
    log3(`yarnPack->end ${this.basename}`);
  };
  yarnPostpack = async () => {
    log4(`yarnPostpack->${this.basename}`);
    await P.all([this.yarnCleanCache(), this.reset()]).catch(
      stepErrCb("postpack")
    );
    log3(`yarnPostpack->end ${this.basename}`);
  };

  /** Clean up previous build */
  yarnPrebuild = async () => {
    log4(`yarnPrebuild->${this.basename}`);
    await P.all([
      fs.rm(`${this.pathAbs}/package.tgz`),
      fs.rm(`${this.pathAbs}/dist`),
      fs.rm(`${this.pathAbs}/build`),
      sh.exec(`yarn clean`, { wd: this.pathAbs }).catch(() => {}),
    ]).catch(stepErrCb("prebuild"));
    log3(`yarnPrebuild->end ${this.basename}`);
  };
  yarnBuild = async () => {
    log4(`yarnBuild->${this.basename}`);
    await sh.exec(`yarn build`, { wd: this.pathAbs }).catch(stepErrCb("build"));
    log3(`yarnPrebuild->end ${this.basename}`);
  };

  /** syncs the build artifacts of workspace deps with a package's node_modules */
  syncCrosslinks = async (
    options: {
      verbose?: boolean;
      watch?: boolean;
    } = {}
  ) => {
    const lctx = `Pkg.clSync->${this.json.name}`;

    const { verbose = true, watch = false } = options;

    let _log1 = log1;
    let _log2 = log2;
    let _log3 = log3;
    let _log4 = log4;
    if (verbose) {
      _log1 = _log2 = _log3 = _log4 = log1;
    }

    _log3(`${lctx}->start!`);

    const nestedNodeModules = `${this.pathRel}/node_modules`;

    // bail if there are no workspace deps
    if (!(await fs.stat(nestedNodeModules))) {
      _log3(`${lctx}->no ws packages to sync`);
      return;
    }

    const pkgsToWatch = O.values(this.clTree);

    const doSync = async () => {
      _log3(`${lctx}->syncing`);
      const delta = await P.all(
        pkgsToWatch.map(async (cl) => {
          if (await fs.stat(`${cl.pathAbs}`)) {
            return sh.exec(
              `rsync -av --delete --exclude=node_modules ${cl.pathRel}/ ` +
                `${nestedNodeModules}/${cl.json.name}`,
              { wd: this.pathWs, silent: true }
            );
          }
          return "";
        })
      );

      const trimmed = delta
        // join and split bc is an array of multiline strings
        .join("\n")
        .split("\n")
        .filter((l) => l.trim())
        .filter((r) => !r.includes("created"))
        .filter((r) => !r.includes("done"))
        .filter((r) => !r.includes("./"))
        .filter((r) => !r.includes("sent"))
        .filter((r) => !r.includes("total"));
      trimmed.forEach((l) => {
        if (verbose) _log1(`${lctx}: ${l} upserted`);
      });
      _log2(`${lctx}->synced ${trimmed.length} packages`);
      return trimmed;
    };

    await doSync();

    if (watch) {
      const watcher = chokidar.watch([], {
        // FIXME: maybe don't sync whole folder
        ignored: /(node_modules|package.tgz)/,
        persistent: true,
      });
      watcher.on("change", () => doSync());
      pkgsToWatch.map(async (cl) => {
        _log1(`${lctx}:watching: ${cl.pathRel}`);
        watcher.add(`${cl.pathAbs}`);
      });
      return () => {
        watcher.close().then(() => log1(`${lctx}:end`));
      };
    }
    _log4(`${lctx}:end`);
  };

  /** Gets a package obj relative to the current dir */
  static getPkg = async (pathOrbasename: string, includeDevDeps?: boolean) => {
    log4(`getPkg->${pathOrbasename}`);
    try {
      let pathAbs: string, pathRel: string, pathWs: string, basename: string;
      if ([".", "./"].includes(pathOrbasename)) pathOrbasename = process.cwd();
      if (pathOrbasename.includes("/")) {
        pathAbs = pathOrbasename;
        basename = path.basename(pathAbs);
        pathWs = path.dirname(path.dirname(pathAbs));
        pathRel = path.relative(pathWs, pathAbs);
      } else {
        basename = pathOrbasename;
        pathWs = process.cwd();
        pathRel = `packages/${basename}`;
        pathAbs = `${pathWs}/${pathRel}`;
      }

      log2(`getPkg:path->match for ${basename}`);
      log4(`getPkg:path->${pathAbs}`);

      const jsonF = await fs.getPkgJsonFileC(pathAbs);
      const { text, json } = jsonF;

      const clTree: Pkg["clTree"] = {};
      const clTreeFlat: Pkg["clTreeFlat"] = {};

      const recurse = (deps: Dict<string> = {}) =>
        O.entries(deps ?? {})
          .filter(([, v]) => v === "workspace:*")
          .map(async ([depName]) => {
            const shortName = depName.split("/")[1];
            const cl = await Pkg.getPkgC(shortName);
            clTree[shortName] = clTreeFlat[shortName] = cl;
            Object.assign(clTreeFlat, cl.clTreeFlat);
          });

      const _p: Promise<any>[] = [];

      _p.push(...recurse(json.dependencies));

      if (includeDevDeps) _p.push(...recurse(json.devDependencies));

      await P.all(_p);

      const bazF = await fs.get(`${pathRel}/BUILD.bazel`);
      const bazTxt = bazF.text;

      // baz = bazel BUILD.bazel file
      // Find DEPS = ["//packages/lib1:package.tgz","//packages/lib3:package.tgz"]
      let bazDepsStartsAt = bazTxt.indexOf("DEPS = ");
      if (bazDepsStartsAt === -1)
        throw new Error("No DEPS found in BUILD.bazel");
      bazDepsStartsAt = bazDepsStartsAt + "DEPS = ".length;
      const bazDepsEndsAt = bazTxt.indexOf("]", bazDepsStartsAt) + 1;
      let bazDeps: string[] = JSON.parse(
        bazTxt
          .slice(bazDepsStartsAt, bazDepsEndsAt)
          .replace(new RegExp("//packages/", "g"), "")
          .replace(new RegExp(":package.tgz", "g"), "") || "[]"
      );
      const bazMissing = O.keys(clTreeFlat).filter(
        (name) => !bazDeps.includes(name)
      );
      const bazExtras = bazDeps.filter(
        (name) => !O.keys(clTreeFlat).includes(name)
      );
      const bazDirty = [
        ...bazExtras.map((b) => `-${b}`),
        ...bazMissing.map((b) => `+${b}`),
      ];
      const baz: PkgType["baz"] = {
        text: bazTxt,
        depsStartsAt: bazDepsStartsAt,
        depsEndsAt: bazDepsEndsAt,
        deps: bazDeps,
        dirty: bazDirty,
      };

      const pkg = new Pkg(
        basename,
        baz,
        clTreeFlat,
        clTree,
        json,
        jsonF,
        pathAbs,
        pathRel,
        pathWs,
        text
      );

      log3(`getPkg->done for ${basename}`);
      return pkg;
    } catch (e: any) {
      log1(e);
      log1(`PKG:ERROR! STEP=${e?.step ?? "unknown"}`);
      log1(`PKG:ERRORJSON->${str(e)}`);
      log1(e.stack);
      throw e;
    }
    // end getPkg
  };
  static getPkgC = cachify(Pkg.getPkg);

  // end Pkg
}
type PkgType = InstanceType<typeof Pkg>;

if (import.meta.url === `file://${process.argv[1]}`) {
  // @ts-expect-error - gets confused args
  await main(...process.argv.slice(2));
}
