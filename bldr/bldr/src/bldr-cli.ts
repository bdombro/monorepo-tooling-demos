#!/usr/bin/env bun
/**
 * bldr-cli - A monorepo cli tool that bootstraps and builds JS applications in a monorepo, with
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
import { cachify, fs, Log, logDefault, P, sh, stepErr, Time, UTIL_ENV, A, strCompare, throttle } from "./util.js";
import { Pkg, Bldr } from "./bldr-lib.js";
import bldrPkgJson from "../package.json";

const __filename = fs.fileURLToPath(import.meta.url);
// const __dirname = fs.dirname(__filename);
const isCalledFromCli = import.meta.url === `file://${process.argv[1]}`;

const log = new Log({ prefix: "BLDR" });
// const l0 = log.l0;
const l1 = log.l1;
const l2 = log.l2;
const l3 = log.l3;
const l4 = log.l4;
// const l5 = log.l5;
// const l9 = log.l9;

export const bldr_ENV = {
  logLevel: Number(process.env["LOG"] ?? 1),
  ci: process.env["CI"] === "1" ? true : false,
};

export class Main {
  usage(exitCode = 0): never {
    console.log(
      `
  bldr-cli - A monorepo cli tool that bootstraps and builds JS applications in a monorepo

  Version: ${bldrPkgJson.version}

  Usage:
    pkg [opts] <action> [...action args]
    ...after install, or use \`bun ${__filename}\` the first time to install

    Args are usually package names or paths, and can be regex

  Env:
  LOG=n: sets log level, 1-4 (default 1)

  Actions:
  bootstrap:
    - installs a package's dependencies, with special handling for cross-linked packages
      so that they as if they were installed from npm
  build: bootstrap + build + pack
  sync: rsyncs the builds of all cross-linked packages with 
  watch: sync with watch mode
  `.replace(/^ {2}/gm, ""),
    );
    process.exit(exitCode);
  }

  action!: string;
  allArgs = process.argv.slice(2);

  args = arg({
    // Generic flags
    "--ci": String,
    "--help": Boolean,
    /** skips cache for build/bootstrap */
    "--no-cache": Boolean,
    "--show-loglevels": Boolean,
    "--show-timestamps": Boolean,
    "--loglevel": Number,
    "--verbose": arg.COUNT, // Counts the number of times --verbose is passed
    "--version": Boolean,

    // Shared flags
    /**
     * Usually means apply to all packages in workspace
     */
    "--all": Boolean,
    /** Exclude some packages from action, can be regex */
    "--excludes": String,
    /** will apply an action to crosslink dependencies */
    "--include-dependencies": Boolean,
    /** will apply an action to crosslink dependents */
    "--include-dependents": Boolean,
    /** concurrancy in actions, like exec */
    "--concurrancy": Number,

    // Flags for clean
    // "--excludes" // already defined above
    /** Whether to clean the build artifacts */
    "--builds": Boolean,
    /** Whether to clean the build local cache */
    "--buildCache": Boolean,
    /** ws + yarn */
    "--hard": Boolean,
    /** clean pkg metastores where we store stats and misc info about packages */
    "--metaStore": Boolean,
    /** Whether to rimraf the entire node_modules folders */
    "--nodeModulesAll": Boolean,
    /** Whether to rimraf the crosslinked node_modules folders */
    "--nodeModuleCrosslinks": Boolean,
    /** Clean the workspace: bld artifacts, metastore, and nodeModuleCrosslinks */
    "--ws": Boolean,
    /** clean yarn caches: is slow fyi */
    "--yarn": Boolean,

    // Aliases
    "-h": "--help",
    "-v": "--verbose",
  });

  public run = async () => {
    // this.args._.shift(); // remove the "bldr" command
    this.action = this.args._.shift()!;

    const { allArgs, args, usage } = this;

    if (args["--help"]) usage();

    if (args["--version"]) {
      console.log(bldrPkgJson.version);
      process.exit(0);
    }

    if (!this.action) usage();

    bldr_ENV.ci = UTIL_ENV.ci = args["--ci"] && ["1", "true"].includes(args["--ci"]) ? true : bldr_ENV.ci;
    bldr_ENV.logLevel = UTIL_ENV.logLevel =
      (bldr_ENV.logLevel > 1 && bldr_ENV.logLevel) || args["--loglevel"] || (args["--verbose"] ?? 0) + 1;

    if (args["--show-timestamps"]) log.showTimestamps = logDefault.showTimestamps = true;
    if (args["--show-loglevels"]) log.showLogLevels = logDefault.showLogLevels = true;

    const start = new Date();

    let printEndTxt = true;

    l2(`:cmd ${allArgs.join(" ")} at ${bldr_ENV.ci ? "" : start.toISOString()}`);

    l4(`: ENV CI=${bldr_ENV.ci} logLevel=${bldr_ENV.logLevel}`);

    try {
      switch (this.action) {
        case "bootstrap": {
          await this.bootstrap();
          break;
        }
        case "build": {
          await this.build();
          break;
        }
        case "clean": {
          await this.clean();
          break;
        }
        case "exec": {
          await this.exec();
          break;
        }
        case "info": {
          await this.info();
          break;
        }
        case "tree": {
          await this.tree();
          break;
        }
        case "sync": {
          await this.sync();
          break;
        }
        case "watch": {
          await this.watch();
          break;
        }
        case "pkgJson-preinstall": {
          printEndTxt = false;
          await this.pkgJsonPreinstall();
          break;
        }
        case "pkgJson-postinstall": {
          printEndTxt = false;
          await this.pkgJsonPostinstall();
          break;
        }
        case "pkgJson-prebuild": {
          printEndTxt = false;
          await this.pkgJsonPrebuild();
          break;
        }
        case "pkgJson-postbuild": {
          printEndTxt = false;
          await this.pkgJsonPostbuild();
          break;
        }
        default:
          l1("Invalid action\n");
          usage(1);
      }
    } catch (err: anyOk) {
      await log.lFinish({ err });
      process.exit(1);
    }

    await log.lFinish();
    if (printEndTxt) {
      logDefault.l1(`-- done in ${Time.diff(start)} --`);
    }
  };

  get argsAfterDashdash() {
    const startArgInd = this.allArgs.findIndex((a) => a === "--") + 1;
    const after = this.allArgs.slice(startArgInd);
    return after;
  }
  get excludes() {
    return this.args["--excludes"]?.split(",");
  }

  //==============================================================================//
  //
  // Actions
  //
  //
  //==============================================================================//

  private bootstrap = async () => {
    const pkgs = await this.getPkgs({ usageOnEmpty: true });
    for (const pkg of pkgs) {
      await pkg.bootstrapMain({ noCache: this.args["--no-cache"] || false });
    }
  };

  private build = async () => {
    const pkgs = this.args["--all"] ? undefined : await this.getPkgs({ usageOnEmpty: true });
    await Bldr.build({
      noCache: this.args["--no-cache"] || false,
      pkgs,
    });
  };

  private clean = async () => {
    const { args } = this;
    await Bldr.clean({
      all: args["--hard"],
      builds: args["--builds"],
      buildCache: args["--buildCache"],
      excludes: this.excludes,
      includeDependencies: args["--include-dependencies"],
      includeDependents: args["--include-dependents"],
      includes: args["--all"] ? undefined : await this.getPkgPaths({ usageOnEmpty: true }),
      metaStore: args["--metaStore"],
      nodeModulesAll: args["--nodeModulesAll"],
      nodeModuleCrosslinks: args["--nodeModuleCrosslinks"],
      ws: args["--ws"],
      yarnCache: args["--yarn"],
    });
  };

  private exec = async () => {
    const pkgs = await this.getPkgs({
      excludeAfterDashDash: true,
      usageOnEmpty: true,
    });
    const cmd = this.argsAfterDashdash.join(" ");
    if (!cmd) {
      l1(`:ERROR: Specify command after --`);
      this.usage(1);
    }
    await Bldr.exec(pkgs, cmd, {
      maxConcurrent: this.args["--concurrancy"] ?? 1,
    });
  };

  private info = async () => {
    const pkg = await this.getPkg();
    const stats = pkg.pkgMetaFile.exists ? pkg.pkgMetaFile.json.stats : undefined;

    const metaPathNice = pkg.pkgMetaFile.path.replace(fs.home, "~");
    const bldPathNice = pkg.bldArtifactFile.path.replace(fs.home, "~");
    const attrsPath = pkg.bldArtifactFile.gattrsF.path.replace(fs.home, "~");
    const bootstrapped = fs.exists(`${pkg.pathAbs}/node_modules`);
    const isFresh = await pkg.bldArtifactIsUpToDate();
    const buildTimes = stats?.buildTimes?.map((t) => Time.diff(0, t)).join(", ") || "n/a";
    const buildSizes = stats?.buildSizes?.map((s) => `${+(s / 1024).toFixed(1)}kB`).join(", ") || "n/a";
    const bootstrapTimes = stats?.bootstrapTimes?.map((t) => Time.diff(0, t)).join(", ") || "n/a";
    const caches = (await pkg.bldArtifactCacheList()).map((c) => c.replace(fs.home, "~"));

    logDefault.l1([
      ``,
      `INFO ${pkg.name}`,
      ``,
      `  - path: ${pkg.pathRel}`,
      `  - metafile: ${metaPathNice}`,
      `  - tgz: ${bldPathNice}`,
      `  - attrs: ${attrsPath}`,
      `  - bootstrap times: ${bootstrapTimes}`,
      `  - bootstrapped: ${bootstrapped ? "yes" : "no"}`,
      `  - built: ${pkg.bldArtifactFile.exists ? "yes" : "no"}`,
      `  - build is fresh: ${isFresh ? "yes" : "no"}`,
      `  - build times: ${buildTimes}`,
      `  - build sizes: ${buildSizes}`,
      `  - caches: ${caches.length ? "" : "none"}`,
      ...caches.map((c) => `    ${c}`),
      ``,
    ]);
  };

  private tree = async (opts: { embedded?: boolean } = {}) => {
    const { embedded: embedded } = opts;
    const paths = this.args["--all"] ? undefined : await this.getPkgPaths({ usageOnEmpty: true });
    const tree = await Bldr.treeViz({
      includes: paths,
      embedded,
      excludes: this.excludes,
      print: false,
    });
    logDefault.l1(tree);
  };

  private sync = async () => {
    const pkg = await this.getPkg();
    await pkg.syncCrosslinks();
  };

  private watch = async () => {
    const pkg = await this.getPkg();
    await pkg.syncCrosslinks({ watch: true });
    await sh.sleep(Infinity);
  };

  private pkgJsonPreinstall = async () => {
    const pkg = await this.getPkg();
    await pkg.pkgJsonPreinstall({
      noCache: this.args["--no-cache"] || false,
    });
  };

  private pkgJsonPostinstall = async () => {
    const pkg = await this.getPkg();
    await pkg.pkgJsonPostinstall();
  };

  private pkgJsonPrebuild = async () => {
    const pkg = await this.getPkg();
    await pkg.pkgJsonPrebuild({
      noCache: this.args["--no-cache"] || false,
    });
  };

  private pkgJsonPostbuild = async () => {
    const pkg = await this.getPkg();
    await pkg.pkgJsonPostbuild();
  };

  //==============================================================================//
  //
  // Utils
  //
  //
  //==============================================================================//

  private getPkg = async (): Promise<Pkg> => {
    const path = (await this.getPkgPaths())?.[0];
    if (!path) {
      logDefault.l1(`ERROR: No package specified`);
      this.usage();
    }
    const pkg = await Bldr.get(path);
    return pkg;
  };

  private getPkgs = async <T extends boolean>(
    opts: { excludeAfterDashDash?: boolean; usageOnEmpty?: T } = {},
  ): Promise<T extends true ? [Pkg, ...Pkg[]] : Pkg[]> => {
    const { excludeAfterDashDash, usageOnEmpty } = opts;
    const paths = await this.getPkgPaths({
      excludeAfterDashDash,
      usageOnEmpty,
    });
    if (!paths?.length) return [] as anyOk;
    const pkgs = await Bldr.find({ includes: paths as [string] });
    return pkgs as anyOk;
  };

  private getPkgPaths = cachify(
    async (opts: { excludeAfterDashDash?: boolean; usageOnEmpty?: boolean } = {}): Promise<[string, ...string[]]> => {
      try {
        const { excludeAfterDashDash, usageOnEmpty } = opts;
        const inclDependencies = this.args["--include-dependencies"];
        const inclDependents = this.args["--include-dependents"];

        const pkgPathsAll = await Bldr.findPkgPaths();
        if (this.args["--all"]) return pkgPathsAll as anyOk;

        let argArr = this.args._;

        if (excludeAfterDashDash) {
          argArr = argArr.filter((a) => !this.argsAfterDashdash.includes(a));
        }

        const paths: string[] = [];

        // process each arg and add to paths array
        for (const arg of argArr) {
          let path = arg;

          // handle . and ./
          if ([".", "./"].includes(path)) path = fs.basename(process.cwd());

          // handle regex
          if (path.startsWith("/") && path.endsWith("/")) {
            const regex = new RegExp(path.slice(1, -1));
            const matches = pkgPathsAll.filter((p) => p.match(regex));
            if (!matches.length) {
              logDefault.l1(`ERROR: No packages found for ${arg}`);
              process.exit(1);
            }
            paths.push(...matches);
            continue;
          }

          // handle if path ends with /, like packages/{pkg}/
          if (path.endsWith("/")) path = path.slice(0, -1);

          // handle globs
          if (path.includes("*")) {
            path = path.replace(/\*/g, ".*");
            const matches = pkgPathsAll.filter((p) => p.match(arg));
            if (!matches.length) {
              logDefault.l1(`ERROR: No packages found for ${arg}`);
              process.exit(1);
            }
            paths.push(...matches);
            continue;
          }

          // finally, convert to abs path
          path = pkgPathsAll.find((p) => p.endsWith(path)) as string;

          // disallow if no package found
          if (!path) {
            logDefault.l1(`ERROR: No package found for ${arg}`);
            process.exit(1);
          }
          paths.push(path);
        }

        A.filter(paths, Boolean);

        if (inclDependents || inclDependencies) {
          const pkgsAll = await Bldr.find({ dependents: true });

          if (inclDependencies) {
            for (const path of paths) {
              const pkg = pkgsAll.find((p) => p.pathAbs === path);
              for (const d of pkg?.dependencyClsForInstall ?? []) {
                paths.push(d.pathAbs);
              }
            }
          }

          if (inclDependents) {
            for (const path of paths) {
              const pkg = pkgsAll.find((p) => p.pathAbs === path);
              for (const d of pkg?.dependentClsFlat ?? []) {
                paths.push(d.pathAbs);
              }
            }
          }
        }

        A.dedup(paths);
        paths.sort(strCompare);

        if (!paths.length && usageOnEmpty) {
          logDefault.l1(`ERROR: No packages found for ${argArr.join(" ")}`);
          this.usage(1);
        }

        return paths as [string, ...string[]];

        // end getPkgPaths
      } catch (e) {
        throw stepErr(e, "getPkgPaths");
      }
    },
  );
}

if (isCalledFromCli) {
  await new Main().run();
}
