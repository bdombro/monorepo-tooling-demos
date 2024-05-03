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
import {
  cachify,
  fs,
  Log,
  logDefault,
  P,
  sh,
  stepErr,
  Time,
  UTIL_ENV,
  anyOk,
  Is,
  A,
  strCompare,
} from "./util.js";
import { Pkg, Pkgs } from "./pkg.js";

const __filename = fs.fileURLToPath(import.meta.url);
// const __dirname = fs.dirname(__filename);
const isCalledFromCli = import.meta.url === `file://${process.argv[1]}`;

const log = new Log({ prefix: "mono" });
// const l0 = log.l0;
const l1 = log.l1;
const l2 = log.l2;
const l3 = log.l3;
const l4 = log.l4;
// const l5 = log.l5;
// const l9 = log.l9;

export const mono_ENV = {
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

export class Main {
  usage(exitCode = 0): never {
    console.log(
      `
  Usage:
    pkg [opts] <action> [...action args]
    ...after install, or use \`bun ${__filename}\` the first time to install

    Args are usually package names or paths, and can be regex

  Env:
  LOG=n: sets log level, 1-4 (default 1)

  Actions:
  bootstrap:
    - re-installs cross-linked packages as if they were
      file dependencies
  build: bootstrap + build + pack
  sync: rsyncs the builds of all cross-linked packages with 
  watch: sync with watch mode
  `.replace(/^ {2}/gm, "")
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

    // Flags for clean
    // "--excludes" // already defined above
    /** Whether to clean the build artifacts */
    "--builds": Boolean,
    /** Whether to clean the build local cache */
    "--buildCache": Boolean,
    /** ws + yarnCache */
    "--hard": Boolean,
    /** Whether to rimraf the entire node_modules folders */
    "--nodeModulesAll": Boolean,
    /** Whether to rimraf the crosslinked node_modules folders */
    "--nodeModuleCrosslinks": Boolean,
    /** Clean the workspace: bld artifacts and nodeModuleCrosslinks */
    "--ws": Boolean,
    /** clean yarn caches: is slow fyi */
    "--yarnCache": Boolean,

    // Aliases
    "-h": "--help",
    "-v": "--verbose",
  });

  run = async () => {
    // this.args._.shift(); // remove the "mono" command
    this.action = this.args._.shift()!;

    const { allArgs, args, usage } = this;

    if (args["--help"]) usage();

    if (!this.action) usage();

    mono_ENV.ci = UTIL_ENV.ci =
      args["--ci"] && ["1", "true"].includes(args["--ci"]) ? true : mono_ENV.ci;
    mono_ENV.logLevel = UTIL_ENV.logLevel =
      (mono_ENV.logLevel > 1 && mono_ENV.logLevel) ||
      args["--loglevel"] ||
      (args["--verbose"] ?? 0) + 1;

    if (args["--show-timestamps"])
      log.showTimestamps = logDefault.showTimestamps = true;
    if (args["--show-loglevels"])
      log.showLogLevels = logDefault.showLogLevels = true;

    const start = new Date();

    let printEndTxt = true;

    l2(
      `:cmd ${allArgs.join(" ")} at ${mono_ENV.ci ? "" : start.toISOString()}`
    );

    l4(`: ENV CI=${mono_ENV.ci} logLevel=${mono_ENV.logLevel}`);

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
        case "install": {
          await this.install();
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
        case "yarn-preinstall": {
          printEndTxt = false;
          await this.yarnPreinstall();
          break;
        }
        case "yarn-postinstall": {
          printEndTxt = false;
          await this.yarnPostinstall();
          break;
        }
        case "yarn-prebuild": {
          printEndTxt = false;
          await this.yarnPrebuild();
          break;
        }
        case "yarn-postbuild": {
          printEndTxt = false;
          await this.yarnPostbuild();
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

  //
  // Actions
  //
  //

  bootstrap = async () => {
    const pkgs = await this.getPkgs({ usageOnEmpty: true });
    for (const pkg of pkgs) {
      await pkg.bootstrap({ noCache: this.args["--no-cache"] || false });
    }
  };

  build = async () => {
    const pkgs = this.args["--all"]
      ? undefined
      : await this.getPkgs({ usageOnEmpty: true });
    await Pkgs.buildMany({
      noCache: this.args["--no-cache"] || false,
      pkgs,
    });
  };

  clean: any = async () => {
    const { args } = this;
    const paths = await this.getPkgPaths({ usageOnEmpty: true });
    await Pkgs.clean({
      excludes: this.excludes,
      includes: Is.arrS(paths) ? paths : undefined,
      all: args["--all"],
      builds: args["--builds"],
      buildCache: args["--buildCache"],
      nodeModulesAll: args["--nodeModulesAll"],
      nodeModuleCrosslinks: args["--nodeModuleCrosslinks"],
      ws: args["--ws"],
      yarnCache: args["--yarnCache"],
    });
  };

  exec = async () => {
    const pkgs = await this.getPkgs({
      excludeAfterDashDash: true,
      usageOnEmpty: true,
    });
    const cmd = this.argsAfterDashdash.join(" ");
    if (!cmd) {
      l1(`:ERROR: Specify command after --`);
      this.usage(1);
    }
    await P.all(
      pkgs.map((pkg) =>
        sh.exec(cmd, {
          prefix: pkg.basename,
          printOutput: true,
          wd: pkg.pathAbs,
        })
      )
    );
  };

  install = async () => {
    await mono_ENV.install();
  };

  tree = async () => {
    let paths: [string] | undefined = undefined;
    if (!this.args["--all"]) {
      paths = (await Pkgs.findPkgPaths()) as [string];
      if (!paths.length) {
        l1(`:ERROR: Specify packages or --all`);
        this.usage();
      }
    }
    await Pkgs.treeViz({
      includes: paths,
      excludes: this.excludes,
    });
    process.exit();
  };

  sync = async () => {
    const pkg = await this.getPkg();
    await pkg.syncCrosslinks();
  };

  watch = async () => {
    const pkg = await this.getPkg();
    await pkg.syncCrosslinks({ watch: true });
    await sh.sleep(Infinity);
  };

  yarnPreinstall = async () => {
    const pkg = await this.getPkg();
    await pkg.yarnPreinstall({ noCache: this.args["--no-cache"] || false });
  };

  yarnPostinstall = async () => {
    const pkg = await this.getPkg();
    await pkg.yarnPostinstall();
  };

  yarnPrebuild = async () => {
    const pkg = await this.getPkg();
    const canSkip = await pkg.buildCheckIfCanSkip(
      this.args["--no-cache"] || false
    );
    if (!canSkip) {
      await pkg.yarnPrebuild();
    }
  };

  yarnPostbuild = async () => {
    try {
      const pkg = await this.getPkg();
      await pkg.yarnPostbuild();
      await pkg.bldArtifactAttrsSet();
      await pkg.bldArtifactCacheAdd();
    } catch (e) {
      throw stepErr(e, "yarn-postbuild");
    }
  };

  //
  //
  // Utils
  //
  //

  getPkg = async (): Promise<Pkg> => {
    const path = (await this.getPkgPaths())?.[0];
    if (!path) {
      logDefault.l1(`ERROR: No package specified`);
      this.usage();
    }
    const pkg = await Pkgs.get(path);
    return pkg;
  };

  getPkgs = async <T extends boolean>(
    opts: { excludeAfterDashDash?: boolean; usageOnEmpty?: T } = {}
  ): Promise<T extends true ? [Pkg, ...Pkg[]] : Pkg[]> => {
    const { excludeAfterDashDash, usageOnEmpty } = opts;
    const paths = await this.getPkgPaths({
      excludeAfterDashDash,
      usageOnEmpty,
    });
    if (!paths?.length) return [] as anyOk;
    const pkgs = await Pkgs.find({ includes: paths as [string] });
    return pkgs as anyOk;
  };

  getPkgPaths = cachify(
    async <T extends boolean>(
      opts: { excludeAfterDashDash?: boolean; usageOnEmpty?: T } = {}
    ): Promise<T extends true ? [string, ...string[]] : string[]> => {
      try {
        const { excludeAfterDashDash, usageOnEmpty } = opts;
        const inclDependencies = this.args["--include-dependencies"];
        const inclDependents = this.args["--include-dependents"];

        const pkgPathsAll = await Pkgs.findPkgPaths();
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
          const pkgsAll = await Pkgs.find({ dependents: true });

          if (inclDependencies) {
            for (const path of paths) {
              const pkg = pkgsAll.find((p) => p.pathAbs === path);
              for (const d of pkg?.dependenciesClsForInstall ?? []) {
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
    }
  );
}

if (isCalledFromCli) {
  await new Main().run();
}