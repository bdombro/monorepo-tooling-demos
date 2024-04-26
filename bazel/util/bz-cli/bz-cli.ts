#!/usr/bin/env bun
/**
 * bz - A bazel JS monorepo cli tool that bootstraps and builds a JS application in a monorepo, with
 * careful handling of crosslinks to mimic the install behavior of published npm pkgs.
 *
 * Motivation:
 *   1. Existing monorepo tools mismanage crosslinks in a monorepo, by linking them via a basic symlink.
 *     This causes many issues, such as:
 *     1. deeply nested node_modules folders
 *     2. devDependencies of the crosslinks being installed
 *     3. dependencies being in diff places vs if installed as an npm pkg
 *     4. symlink issues todo with the way that node resolves modules
 *   2. Existing monorepo tools don't allow for each pkg to have it's own pkg manager and lock
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
 *  - This script is called from either the root of the monorepo, or from a pkg directory
 *  - The crosslinks of the pkg are already built and packed into pkg.tgz
 */
import arg from "arg";
import { dirname } from "path";
import { fileURLToPath } from "url";
import process from "process";
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
  throwErr,
  throwStepErr,
  Time,
  UTIL_ENV,
} from "./util.js";
import path from "path";
import { Pkg } from "./pkg-cli.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ENV = {
  logLevel: Number(process.env.LOG ?? 1),
  ci: process.env.CI === "1" ? true : false,
  user: process.env.USER,
};

const log = new Log({ prefix: "bz-cli:" });
const log0 = log.l0;
const log1 = log.l1;
const log2 = log.l2;
const log3 = log.l3;
const log4 = log.l4;
const log5 = log.l5;
const log9 = log.l9;

async function main() {
  const usage = `
Usage:
  bz [options] <action> [...action args]
  ...after install, or use \`bun bz-cli.ts\` the first time to install

Env:
LOG=n: sets log level, 1-4 (default 1)
TODO: what to do about domain
DOMAIN_DEFAULT=@app: sets the default domain (default @app) for
  pkg names. You may omit the domain if using the default.

Actions:
bootstrap: bootstrap a package and build it's dependencies
build: build a package and it's dependencies
clean: purge bazel+yarn caches, crosslinks in node_modules, build artifacts
clean-bz: purge bazel caches
clean-yarn-cache: purge yarn caches for packages
install: check and install env deps. Also add bz-cli to /usr/local/bin
sync: sync a package's crosslinks' to {package}/node_modules/{cl}
watch: sync + watch for changes
`;

  const args = arg({
    "--all": Boolean,
    "--ci": String,
    "--no-cache": Boolean,
    "--help": Boolean,
    "--loglevel": Number,
    "--verbose": arg.COUNT, // Counts the number of times --verbose is passed
    // the location of the workspace root (optional, will find on own)
    "--ws": String,

    // Aliases
    "-a": "--all",
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

  const action = args._?.[0];
  if (!action) return console.log(usage);

  try {
    const wsRoot = args["--ws"] || (await findNearestWsRoot());
    switch (action) {
      case "bootstrap": {
        const pkgName = args._?.[1];
        if (!pkgName) return console.log(usage);
        await build(wsRoot, pkgName, {
          skipLastBuild: true,
          noCache: args["--no-cache"],
        });
        break;
      }
      case "build": {
        /** eventually maybe support mult pkgNames */
        const pkgNames = args._.slice(1);
        if (!pkgNames?.length) return console.log(usage);
        if (pkgNames[0] === "all") {
          await buildAllPkgs(wsRoot, { noCache: args["--no-cache"] });
        } else {
          await build(wsRoot, pkgNames[0], {
            noCache: args["--no-cache"],
          });
        }
        break;
      }
      case "clean": {
        await cleanAll(wsRoot);
        break;
      }
      case "clean-bz": {
        await cleanBazelCache(wsRoot);
        break;
      }
      case "clean-yarn-cache": {
        await cleanYarnCache(wsRoot, await getPkgNamesC(wsRoot));
        break;
      }
      case "install": {
        await installEnvDepsC(wsRoot);
        break;
      }
      case "sync": {
        const pkgName = args._?.[1];
        if (!pkgName) return console.log(usage);
        const pkg = await Pkg.getPkg(`${wsRoot}/packages/${pkgName}`);
        await pkg.syncCrosslinks();
        break;
      }
      case "watch": {
        const pkgName = args._?.[1];
        if (!pkgName) return console.log(usage);
        const pkg = await Pkg.getPkg(`${wsRoot}/packages/${pkgName}`);
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

export const buildAllPkgs = async (
  wsRoot: string,
  options: {
    noCache?: boolean;
  } = {}
) => {
  log4("buildAllPkgs->start");
  const start = Date.now();
  const { noCache } = options;
  await installEnvDepsC(wsRoot);
  if (noCache) await cleanBazelCache(wsRoot);
  const pkgBasenames = await getPkgNamesC(wsRoot);
  for (const name of pkgBasenames.reverse()) {
    await build(wsRoot, name);
  }
  log4(`buildAllPkgs->end ${Time.diff(start)}`);
};

export const build = async (
  wsRoot: string,
  pkgBasename: string,
  options: {
    skipLastBuild?: boolean;
    noCache?: boolean;
  } = {}
) => {
  const { skipLastBuild, noCache } = options;
  let lctx = skipLastBuild ? "bootstrap" : "build";
  log1(`${lctx}:start->${pkgBasename}`);
  const start = Date.now();
  await installEnvDepsC(wsRoot);
  if (noCache) await cleanBazelCache(wsRoot);
  const wsRootForBzl = ENV.ci ? "" : wsRoot;
  const stdout = await sh.exec(
    `bazel build //packages/${pkgBasename}:build ` +
      `--define ci=true ` +
      `--define loglevel=${ENV.logLevel} ` +
      `--define justBootstrapPkg=${skipLastBuild ? pkgBasename : ""} ` +
      `--define wsroot=${wsRootForBzl} `,
    {
      wd: wsRoot,
      verbose: true,
    }
  );
  // stdout.split("\n").forEach((line) => {
  //   if (
  //     line.match(/\d\d:\d\d:\d\d.\d\d /) ||
  //     line.includes("pkg-cli") ||
  //     line.includes("sh.") ||
  //     line.includes("fs.")
  //   ) {
  //     log0(line);
  //   } else {
  //     log1(line);
  //   }
  // });
  await restorePkgFromCache(wsRoot, pkgBasename);
  log1(`${lctx}->end ${Time.diff(start)}`);
};

export const cleanAll = async (wsRoot: string) => {
  log4("cleanAll->start");
  const start = Date.now();
  const pkgs = await getPkgNamesC(wsRoot);
  let domains = await P.all(
    pkgs.map(
      async (name) =>
        (
          await fs.getPkgJsonFileC(`${wsRoot}/packages/${name}`)
        ).json.name.split("/")[0]
    )
  );
  domains = Array.from(new Set(domains));
  await P.all([
    cleanBazelCache(wsRoot),
    cleanYarnCache(wsRoot, await getPkgNamesC(wsRoot)),
    ...pkgs.map(async (name) => {
      const pkgPath = `${wsRoot}/packages/${name}`;
      await P.all([
        ...domains.map((domain) => fs.rm(`${pkgPath}/node_modules/${domain}`)),
        fs.rm(`${pkgPath}/build`),
        fs.rm(`${pkgPath}/dist`),
        fs.rm(`${pkgPath}/package.json.bak`),
        fs.rm(`${pkgPath}/package.tgz`),
      ]);
    }),
  ]);
  log4(`cleanAll->end ${Time.diff(start)}`);
};

export const cleanBazelCache = async (wsRoot: string) => {
  log4("cleanBazelCache->start");
  const start = Date.now();
  await P.all([
    sh.exec("bazel clean --expunge"),
    fs.rm(`${wsRoot}/.bazel/bazel-bazel`),
    fs.rm(`${wsRoot}/.bazel/bazel-bin`),
    fs.rm(`${wsRoot}/.bazel/bazel-out`),
    fs.rm(`${wsRoot}/.bazel/bazel-testlogs`),
    fs.rm(`${wsRoot}/.bazel/cache`),
    fs.rm(`/private/var/tmp/_bazel_brian.dombrowski/cache`),
  ]);
  log4(`cleanBazelCache->end ${Time.diff(start)}`);
};

export const cleanYarnCache = async (wsRoot: string, names: string[]) => {
  log4("cleanYarnCache->start");
  await P.all([
    ...names.map((name) => sh.exec(`yarn cache clean @app/${name}`)),
    sh.exec(
      `find $(yarn cache dir)/.tmp -name package.json -exec grep -sl ${names
        .map((name) => `-e @app/${name}`)
        .join(" ")} {} \\; | xargs dirname | xargs rm -rf`,
      { wd: wsRoot }
    ),
  ]);
  log4("cleanYarnCache->end");
};
/**
 * traverse the directory tree from __dirname to find the nearest WORKSPACE.bazel
 * file and return the path
 */
export const findNearestWsRoot = async () => {
  log4("findNearestWsRoot->start");
  let root = __dirname;
  while (true) {
    const ws = await fs.getC(`${root}/WORKSPACE.bazel`).catch(() => {});
    if (ws) break;
    const next = path.resolve(root, "..");
    if (next === root) {
      throw stepErr(Error("No WORKSPACE.bazel found"), "findNearestWsRoot");
    }
    root = next;
  }
  log4(`findNearestWsRoot->${root}`);
  return root;
};

export const getPkgNames = async (wsRoot: string) => {
  const names = await fs.lsC(`${wsRoot}/packages`);
  if (!!names?.length)
    throw stepErr(
      Error('No packages found in "packages" directory'),
      "getPkgNames"
    );
  return names as string[];
};
export const getPkgNamesC = cachify(getPkgNames);

export const installEnvDeps = async (wsRoot: string) => {
  log4("installEnvDeps->start");
  await P.all([
    sh.assertCmdExists("yarn"),
    sh.assertCmdExists("bazel"),
    sh.assertCmdExists("git"),
    sh.assertCmdExists("jq"),
    // TODO: Figure out why this isn't working
    // sh.cmdExists("bun").then(async (o) => {
    //   !o && sh.exec(`curl -fsSL https://bun.sh/install | bash`);
    // }),
    sh.exec(`chmod +x ${__filename}; ln -sf ${__filename} /usr/local/bin/bz`),
    fs.copyFile(
      `${wsRoot}/.tool-versions`,
      `/private/var/tmp/_bazel_${ENV.user}`,
      { skipBackup: true }
    ),
  ]);
  log4("installEnvDeps->end");
};
export const installEnvDepsC = cachify(installEnvDeps);

export const restorePkgFromCache = async (wsRoot: string, name: string) => {
  log4("restorePkgFromCache->start", name);
  const srcDir = `${wsRoot}/packages/${name}`;
  const cacheDir = `${wsRoot}/.bazel/bazel-bin/packages/${name}`;
  await sh.exec(`rsync ${cacheDir}/package.tgz ${srcDir}/package.tgz`);
  log4("restorePkgFromCache->end");
};

if (import.meta.url === `file://${process.argv[1]}`) {
  // @ts-expect-error - gets confused args
  await main(...process.argv.slice(2));
}
