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
import { fs, logDefault, sh, stepErr, Time, UTIL_ENV, A, strCompare, str, lerr } from "./util.js";
import { Pkg, Bldr } from "./bldr-lib.js";
import bldrPkgJson from "../package.json" assert { type: "json" };

const __filename = fs.fileURLToPath(import.meta.url);
const __dirname = fs.dirname(__filename);
const isCalledFromCli = import.meta.url === `file://${process.argv[1]}`;

export const BLDR_ENV = {
  logLevel: Number(process.env["LOG"] ?? 2),
  ci: process.env["CI"] === "1" ? true : false,
};

export class Main {
  usage(exitCode = 0): never {
    logDefault.l2(
      `  
  bldr-cli - A monorepo tool for managing JavaScript applications, focusing on correct handling of crosslinks 
  between packages to mimic npm installations.

  Version: ${bldrPkgJson.version}
  
  Usage:
    bldr [options] <action> [...action args]
  
  Options:
    --ci                     Run in continuous integration mode.
    --help                   Show help.
    --no-cache               Skip cache for builds or bootstrapping.
    --show-loglevels         Display log levels in output.
    --show-timestamps        Display timestamps in log output.
    --loglevel <number>      Set log level, where higher numbers show more detail.
    --verbose                Increase verbosity of output (can be specified multiple times).
    --version                Show version of the CLI tool.
    --all                    Apply actions to all packages in the workspace.
    --excludes <packages>    Exclude certain packages from actions, can be a comma-separated list or regex.
    --include-dependencies   Apply actions to crosslink dependencies.
    --include-dependents     Apply actions to crosslink dependents.
    --concurrancy <number>   Set concurrency level for actions that support parallel execution.
    --builds                 Clean build artifacts only.
    --buildCache             Clean build caches only.
    --hard                   Perform hard clean, affecting all build artifacts and caches.
    --metaStore              Clean package metadata stores.
    --nodeModulesAll         Remove all node_modules directories.
    --nodeModuleCrosslinks   Remove only crosslinked node_modules directories.
    --ws                     Clean entire workspace (build artifacts, metadata stores, and crosslinks).
    --yarn                   Clean Yarn caches.
  
  Actions:
    bootstrap                Install package dependencies with special handling for crosslinks as if installed from npm.
    build                    Perform bootstrap, then build, and finally pack the packages.
    sync                     Synchronize the builds of crosslinked packages using rsync.
    watch                    Continuously sync changes to crosslinked packages.
    clean                    Remove build artifacts, caches, and optionally clean up workspace metadata.
    exec                     Execute a specified command in the context of selected packages.
    info                     Display detailed information about a package's build and cache status.
    tree                     Visualize the dependency tree of the packages.
    buildAttributes          Display the source files and their checksums used in the last build.
    pkgJson-preinstall       Prepare the package for installation by adjusting the package.json and yarn.lock.
    pkgJson-postinstall      Reset modifications made during the preinstall step.
    pkgJson-prebuild         Prepare the package for building, including cleaning previous builds.
    pkgJson-postbuild        Finalize the build process, including integrity checks, packing, caching.
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

    const { allArgs, args } = this;

    if (args["--help"]) this.usage();

    if (args["--version"]) {
      console.log(bldrPkgJson.version);
      process.exit(0);
    }

    if (!this.action) this.usage();

    BLDR_ENV.ci = UTIL_ENV.ci = args["--ci"] && ["1", "true"].includes(args["--ci"]) ? true : BLDR_ENV.ci;
    BLDR_ENV.logLevel = UTIL_ENV.logLevel =
      (BLDR_ENV.logLevel > 1 && BLDR_ENV.logLevel) || args["--loglevel"] || (args["--verbose"] ?? 0) + 2;

    if (args["--show-timestamps"]) Bldr.log.showTimestamps = logDefault.showTimestamps = true;
    if (args["--show-loglevels"]) Bldr.log.showLogLevels = logDefault.showLogLevels = true;

    const start = new Date();

    let printEndTxt = true;

    Bldr.l3(`:cmd ${allArgs.join(" ")} at ${BLDR_ENV.ci ? "" : start.toISOString()}`);

    Bldr.l4(`: ENV CI=${BLDR_ENV.ci} logLevel=${BLDR_ENV.logLevel}`);

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
        case "buildAttributes": {
          printEndTxt = false;
          await this.buildAttributes();
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
          printEndTxt = false;
          await this.info();
          break;
        }
        case "tree": {
          printEndTxt = false;
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
          lerr("Invalid action");
          this.usage(1);
      }
    } catch (err: anyOk) {
      await Bldr.lFinish({ err });
      process.exit(1);
    }

    await Bldr.lFinish();
    if (printEndTxt) {
      logDefault.l2(`-- done in ${Time.diff(start)} --`);
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
    await Bldr.bootstrap({
      noCache: this.args["--no-cache"] || false,
      pkgs,
    });
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
      lerr(`ERROR: Specify command after --`);
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
    const bootstrapped = fs.existsS(`${pkg.pathAbs}/node_modules`);
    const isFresh = await pkg.bldArtifactIsUpToDate();
    const buildTimes = stats?.buildTimes?.map((t) => Time.diff(0, t)).join(", ") || "n/a";
    const buildSizes = stats?.buildSizes?.map((s) => `${+(s / 1024).toFixed(1)}kB`).join(", ") || "n/a";
    const bootstrapTimes = stats?.bootstrapTimes?.map((t) => Time.diff(0, t)).join(", ") || "n/a";
    const caches = (await pkg.bldArtifactCacheList()).map((c) => c.replace(fs.home, "~"));

    logDefault.l1(`\nINFO ${pkg.name}\n`);
    logDefault.l2([
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

  private buildAttributes = async () => {
    const pkg = await this.getPkg();
    logDefault.l1(`\nINFO:SRC-FILES ${pkg.name}\n`);
    logDefault.l2(str(await pkg.bldArtifactAttrsCreate(), 2));
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
    logDefault.l2(tree);
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
    await pkg.pkgJsonPrebuild();
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
      logDefault.lerr(`ERROR: No package specified`);
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

  private getPkgPaths = async (
    opts: { excludeAfterDashDash?: boolean; usageOnEmpty?: boolean } = {},
  ): Promise<[string, ...string[]]> => {
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
            logDefault.lerr(`ERROR: No packages found for ${arg}`);
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
            logDefault.lerr(`ERROR: No packages found for ${arg}`);
            process.exit(1);
          }
          paths.push(...matches);
          continue;
        }

        // finally, convert to abs path
        path = pkgPathsAll.find((p) => p.endsWith(path)) as string;

        // disallow if no package found
        if (!path) {
          logDefault.lerr(`ERROR: No package found for ${arg}`);
          process.exit(1);
        }
        paths.push(path);
      }

      A.filter(paths, Boolean);

      if (inclDependencies && paths.length) {
        const pkgs = await Bldr.find({ includes: paths as [string] });
        for (const pkg of pkgs) {
          for (const d of pkg?.dcClsForInstall ?? []) {
            paths.push(d.pathAbs);
          }
        }
      }

      if (inclDependents && paths.length) {
        const pkgsAll = await Bldr.find({ dependents: true });
        for (const path of paths) {
          const pkg = pkgsAll.find((p) => p.pathAbs === path);
          for (const d of pkg?.dtClsFlat ?? []) {
            paths.push(d.pathAbs);
          }
        }
      }

      A.dedup(paths);
      paths.sort(strCompare);

      if (!paths.length && usageOnEmpty) {
        logDefault.lerr(`ERROR: No packages found for ${argArr.join(" ")}`);
        this.usage(1);
      }

      return paths as [string, ...string[]];

      // end getPkgPaths
    } catch (e) {
      throw stepErr(e, "getPkgPaths");
    }
  };
}

if (isCalledFromCli) {
  new Main().run();
}
