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
import {
  Bazel,
  cachify,
  HashM,
  fs,
  LocalCache,
  Log,
  logDefault,
  O,
  omit,
  P,
  PkgJson,
  PReturnType,
  sh,
  stepErr,
  stepErrCb,
  str,
  str2,
  Time,
  UTIL_ENV,
  Yarn,
} from "./util.js";

const __filename = fs.fileURLToPath(import.meta.url);
const __dirname = fs.dirname(__filename);

const log = new Log({ prefix: "PKG:" });
const log0 = log.l0;
const log1 = log.l1;
const log2 = log.l2;
const log3 = log.l3;
const log4 = log.l4;
const log5 = log.l5;
const log9 = log.l9;

export const PKG_ENV = {
  logLevel: Number(process.env["LOG"] ?? 1),
  ci: process.env["CI"] === "1" ? true : false,
  install: cachify(async () => {
    await P.all([
      UTIL_ENV.installDeps(),
      import("./monorepo-cli.js").then((m) => m.MONO_ENV.install()),
      fs
        .stat(`/usr/local/bin/pkg`)
        .catch(() =>
          sh.exec(
            `chmod +x ${__filename} && ln -sf ${__filename} /usr/local/bin/pkg`
          )
        ),
    ]);
  }),
};

const localCache = new LocalCache({ path: `${fs.home}/.mono/cache` });

export const main = async () => {
  const usage = `
  Usage:
    pkg [options] <action> [...action args]
    ...after install, or use \`bun ${__filename}\` the first time to install

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

  const allArgs = process.argv.slice(2);

  const args = arg({
    "--ci": String,
    "--help": Boolean,
    /** skips cache for build/bootstrap */
    "--no-cache": Boolean,
    "--show-loglevels": Boolean,
    "--show-timestamps": Boolean,
    "--loglevel": Number,
    "--verbose": arg.COUNT, // Counts the number of times --verbose is passed

    // Aliases
    "-h": "--help",
    "-v": "--verbose",
  });

  if (args._?.[0] === "pkg") {
    args._.shift()!;
    allArgs.shift();
  }

  let action = args._?.[0];
  if (!action) return console.log(usage);

  if (args["--help"]) return console.log(usage);

  PKG_ENV.ci = UTIL_ENV.ci =
    args["--ci"] && ["1", "true"].includes(args["--ci"]) ? true : PKG_ENV.ci;
  PKG_ENV.logLevel = UTIL_ENV.logLevel =
    (PKG_ENV.logLevel > 1 && PKG_ENV.logLevel) ||
    args["--loglevel"] ||
    (args["--verbose"] ?? 0) + 1;

  if (args["--show-timestamps"])
    log.showTimestamps = logDefault.showTimestamps = true;
  if (args["--show-loglevels"])
    log.showLogLevels = logDefault.showLogLevels = true;

  const getPkgPathOrName = (): string => {
    /** We don't support multple pkgs  */
    let pkgpathOrName = args._?.[1];
    if (!pkgpathOrName) {
      console.log(usage);
      return "";
    }
    if ([".", "./"].includes(pkgpathOrName))
      pkgpathOrName = fs.basename(process.cwd());
    if (pkgpathOrName.endsWith("/")) pkgpathOrName = pkgpathOrName.slice(0, -1);
    return pkgpathOrName;
  };

  log1(`>${allArgs.join(" ")}`);
  log4(`>ENV CI=${PKG_ENV.ci} logLevel=${PKG_ENV.logLevel}`);

  try {
    switch (action) {
      case "bootstrap": {
        const pkgpathOrName = getPkgPathOrName();
        const pkg = await Pkg.getPkg(pkgpathOrName);
        await pkg.bootstrap({
          noCache: args["--no-cache"],
        });
        break;
      }
      case "build": {
        const pkgpathOrName = getPkgPathOrName();
        const pkg = await Pkg.getPkg(pkgpathOrName);
        await pkg.build({
          noCache: args["--no-cache"],
        });
        break;
      }
      case "cache-purge": {
        await Pkg.cachePurge();
        break;
      }
      case "install": {
        await PKG_ENV.install();
        break;
      }
      case "sync": {
        const pkgpathOrName = getPkgPathOrName();
        const pkg = await Pkg.getPkg(pkgpathOrName);
        await pkg.syncCrosslinks();
        break;
      }
      case "watch": {
        const pkgpathOrName = getPkgPathOrName();
        const pkg = await Pkg.getPkg(pkgpathOrName);
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
};

export class Mono {}

/** Using a base class to make more DRY and type-safe */
export class PkgBase {
  public jsonF!: PReturnType<typeof fs.getPkgJsonFile>;
  public pathAbs!: string;
  public pathRel!: string;
  public pathWs!: string;
}
export class Pkg extends PkgBase {
  public basename!: string;
  public clDeps!: HashM<Pkg>;
  public domain!: string;
  public nameEscaped!: string;

  get json() {
    return this.jsonF.json;
  }
  set json(json: PReturnType<typeof fs.getPkgJsonFile>["json"]) {
    this.jsonF.json = json;
  }
  get text() {
    return this.jsonF.text;
  }
  set text(text: PReturnType<typeof fs.getPkgJsonFile>["text"]) {
    this.jsonF.text = text;
  }

  /**
   * We use pkgObj:any bc we only instantiate using getPkg and it saves a lot of dup code.
   * We keep it typesafe by using InstanceType<typeof Pkg> in getPkg.
   */
  constructor(pkgBase: InstanceType<typeof PkgBase>) {
    super();
    O.ass(this, pkgBase);
    this.basename = this.json.name.split("/")[1];
    this.domain = this.json.name.split("/")[0];
    this.nameEscaped = this.json.name.replace("/", "-");

    this.log = new Log({ prefix: `PKG:${this.basename.toUpperCase()}` });
    O.ass(this, this.log);
  }

  bootstrap = async (
    options: { fromBuild?: boolean; noCache?: boolean } = {}
  ) => {
    try {
      const { fromBuild, noCache } = options;
      const log = fromBuild ? this.l4 : this.l1;
      log(`:bootstrap`);
      const start = Date.now();
      await PKG_ENV.install();
      await this.yarnPreinstall({ noCache });
      await this.yarnInstall();
      await this.resetJson();
      log(`:bootstrap->end ${Time.diff(start)}`);
    } catch (e: any) {
      await this.resetJson();
      throw stepErr(e, "bootstrap");
    }
  };

  build = cachify(async (options: { noCache?: boolean } = {}) => {
    try {
      this.l1(`:build->start`);
      const start = Date.now();
      const { noCache = false } = options;
      const cachedStat = noCache ? null : await this.cacheGet();
      if (cachedStat) return;
      this.l1(`:build->end ${Time.diff(start)}`);
    } catch (e: any) {
      throw stepErr(e, "build");
    }
  });

  buildDeps = async (options: { noCache?: boolean } = {}) => {
    try {
      this.l1(`->buildDeps`);
      const { noCache = false } = options;
      await P.all(
        O.vals(this.clDeps).map(async (cl) => {
          await cl.build({ noCache });
        })
      );
    } catch (e) {
      throw stepErr(e, "buildDeps", {
        parent: this.basename,
      });
    }
  };

  /** Builds the dep tree fields of the pkg */
  buildTree = async () => {
    try {
      this.l4(`->buildTree`);
      this.clDeps = {};
      await P.all(
        O.ents({
          ...this.json.dependencies,
          ...this.json.devDependencies,
        }).map(async ([clName, clVersion]) => {
          if (clVersion !== "workspace:*") return;
          const cl = await Pkg.getPkg(clName).catch((e) => {
            throw stepErr(e, "getPkg->failed", {
              parent: this.basename,
              depName: clName,
            });
          });
          this.clDeps[clName] = cl;
          O.ass(this.clDeps, cl.clDeps);
        })
      );
    } catch (e: any) {
      throw stepErr(e, "buildTree", { pkg: this.basename });
    }
  };

  /**
   * Our cache strategy is to key on the checksum of the src files
   * that go in the package.tgz, so that we can check for cache hits
   * without actually having a build yet.
   */
  cacheAdd = async () => {
    try {
      this.l2(`->cacheAdd`);
      const csum = await this.cacheChecksum();
      const key = `${this.nameEscaped}-${csum}.tgz`;
      await localCache.add(key, `${this.pathAbs}/package.tgz`);
      this.l4(`:cacheAdd->end`);
    } catch (e) {
      throw stepErr(e, "addToCache");
    }
  };
  cacheChecksum = async () => {
    try {
      this.l5(`->cacheChecksum`);
      // FIXME: determine excludes from package.json and .npmignore
      const excludes = [
        /^\.[a-zA-Z]/, // paths starting with a dot ie (.b)ar
        /\/\./, // paths with a dot path in the middle ie /foo(/.)bar
        RegExp(
          "(" +
            [
              "dist",
              "build",
              "node_modules",
              "package.tgz",
              "public",
              "yarn.lock",
            ].join("|") +
            ")"
        ),
      ];
      const csum = await fs.md5(this.pathAbs, { excludes });
      if (this.cacheChecksumLast && this.cacheChecksumLast !== csum) {
        throw stepErr(
          Error(
            "Checksum changed since before build -- something isn't right. Maybe\n" +
              "try again and if still happening maybe you included a build artifact\n" +
              "in your checksum."
          ),
          "checksum"
        );
      }
      this.l5(`->cacheChecksum: ${csum}`);
      return csum;
    } catch (e) {
      throw stepErr(e, "checksum");
    }
  };
  cacheChecksumLast = "";
  cacheGet = async () => {
    try {
      this.l5(`->cacheGet`);
      const csum = await this.cacheChecksum();
      const key = `${this.nameEscaped}-${csum}.tgz`;
      const stat = await localCache
        .get(key, `${this.pathAbs}/package.tgz`)
        .catch(() => {});
      this.l1(`:cacheGet->${stat ? "hit" : "miss"}`);
      return stat;
    } catch (e) {
      throw stepErr(e, "getFromCache");
    }
  };
  static cachePurge = async (pkgNameEscapeds: string[] = []) => {
    try {
      await localCache.purge({
        includes: [new RegExp(`(${pkgNameEscapeds.join("|")})`)],
      });
    } catch (e) {
      throw stepErr(e, "cachePurge");
    }
  };

  clean = async (options: { rmAllNodeModules?: boolean } = {}) => {
    const { rmAllNodeModules = false } = options;
    const nmRmPromises = rmAllNodeModules
      ? [fs.rm(`${this.pathAbs}/node_modules`)]
      : O.vals(this.clDeps).map((cl) =>
          fs.purgeDir(`${this.pathAbs}/node_modules/${cl.json.name}`)
        );
    await P.all([
      ...nmRmPromises,
      fs.rm(`${this.pathAbs}/build`),
      fs.rm(`${this.pathAbs}/dist`),
      fs.rm(`${this.pathAbs}/package.json.bak`),
      fs.rm(`${this.pathAbs}/package.tgz`),
      Pkg.cachePurge([this.nameEscaped]),
      Yarn.cachePurge([this.json.name]),
    ]);
  };

  resetJson = async () => {
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
    await Yarn.cachePurge([this.json.name]);
  };

  /**
   * Preps the package for install by:
   * 1. removing cls from yarn.lock
   * 2. upserting cls as ../[pkg]/package.tgz to package.json
   */
  yarnPreinstall = async (options: { noCache?: boolean } = {}) => {
    try {
      this.l4(`->yarnPreinstall`);
      const { noCache = false } = options;

      await this.buildDeps({ noCache });

      // 1. remove cls from yarn.lock so yarn fresh installs
      // FIXME: using fs would be faster than sh.exec
      await sh.exec(
        '[ -f yarn.lock ] && sed -i "" -n "/@..\\//,/^$/!p" yarn.lock',
        { wd: this.pathAbs }
      );

      // 2. upsert cls (incl nested) as ../[pkg]/package.tgz to package.json

      // swap out the workspace:* (aka cls) with relative paths and add nested
      const pjs = this.json;
      O.vals(this.clDeps).forEach((cl) => {
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
        pjs.peerDependencies = O.fromEnts(
          O.ents(pjs.peerDependencies).filter(([, v]) => v !== "workspace:*")
        );

      // commit to filesystem
      await this.jsonF.save();
      this.l4(`:yarnPreinstall->end`);
    } catch (e: any) {
      throw stepErr(e, "preinstall");
    }
  };
  yarnInstall = async () => {
    this.l1(`->yarnInstall`);
    await sh
      .exec(`yarn install --mutex file`, { wd: this.pathAbs })
      .catch(stepErrCb("install"));
    this.l3(`:yarnInstall->end`);
  };

  /** Remove all crosslinks from package.json */
  yarnPrepack = async () => {
    this.l2(`->yarnPrepack`);
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
    this.l4(`:yarnPrepack->end`);
  };
  yarnPack = async () => {
    this.l2(`->yarnPack`);
    await sh
      .exec(`yarn pack -f package.tgz`, { wd: this.pathAbs })
      .catch(stepErrCb("pack"));
    this.l4(`:yarnPack->end`);
  };
  yarnPostpack = async () => {
    this.l4(`->yarnPostpack`);
    await P.all([this.yarnCleanCache(), this.resetJson()]).catch(
      stepErrCb("postpack")
    );
    this.l4(`:yarnPostpack->end`);
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
    this.l4(`:yarnPrebuild->end`);
  };
  yarnBuild = async () => {
    this.l1(`->yarnBuild`);
    await sh.exec(`yarn build`, { wd: this.pathAbs }).catch(stepErrCb("build"));
    this.l4(`:yarnPrebuild->end`);
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
    if (!(await fs.stat(nestedNodeModules).catch(() => {}))) {
      log3(`->no ws packages to sync`);
      return;
    }

    const excludes = ["node_modules", "package.tgz", "yarn.lock"];

    const pkgsToWatch = O.vals(this.clDeps);

    const doSync = async () => {
      log3(`->syncing`);
      const delta = await P.all(
        pkgsToWatch.map(async (cl) => {
          if (await fs.stat(`${cl.pathAbs}`).catch(() => {})) {
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
   * STATIC METHODS
   *
   *
   *
   */

  /**
   * Gets a Pkg instance from a pkg path, basename, or package name.
   */
  static getPkg = cachify(async (pathOrName: string) => {
    log4(`:get->${pathOrName}`);
    try {
      // pathOrName = pathOrName.replace(new RegExp("(/|./|.)$", "g"), "");
      pathOrName = pathOrName
        .replace(/\.\/$/, "")
        .replace(/\.$/, "")
        .replace(/\/$/, "");

      if (!pathOrName) pathOrName = process.cwd();
      if (pathOrName.startsWith("@")) pathOrName = pathOrName.split("/")[1];

      let [basename, pathWs, pathRel, pathAbs] = Array(4).fill("");
      if (pathOrName.split("/").length === 2) {
        basename = fs.basename(pathOrName);
        pathWs = await Bazel.findNearestWsRootC();
        pathRel = `packages/${basename}`;
        pathAbs = `${pathWs}/${pathRel}`;
      } else if (pathOrName.includes("/")) {
        pathAbs = pathOrName;
        basename = fs.basename(pathAbs);
        pathWs = fs.dirname(fs.dirname(pathAbs));
        pathRel = fs.pathRel(pathWs, pathAbs);
      } else {
        basename = pathOrName;
        pathWs = await Bazel.findNearestWsRootC();
        pathRel = `packages/${basename}`;
        pathAbs = `${pathWs}/${pathRel}`;
      }

      log4(`:get:path->match`);
      log4(`:get:path->${pathAbs}`);

      const jsonF = await fs.getPkgJsonFileC(pathAbs);

      const pkg = new Pkg({
        jsonF,
        pathAbs,
        pathRel,
        pathWs,
      });

      await pkg.buildTree();

      log3(`:get->done for ${basename}`);

      return pkg;
    } catch (e: any) {
      throw stepErr(e, "getPkg", { pathOrName: pathOrName });
    }
    // end getPkg
  });

  public log!: Log;
  public l0!: Log["l0"];
  public l1!: Log["l1"];
  public l2!: Log["l2"];
  public l3!: Log["l3"];
  public l4!: Log["l4"];
  public l5!: Log["l5"];
  public l9!: Log["l9"];
  // end Pkg
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // @ts-expect-error - gets confused args
  await main(...process.argv.slice(2));
}
