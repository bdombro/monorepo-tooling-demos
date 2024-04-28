#!/usr/bin/env bun
/**
 * pkg-cli - A monorepo cli tool that bootstraps and builds a JS application in a monorepo, with
 * careful handling of crosslinks to mimic the install behavior of published npm packages.
 *
 * pkg-cli is a companion to bz-cli, which is a monorepo cli tool to orchestrate pkg-cli and the
 * bazel build manager to build multiple packages in a crosslink-intelligent way. Where pkg-cli
 * only handles the bootstrapping and building of a single package and assumes cross-link dep
 * build artifacts are already ready and built, bz-cli handles the topological build for both
 * a package and all it's dependents in a cache-assisted way.
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
import pathNode from "node:path";
import {
  Bazel,
  cachify,
  Dict,
  fs,
  LocalCache,
  Log,
  logDefault,
  O,
  omit,
  P,
  PReturnType,
  sh,
  stepErr,
  stepErrCb,
  str,
  str2,
  throwStepErr,
  Time,
  UTIL_ENV,
} from "./util.js";

const localCache = new LocalCache({ path: "/tmp/monocache" });

const log = new Log({ prefix: "PKG:" });
const log0 = log.l0;
const log1 = log.l1;
const log2 = log.l2;
const log3 = log.l3;
const log4 = log.l4;
const log5 = log.l5;
const log9 = log.l9;

const ENV = {
  logLevel: Number(process.env["LOG"] ?? 1),
  ci: process.env["CI"] === "1" ? true : false,
};

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
    "--show-loglevels": Boolean,
    "--show-timestamps": Boolean,
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

  if (args["--show-timestamps"])
    log.showTimestamps = logDefault.showTimestamps = true;
  if (args["--show-loglevels"])
    log.showLogLevels = logDefault.showLogLevels = true;

  let action = args._?.[0];
  if (!action) return console.log(usage);

  /** We don't support multple pkgs  */
  let pkgPathOrBasename = args._?.[1];
  if (!pkgPathOrBasename) return console.log(usage);
  if ([".", "./"].includes(pkgPathOrBasename))
    pkgPathOrBasename = pathNode.basename(process.cwd());
  if (pkgPathOrBasename.endsWith("/"))
    pkgPathOrBasename = pkgPathOrBasename.slice(0, -1);

  log4(`->start: ${action} ${pkgPathOrBasename}`);
  log4(`->start: CI=${ENV.ci} logLevel=${ENV.logLevel}`);

  try {
    switch (action) {
      case "bootstrap": {
        const pkg = await Pkg.getPkgC(pkgPathOrBasename);
        await pkg.bootstrap();
        break;
      }
      case "build": {
        const pkg = await Pkg.getPkgC(pkgPathOrBasename);
        await pkg.build();
        break;
      }
      case "sync": {
        const pkg = await Pkg.getPkgC(pkgPathOrBasename);
        await pkg.syncCrosslinks();
        break;
      }
      case "watch": {
        const pkg = await Pkg.getPkgC(pkgPathOrBasename);
        await pkg.syncCrosslinks({ watch: true });
        await sh.sleep(Infinity);
        break;
      }
      default:
        return console.log(usage);
    }
  } catch (e: any) {
    await log.lFinish(e);
    process.exit(1);
  }

  await log.lFinish();
}

export class Pkg {
  public basename: string;
  public baz: {
    text: string;
    depsStartsAt: number;
    depsEndsAt: number;
    deps: string[];
    dirty: string[];
  };
  public clBld: Dict<Pkg>;
  public clImp: Dict<Pkg>;
  public clDeps: Dict<Pkg>;
  public clDDeps: Dict<Pkg>;
  public json: {
    name: string;
    dependencies: Dict<string>;
    devDependencies: Dict<string>;
    peerDependencies: Dict<string>;
  };
  public jsonF: PReturnType<typeof fs.getPkgJsonFile>;
  public pathAbs: string;
  public pathRel: string;
  public pathWs: string;
  public text: string;

  public l0: Log["l0"];
  public l1: Log["l1"];
  public l2: Log["l2"];
  public l3: Log["l3"];
  public l4: Log["l4"];
  public l5: Log["l5"];
  public l9: Log["l9"];

  constructor({
    basename,
    baz,
    clBld,
    clImp,
    clDeps,
    clDDeps,
    json,
    jsonF,
    pathAbs,
    pathRel,
    pathWs,
    text,
  }: {
    basename: Pkg["basename"];
    baz: Pkg["baz"];
    clBld: Pkg["clBld"];
    clImp: Pkg["clImp"];
    clDeps: Pkg["clDeps"];
    clDDeps: Pkg["clDDeps"];
    json: Pkg["json"];
    jsonF: Pkg["jsonF"];
    pathAbs: Pkg["pathAbs"];
    pathRel: Pkg["pathRel"];
    pathWs: Pkg["pathWs"];
    text: Pkg["text"];
  }) {
    this.basename = basename;
    this.baz = baz;
    this.clBld = clBld;
    this.clImp = clImp;
    this.clDeps = clDeps;
    this.clDDeps = clDDeps;
    this.json = json;
    this.jsonF = jsonF;
    this.pathAbs = pathAbs;
    this.pathRel = pathRel;
    this.pathWs = pathWs;
    this.text = text;

    const log = new Log({ prefix: `PKG:${basename.toUpperCase()}` });
    this.l0 = log.l0;
    this.l1 = log.l1;
    this.l2 = log.l2;
    this.l3 = log.l3;
    this.l4 = log.l4;
    this.l5 = log.l5;
    this.l9 = log.l9;
  }

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
    this.l1(`:bootstrap`);
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
    this.l1(`:bootstrap->end ${Time.diff(start)}`);
  };

  assertClsBuilt = async () => {
    this.l1(`->assertClsBuilt`);
    await P.all(
      O.values(this.clBld).map((cl) =>
        fs.stat(`${cl.pathAbs}/package.tgz`).then((s) => {
          if (!s) {
            throw stepErr(
              Error(
                `Crosslink ${cl.basename} not built. Are you running pkg-cli directly and didn't ensure they were?`
              ),
              "assertClsBuilt"
            );
          }
        })
      )
    );
    this.l1(`:assertClsBuilt->end`);
  };

  build = async () => {
    this.l1(`->build`);
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
      throw stepErr(e, "build");
    }
    this.l1(`:build->end ${Time.diff(start)}`);
  };

  /** Fixes a broken BUILD.bazel */
  fixBazel = async () => {
    log4(`fixBaz->${this.basename}`);
    try {
      const bazDeps = O.keys(this.clImp);
      this.baz.text = this.baz.text.replace(
        this.baz.text.slice(this.baz.depsStartsAt, this.baz.depsEndsAt),
        JSON.stringify(bazDeps.map((d) => `//packages/${d}:package.tgz`).sort())
      );
      fs.set(`packages/${this.basename}/BUILD.bazel`, this.baz.text);
    } catch (e) {
      stepErrCb("fixBaz");
    }
    log3(`fixBaz->end ${this.basename}`);
  };

  reset = async () => {
    this.l4(`->reset`);
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
    this.l3(`:reset->end`);
  };

  yarnCleanCache = async () => {
    this.l4(`->cleanCache`);
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
    this.l3(`:cleanCache->end`);
  };

  /**
   * Preps the package for install by:
   * 1. removing cls from yarn.lock
   * 2. upserting cls as ../[pkg]/package.tgz to package.json
   */
  yarnPreinstall = async () => {
    this.l4(`->yarnPreinstall`);
    try {
      await this.assertClsBuilt().catch((e) => {
        throw stepErr(e, "yarnPreinstall");
      });

      // 1. remove cls from yarn.lock so yarn fresh installs
      await sh.exec(
        '[ -f yarn.lock ] && sed -i "" -n "/@..\\//,/^$/!p" yarn.lock',
        { wd: this.pathAbs }
      );

      // 2. upsert cls (incl nested) as ../[pkg]/package.tgz to package.json

      // swap out the workspace:* (aka cls) with relative paths and add nested
      const pjs = this.json;
      O.values(this.clImp).forEach((cl) => {
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
    this.l3(`:yarnPreinstall->end`);
  };
  yarnInstall = async () => {
    this.l4(`->yarnInstall`);
    await sh
      .exec(`yarn install --mutex file`, { wd: this.pathAbs })
      .catch(stepErrCb("install"));
    this.l3(`:yarnInstall->end`);
  };

  /** Remove all crosslinks from package.json */
  yarnPrepack = async () => {
    this.l4(`->yarnPrepack`);
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
    this.l3(`:yarnPrepack->end`);
  };
  yarnPack = async () => {
    this.l4(`->yarnPack`);
    await sh
      .exec(`yarn pack -f package.tgz`, { wd: this.pathAbs })
      .catch(stepErrCb("pack"));
    this.l3(`:yarnPack->end`);
  };
  yarnPostpack = async () => {
    this.l4(`->yarnPostpack`);
    await P.all([this.yarnCleanCache(), this.reset()]).catch(
      stepErrCb("postpack")
    );
    this.l3(`:yarnPostpack->end`);
  };

  /** Clean up previous build */
  yarnPrebuild = async () => {
    this.l4(`->yarnPrebuild`);
    await P.all([
      fs.rm(`${this.pathAbs}/package.tgz`),
      fs.rm(`${this.pathAbs}/dist`),
      fs.rm(`${this.pathAbs}/build`),
      sh.exec(`yarn clean`, { wd: this.pathAbs }).catch(() => {}),
    ]).catch(stepErrCb("prebuild"));
    this.l3(`:yarnPrebuild->end`);
  };
  yarnBuild = async () => {
    this.l4(`->yarnBuild`);
    await sh.exec(`yarn build`, { wd: this.pathAbs }).catch(stepErrCb("build"));
    this.l3(`:yarnPrebuild->end`);
  };

  /** syncs the build artifacts of workspace deps with a package's node_modules */
  syncCrosslinks = async (
    options: {
      verbose?: boolean;
      watch?: boolean;
    } = {}
  ) => {
    const { verbose = true, watch = false } = options;

    let log1 = this.l1;
    let log2 = this.l2;
    let log3 = this.l3;
    let log4 = this.l4;
    if (verbose) {
      log1 = log2 = log3 = log4 = this.l1;
    }

    if (watch) {
      log.showTimestamps = logDefault.showTimestamps = true;
      log1(`->watch`);
    } else log1(`->sync`);

    const nestedNodeModules = `${this.pathAbs}/node_modules`;

    // bail if there are no workspace deps
    if (!(await fs.stat(nestedNodeModules))) {
      log3(`->no ws packages to sync`);
      return;
    }

    const excludes = [
      "BUILD.bazel",
      "node_modules",
      "package.tgz",
      "yarn.lock",
    ];

    const pkgsToWatch = O.values(this.clBld);

    const doSync = async () => {
      log3(`->syncing`);
      const delta = await P.all(
        pkgsToWatch.map(async (cl) => {
          if (await fs.stat(`${cl.pathAbs}`)) {
            const res = await sh.exec(
              `rsync ${cl.pathRel}/ ` +
                `${nestedNodeModules}/${cl.json.name} ` +
                `-av --delete ` +
                excludes.map((e) => `--exclude=${e}`).join(" "),
              { wd: this.pathWs, silent: !verbose }
            );
            await fs.rm(`${nestedNodeModules}/.cache`);
            return res;
          }
          return "";
        })
      );

      const trimmed = delta
        // join and split bc is an array of multiline strings
        .join("\n")
        .split("\n")
        .filter((l) => l.trim())
        .filter((r) => !r.includes("..."))
        .filter((r) => !r.includes("created"))
        .filter((r) => !r.includes("done"))
        .filter((r) => !r.includes("./"))
        .filter((r) => !r.includes("sent"))
        .filter((r) => !r.includes("total"));
      trimmed.forEach((l) => {
        if (verbose) log1(`: ${l} upserted`);
      });

      log2(`->synced ${trimmed.length} packages`);
      return trimmed;
    };

    await doSync();

    if (watch) {
      const watcher = chokidar.watch([], {
        // FIXME: maybe don't sync whole folder
        ignored: new RegExp(`(${excludes.join("|")})`),
        persistent: true,
      });
      watcher.on("change", () => doSync());
      pkgsToWatch.map(async (cl) => {
        log1(`->watching: ${cl.pathRel}`);
        watcher.add(`${cl.pathAbs}`);
      });
      return () => {
        watcher.close().then(() => this.l1(`->end`));
      };
    }
    log4(`->end`);
  };

  /**
   * Gets a package obj relative to the current dir
   * please use the cachified version unless you really need fresh.
   */
  static getPkg = async (pathOrbasename: string) => {
    log4(`:get->${pathOrbasename}`);
    try {
      let pathAbs: string, pathRel: string, pathWs: string, basename: string;

      // pathOrbasename = pathOrbasename.replace(new RegExp("(/|./|.)$", "g"), "");
      pathOrbasename = pathOrbasename
        .replace(/\.\/$/, "")
        .replace(/\.$/, "")
        .replace(/\/$/, "");

      if (!pathOrbasename) pathOrbasename = process.cwd();

      if (pathOrbasename.split("/").length === 2) {
        basename = pathNode.basename(pathOrbasename);
        pathWs = await Bazel.findNearestWsRoot();
        pathRel = `packages/${basename}`;
        pathAbs = `${pathWs}/${pathRel}`;
      } else if (pathOrbasename.includes("/")) {
        pathAbs = pathOrbasename;
        basename = pathNode.basename(pathAbs);
        pathWs = pathNode.dirname(pathNode.dirname(pathAbs));
        pathRel = pathNode.relative(pathWs, pathAbs);
      } else {
        basename = pathOrbasename;
        pathWs = await Bazel.findNearestWsRoot();
        pathRel = `packages/${basename}`;
        pathAbs = `${pathWs}/${pathRel}`;
      }

      log4(`:get:path->match`);
      log4(`:get:path->${pathAbs}`);

      const jsonF = await fs.getPkgJsonFileC(pathAbs);
      const { text, json } = jsonF;

      // const cl: Pkg["cl"] = {};
      const clDeps: Pkg["clDeps"] = {};
      const clDDeps: Pkg["clDDeps"] = {};
      const clBld: Pkg["clBld"] = {};
      const clImp: Pkg["clImp"] = {};

      const recurse = (
        deps: Dict<string> = {},
        type: "dependencies" | "devDependencies"
      ) => {
        const depEntries = O.entries(deps ?? {});

        // check for typos
        const [typoDepName] =
          depEntries.find(([, v]) => v === "workspaces:*") ?? [];
        if (typoDepName) {
          jsonF.json[type][typoDepName] = "workspace:*";
          jsonF.save().then(() => {
            const msg =
              `${basename}:${typoDepName.match(/\/.*/)}=workspaces:* ` +
              `has typo: should be workspace:*. We fixed but you need to re-run.`;
            throw stepErr(Error(msg), "findCrosslinks", { pathOrbasename });
          });
        }

        // get crosslink pkgs
        return depEntries
          .filter(([, v]) => v === "workspace:*")
          .map(async ([depName]) => {
            const depBasename = depName.split("/")[1];
            const cl = await Pkg.getPkgC(depBasename).catch((e) => {
              throw stepErr(e, "findCrosslinks", {
                parent: basename,
                depBasename,
              });
            });

            clBld[depBasename] = cl;
            Object.assign(clBld, cl.clBld);

            if (type === "dependencies") {
              clDeps[depBasename] = cl;
              clImp[depBasename] = cl;
              Object.assign(clImp, cl.clImp);
            } else {
              clDDeps[depBasename] = cl;
            }
          });
      };

      await P.all([
        ...recurse(json.dependencies, "dependencies"),
        ...recurse(json.devDependencies, "devDependencies"),
      ]);

      const bazF = await fs.get(`${pathAbs}/BUILD.bazel`);
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
      const bazMissing = O.keys(clImp).filter(
        (name) => !bazDeps.includes(name)
      );
      const bazExtras = bazDeps.filter((name) => !O.keys(clImp).includes(name));
      const bazDirty = [
        ...bazExtras.map((b) => `-${b}`),
        ...bazMissing.map((b) => `+${b}`),
      ];
      const baz: Pkg["baz"] = {
        text: bazTxt,
        depsStartsAt: bazDepsStartsAt,
        depsEndsAt: bazDepsEndsAt,
        deps: bazDeps,
        dirty: bazDirty,
      };

      const pkg = new Pkg({
        basename,
        baz,
        clDeps,
        clDDeps,
        clImp,
        clBld,
        json,
        jsonF,
        pathAbs,
        pathRel,
        pathWs,
        text,
      });

      log3(`:get->done for ${basename}`);
      return pkg;
    } catch (e: any) {
      throw stepErr(e, "getPkg", { pathOrbasename });
    }
    // end getPkg
  };
  static getPkgC = cachify(Pkg.getPkg);

  // end Pkg
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // @ts-expect-error - gets confused args
  await main(...process.argv.slice(2));
}
