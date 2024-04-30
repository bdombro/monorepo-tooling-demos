#!/usr/bin/env bun
/**
 * mono-cli - A monorepo cli tool that bootstraps and builds JS applications in a monorepo, with
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
  anyOk,
  cachify,
  HashM,
  fs,
  LocalCache,
  Log,
  logDefault,
  O,
  P,
  PReturnType,
  sh,
  stepErr,
  stepErrCb,
  Time,
  UTIL_ENV,
  Yarn,
  AbstractCacheStat,
} from "./util.js";

const __filename = fs.fileURLToPath(import.meta.url);
const __dirname = fs.dirname(__filename);

const log = new Log({ prefix: "MONO:" });
const log0 = log.l0;
const log1 = log.l1;
const log2 = log.l2;
const log3 = log.l3;
const log4 = log.l4;
const log5 = log.l5;
const log9 = log.l9;

export const MONO_ENV = {
  logLevel: Number(process.env["LOG"] ?? 1),
  ci: process.env["CI"] === "1" ? true : false,
  install: cachify(async () => {
    await P.all([
      UTIL_ENV.installDeps(),
      fs
        .stat(`/usr/local/bin/mono`)
        .catch(() =>
          sh.exec(
            `chmod +x ${__filename} && ln -sf ${__filename} /usr/local/bin/mono`
          )
        ),
    ]);
  }),
};

const localCache = new LocalCache({ path: `${fs.home}/.mono/cache` });

export class Main {
  usage = `
  Usage:
    pkg [options] <action> [...action args]
    ...after install, or use \`bun ${__filename}\` the first time to install

  Env:
  LOG=n: sets log level, 1-4 (default 1)

  Actions:
  bootstrap:
    - re-installs cross-linked packages as if they were
      file dependencies
  build: bootstrap + build + pack
  sync: rsyncs the builds of all cross-linked packages with 
  watch: sync with watch mode
  `;

  allArgs = process.argv.slice(2);

  args = arg({
    "--ci": String,
    /** Flag to clean deeply, like node_modules folders */
    "--hard": Boolean,
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

  run = async () => {
    this.args._.shift(); // remove the "mono" command
    const action = this.args._.shift();

    const { allArgs, args, pkgPathOrNames, pkgPathOrNameOrUsage, usage } = this;

    if (args["--help"]) return console.log(usage);

    if (!action) return console.log(usage);

    MONO_ENV.ci = UTIL_ENV.ci =
      args["--ci"] && ["1", "true"].includes(args["--ci"]) ? true : MONO_ENV.ci;
    MONO_ENV.logLevel = UTIL_ENV.logLevel =
      (MONO_ENV.logLevel > 1 && MONO_ENV.logLevel) ||
      args["--loglevel"] ||
      (args["--verbose"] ?? 0) + 1;

    if (args["--show-timestamps"])
      log.showTimestamps = logDefault.showTimestamps = true;
    if (args["--show-loglevels"])
      log.showLogLevels = logDefault.showLogLevels = true;

    log3(`>${allArgs.join(" ")}`);
    log4(`>ENV CI=${MONO_ENV.ci} logLevel=${MONO_ENV.logLevel}`);

    try {
      switch (action) {
        case "bootstrap": {
          const pkg = await Pkg.getPkg(pkgPathOrNameOrUsage());
          await pkg.bootstrap({
            noCache: args["--no-cache"],
          });
          break;
        }
        case "build": {
          for (const pkgPathOrName of pkgPathOrNames) {
            const pkg = await this.getPkg(pkgPathOrName);
            await pkg.build({
              noCache: args["--no-cache"],
            });
          }
          break;
        }
        case "build-all": {
          await Mono.buildAllPkgs({ noCache: args["--no-cache"] });
          break;
        }
        case "cache-purge": {
          await Pkg.cachePurge(pkgPathOrNames);
          break;
        }
        case "clean": {
          await Mono.clean({
            rmAllNodeModules: args["--hard"],
          });
          break;
        }
        case "install": {
          await MONO_ENV.install();
          break;
        }
        case "sync": {
          const pkg = await this.getPkg(pkgPathOrNameOrUsage());
          await pkg.syncCrosslinks();
          break;
        }
        case "watch": {
          const pkg = await this.getPkg(pkgPathOrNameOrUsage());
          await pkg.syncCrosslinks({ watch: true });
          await sh.sleep(Infinity);
          break;
        }
        default:
          return console.log(usage);
      }
    } catch (e: anyOk) {
      await log.lFinish(e);
      process.exit(1);
    }

    await log.lFinish();
  };

  getPkg = async (pkgPathOrName: string) => {
    return Pkg.getPkg(pkgPathOrName).catch((e) => {
      if (e.getPath?.endsWith("package.json")) {
        log1(`ERROR: No package found for ${pkgPathOrName}`);
        process.exit(1);
      }
      throw e;
    });
  };

  pkgPathOrNameOrUsage = () => {
    if (!this.pkgPathOrName) {
      console.log(this.usage);
      process.exit(1);
    }
    return this.pkgPathOrName;
  };

  get pkgPathOrName() {
    return this.pkgPathOrNames?.[0];
  }

  get pkgPathOrNames(): string[] {
    if (this.pkgPathOrNamesLast) return this.pkgPathOrNamesLast;
    const argArr = this.args._;
    for (const i in argArr) {
      if ([".", "./"].includes(argArr[i]))
        argArr[i] = fs.basename(process.cwd());
      if (argArr[i].endsWith("/")) argArr[i] = argArr[i].slice(0, -1);
    }
    return (this.pkgPathOrNamesLast = argArr);
  }
  pkgPathOrNamesLast: null | string[] = null;
}

export class Mono {
  static buildAllPkgs = async (
    options: {
      noCache?: boolean;
    } = {}
  ) => {
    log1("buildAllPkgs->start");
    const start = Date.now();
    const { noCache } = options;
    const pkgs = await Mono.getPkgs();
    for (const p of pkgs) {
      log4(`buildAllPkgs:${p.basename}->start`);
      await p.build({ noCache });
    }
    log1(`buildAllPkgs->end ${Time.diff(start)}`);
  };

  static clean = async (
    options: {
      rmAllNodeModules?: boolean;
    } = {}
  ) => {
    try {
      const { rmAllNodeModules } = options;
      const pkgs = await Mono.getPkgs();
      log1(`clean->start ${pkgs.length} packages`);
      await Pkg.cachePurge();
      for (const p of pkgs) {
        log1(`clean:${p.basename}->start`);
        await p.clean({ rmAllNodeModules });
      }
      log1(`clean->done`);
    } catch (e) {
      throw stepErr(e, "mono.clean");
    }
  };

  static getPkgPaths = cachify(async () => {
    const wsRoot = await fs.findNearestWsRoot();
    const pkgDir = `${wsRoot}/packages`;
    const names = await fs.lsC(`${pkgDir}`);
    if (!names?.length)
      throw stepErr(
        Error('No packages found in "packages" directory'),
        "getPkgNames",
        { pkgDir }
      );
    return names as string[];
  });

  static getPkgs = cachify(async () => {
    const pkgBasenames = await Mono.getPkgPaths();
    const pkgs = await P.all(pkgBasenames.map((n) => Pkg.getPkg(n)));
    return pkgs;
  });
}

/**
 * Using a base classes makes a bit more organized, DRY and we can use the type
 * in Pkg without circular refs
 */
export class PkgBase {
  constructor(
    public jsonF: PReturnType<typeof fs.getPkgJsonFile>,
    public pathAbs: string,
    public pathRel: string,
    public pathWs: string
  ) {}
}
export class PkgWLogs extends PkgBase {
  public log!: Log;
  public l0!: Log["l0"];
  public l1!: Log["l1"];
  public l2!: Log["l2"];
  public l3!: Log["l3"];
  public l4!: Log["l4"];
  public l5!: Log["l5"];
  public l9!: Log["l9"];

  constructor(...args: ConstructorParameters<typeof PkgBase>) {
    super(...args);
    this.log = new Log({ prefix: `PKG:${fs.basename(this.pathAbs)}` });
    O.ass(this, this.log);
  }
}
export class PkgWGetSets extends PkgWLogs {
  get basename() {
    return fs.basename(this.pathAbs);
  }
  get domain() {
    return this.json.name.split("/")[0];
  }
  get json() {
    return this.jsonF.json;
  }
  set json(json: PReturnType<typeof fs.getPkgJsonFile>["json"]) {
    this.jsonF.json = json;
  }
  get nameEscaped() {
    return this.jsonF.json.name.replace(/\//g, "-");
  }
  get text() {
    return this.jsonF.text;
  }
  set text(text: PReturnType<typeof fs.getPkgJsonFile>["text"]) {
    this.jsonF.text = text;
  }
}

export class Pkg extends PkgWGetSets {
  /** Track if the last build found a change and therefor rebuild and dependents need to rebuild. */
  public changed = false;

  // these are built by this.buildTree
  /** crosslink pkgs which are in pkgJson.dependencies */
  public clDeps: HashM<Pkg> = {};
  /** crosslink pkgs which are in pkgJson.devDependenciences */
  public clDDeps: HashM<Pkg> = {};
  /** crosslink pkgs which are in pkgJson.dependencies, recursively and flattened */
  public clDepsFlat: HashM<Pkg> = {};
  /** clDepsFlat + clDDeps. Are the pkgs needed to be installed in this pkg's node_modules.  */
  public clDepsForBuild: HashM<Pkg> = {};

  bootstrap = async (
    options: { fromBuild?: boolean; noCache?: boolean } = {}
  ) => {
    try {
      const { noCache } = options;
      await this.buildDeps({ noCache });
      this.l3(`:bootstrap`);
      const start = Date.now();
      await MONO_ENV.install();
      await this.yarnPreinstall({ noCache });
      await this.yarnInstall();
      await this.resetJson();
      this.l3(`:bootstrap->end ${Time.diff(start)}`);
    } catch (e: anyOk) {
      await this.resetJson();
      throw stepErr(e, "bootstrap");
    }
  };

  build = cachify(async (options: { noCache?: boolean } = {}) => {
    try {
      this.l3(`:build->start`);
      const start = Date.now();
      const { noCache } = options;

      await this.buildDeps({ noCache });

      // FIXME: We are re-build if any of the deps changed, but we could be smarter
      // and compare csums of changed deps with the cache for this package. Could
      // possible skip a rebuild if a dep changed to a prior cached state.
      if (!noCache) {
        try {
          const cacheGetRes = await this.cacheGet();
          if (cacheGetRes.noop) {
            this.l2(`:build->getCache no-op`);
            return;
          } else {
            this.l2(`:build->getCache hit`);
            return true;
          }
        } catch (e) {}
      }

      await this.bootstrap();
      await this.yarnPrebuild();
      await this.yarnBuild();
      await this.yarnPrepack();
      await this.yarnPack();
      await this.yarnPostpack();

      await this.cacheAdd();

      this.l3(`:build->end ${Time.diff(start)}`);
    } catch (e: anyOk) {
      throw stepErr(e, "build");
    }
  });

  buildDeps = async (options: { noCache?: boolean } = {}) => {
    try {
      this.l4(`->buildDeps`);
      const { noCache } = options;
      const changed = await P.all(
        O.vals(this.clDepsForBuild).map(async (cl) => {
          await cl.build({ noCache });
          return cl.changed;
        })
      );
      return changed.includes(true);
    } catch (e) {
      throw stepErr(e, "buildDeps", { parent: this.basename });
    }
  };

  /** Builds the dep tree fields of the pkg */
  buildTree = async () => {
    try {
      this.l4(`->buildTree`);
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

          if (this.json.dependencies && clName in this.json.dependencies) {
            this.clDeps[clName] = cl;
            this.clDepsFlat[clName] = cl;
            O.ass(this.clDepsFlat, cl.clDepsFlat);
          } else {
            this.clDDeps[clName] = cl;
          }
        })
      );
      O.ass(this.clDepsForBuild, this.clDepsFlat, this.clDDeps);
    } catch (e: anyOk) {
      throw stepErr(e, "buildTree", { pkg: this.basename });
    }
  };

  /**
   * Our cache strategy is to key on the checksum of the src files
   * that go in the package.tgz, so that we can check for cache hits
   * without actually having a build yet.
   */

  /** adds this pkg's build artifact (package.tgz) to the caches (just local atm) */
  cacheAdd = async () => {
    try {
      this.l1(`->cacheAdd`);
      const srcCsum = await this.cacheChecksum();
      const bldArtifactPath = `${this.pathAbs}/package.tgz`;

      const depArtifactCsums = O.fromEnts(
        await P.all(
          O.vals(this.clDepsForBuild).flatMap((cl) =>
            cl.cacheChecksum().then((cs) => [cl.json.name, cs])
          )
        )
      );

      // Attrs to be saved on the cache record and bldArtifact
      const attrs = { [this.json.name]: srcCsum, ...depArtifactCsums };

      // Save the attrs to the file so we can optimize later get
      await fs.setXattrs(bldArtifactPath, attrs);

      const cacheKey = `${this.nameEscaped}-${srcCsum}.tgz`;

      // stat before get to check if copy/download be skipped, bc we can skip if
      // the cache already has the package.tgz
      let stat = await localCache
        .stat(cacheKey, { attrs: true })
        .catch(() => {});

      if (stat) {
        this.l1(`:cacheAdd->skip cache bc cache already has it`);
      } else {
        const bin = await fs.getBin(bldArtifactPath);
        stat = await localCache.add(cacheKey, bin.buffer, { attrs });
      }

      this.l4(`:cacheAdd->end`);
      return stat;

      // end cacheAdd main
    } catch (e) {
      throw stepErr(e, "addToCache");
    }
  };
  /** Makes an md5 checksum of the source files of a javascript package  */
  cacheChecksum = cachify(async () => {
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
              "tsconfig.json",
              "yarn.lock",
            ].join("|") +
            ")"
        ),
      ];

      // Also consider changes to deps
      const depArtifactCsums = await P.all(
        O.vals(this.clDepsForBuild).map((cl) => cl.cacheChecksum())
      );

      const srcCsum = await fs.md5(this.pathAbs, {
        excludes,
        salts: depArtifactCsums,
      });

      this.l5(`->cacheChecksum: ${srcCsum}`);
      return srcCsum;
    } catch (e) {
      throw stepErr(e, "checksum");
    }
  });

  /**
   * Gets this's build artifact from the cache if exists. return null if not.
   *
   * Returns the result.
   */
  cacheGet = async (): Promise<{ noop: Boolean }> => {
    try {
      this.l5(`->cacheGet`);
      const srcCsum = await this.cacheChecksum();
      const key = `${this.nameEscaped}-${srcCsum}.tgz`;
      const bldArtifactPath = `${this.pathAbs}/package.tgz`;

      // stat bldArtifact to check if the srcCsum matches. If it does, we can skip
      // the cacheGet bc we already have the package.tgz in our src tree
      const bldArtifactStat = await fs
        .stat(bldArtifactPath, { xattrs: true })
        .catch(() => {});

      if (bldArtifactStat) {
        if (bldArtifactStat.xattrs?.[this.json.name] === srcCsum) {
          this.l2(
            `:cacheGet->skip cache get bc srcCsum matches the package.tgz already in our src tree`
          );
          return { noop: true };
        }
        // figure out what changed
        const delta: string[] = [];
        await P.all(
          O.vals(this.clDepsForBuild).map(async (cl) => {
            const clCsum = await cl.cacheChecksum();
            if (bldArtifactStat.xattrs?.[cl.json.name] !== clCsum) {
              delta.push(cl.json.name);
            }
          })
        );
        if (delta.length) {
          this.l1(`:cacheGet->change detected in: [${delta.join(", ")}]`);
        }
      }

      // looks like we haven't the bld artifact in workspace, so get it if it's in the cache
      const cached = await localCache.get(key).catch(() => {});
      if (!cached) {
      }
      await fs.setBin(bldArtifactPath, cached.buffer, {
        xattrs: cached.attrs,
      });
      this.l2(`:cacheGet->hit`);

      return { noop: false };

      // end cacheGet main
    } catch (e) {
      throw stepErr(e, "getFromCache");
    }
  };
  static cachePurge = async (pkgNameEscapeds?: string[]) => {
    try {
      const includes = pkgNameEscapeds
        ? [new RegExp(`(${pkgNameEscapeds.join("|")})`)]
        : [];
      await localCache.purge({ includes });
    } catch (e) {
      throw stepErr(e, "cachePurge");
    }
  };

  clean = async (options: { rmAllNodeModules?: boolean } = {}) => {
    try {
      const { rmAllNodeModules = false } = options;
      const nmRmPromises = rmAllNodeModules
        ? [fs.rm(`${this.pathAbs}/node_modules`).catch(() => {})]
        : O.vals(this.clDepsForBuild).map((cl) =>
            fs.purgeDir(`${this.pathAbs}/node_modules/${cl.json.name}`)
          );
      await P.all([
        ...nmRmPromises,
        fs.rm(`${this.pathAbs}/build`).catch(() => {}),
        fs.rm(`${this.pathAbs}/dist`).catch(() => {}),
        fs.rm(`${this.pathAbs}/package.json.bak`).catch(() => {}),
        fs.rm(`${this.pathAbs}/package.tgz`).catch(() => {}),
        Pkg.cachePurge([this.nameEscaped]),
        Yarn.cachePurge([this.json.name]),
      ]);
    } catch (e) {
      throw stepErr(e, "pkg.clean");
    }
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
    } catch (e: anyOk) {
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

      // 1. remove cls from yarn.lock so yarn fresh installs
      // FIXME: using fs would be faster than sh.exec
      await sh.exec(
        '[ -f yarn.lock ] && sed -i "" -n "/@..\\//,/^$/!p" yarn.lock',
        { wd: this.pathAbs }
      );

      // 2. upsert cls (incl nested) as ../[pkg]/package.tgz to package.json

      // swap out the workspace:* (aka cls) with relative paths and add nested
      const pjs = this.json;
      O.vals(this.clDepsForBuild).forEach((cl) => {
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
    } catch (e: anyOk) {
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
          .filter(([, v]) => v.startsWith("../") || v === "workspace:*")
          .forEach(([d]) => delete deps[d]);
      rm(pjs.dependencies);
      rm(pjs.devDependencies);
      rm(pjs.peerDependencies);
      await this.jsonF.save();
    } catch (e: anyOk) {
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
      fs.rm(`${this.pathAbs}/package.tgz`).catch(() => {}),
      fs.rm(`${this.pathAbs}/dist`).catch(() => {}),
      fs.rm(`${this.pathAbs}/build`).catch(() => {}),
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

    const pkgsToWatch = O.vals(this.clDepsForBuild);

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
            await fs.rm(`${nestedNodeModules}/.cache`).catch(() => {});
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
      for (const cl of pkgsToWatch) {
        log1(`->watching: ${cl.pathRel}`);
        await watcher.add(`${cl.pathAbs}`);
      }
      return () => watcher.close().then(() => this.l1(`->end`));
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
        pathWs = await fs.findNearestWsRoot();
        pathRel = `packages/${basename}`;
        pathAbs = `${pathWs}/${pathRel}`;
      } else if (pathOrName.includes("/")) {
        pathAbs = pathOrName;
        basename = fs.basename(pathAbs);
        pathWs = fs.dirname(fs.dirname(pathAbs));
        pathRel = fs.pathRel(pathWs, pathAbs);
      } else {
        basename = pathOrName;
        pathWs = await fs.findNearestWsRoot();
        pathRel = `packages/${basename}`;
        pathAbs = `${pathWs}/${pathRel}`;
      }

      log4(`:get:path->match`);
      log4(`:get:path->${pathAbs}`);

      const jsonF = await fs.getPkgJsonFileC(pathAbs);

      const pkg = new Pkg(jsonF, pathAbs, pathRel, pathWs);

      await pkg.buildTree();

      log3(`:get->done for ${basename}`);

      return pkg;
    } catch (e: anyOk) {
      throw stepErr(e, "getPkg", { pathOrName: pathOrName });
    }
    // end getPkg
  });

  // end Pkg
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await new Main().run();
}
