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
  log1,
  log2,
  log3,
  log4,
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
clean-bazel-cache: purge bazel caches
clean-yarn-cache: purge yarn caches for packages
install: check and install env deps. Also add bz-cli to /usr/local/bin
sync: sync a package's crosslinks' to {package}/node_modules/{cl}
watch: sync + watch for changes
`;

  const args = arg({
    "--action": String,
    "--all": Boolean,
    "--ci": Boolean,
    "--no-cache": Boolean,
    "--help": Boolean,
    "--pkg": String,
    "--pkgs": [String],
    "--verbose": arg.COUNT, // Counts the number of times --verbose is passed
    "--ws": String,

    // Aliases
    "-a": "--all",
    "-h": "--help",
    "-v": "--verbose",
  });

  args["--action"] = args["--action"] || args?._[0];

  if (!args["--action"] || args["--help"]) return console.log(usage);

  ENV.ci = args["--ci"] ? true : ENV.ci;
  ENV.logLevel = args["--verbose"] ? args["--verbose"] + 1 : ENV.logLevel;
  UTIL_ENV.logLevel = ENV.logLevel;

  try {
    const wsRoot = args["--ws"] || (await findNearestWsRoot());
    switch (args["--action"]) {
      case "bootstrap": {
        const names = args["--pkgs"] || args._.slice(1);
        if (!names?.length) return console.log(usage);
        break;
      }
      case "build": {
        const names =
          args["--pkgs"] ||
          (args["--pkg"] && [args["--pkg"]]) ||
          args._.slice(1);
        if (!names?.length) return console.log(usage);
        if (names[0] === "all") {
          await buildAllPkgs(wsRoot, { noCache: args["--no-cache"] });
        } else {
          await buildPkg(wsRoot, names[0], { noCache: args["--no-cache"] });
        }
        break;
      }
      case "sync": {
        const name = args["--pkg"] || args._?.[1];
        if (!name) return console.log(usage);
        const pkg = await Pkg.getPkg(`${wsRoot}/packages/${name}`);
        await pkg.syncCrosslinks();
        break;
      }
      case "watch": {
        const name = args["--pkg"] || args._?.[1];
        if (!name) return console.log(usage);
        const pkg = await Pkg.getPkg(`${wsRoot}/packages/${name}`);
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
  log4("buildAllPkgs-start");
  const { noCache } = options;
  await installEnvDepsC(wsRoot);
  if (noCache) await cleanBazelCache(wsRoot);
  const names = await getPkgNamesC(wsRoot);
  for (const name of names.reverse()) {
    await buildPkg(wsRoot, name);
  }
  log4("buildAllPkgs-end");
};

export const buildPkg = async (
  wsRoot: string,
  name: string,
  options: {
    noCache?: boolean;
  } = {}
) => {
  log4("buildPkg-start", name);
  const { noCache } = options;
  await installEnvDepsC(wsRoot);
  if (noCache) await cleanBazelCache(wsRoot);
  const wsRootForBzl = ENV.ci ? "" : wsRoot;
  await sh.exec(
    `bazel build //packages/${name}:build --define wsroot=${wsRootForBzl}`,
    {
      wd: wsRoot,
    }
  );
  await restorePkgFromCache(wsRoot, name);
  log4("buildPkg-end");
};

export const cleanAll = async (wsRoot: string) => {
  log4("cleanAll-start");
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
  log4("cleanAll-end");
};

export const cleanBazelCache = async (wsRoot: string) => {
  log4("cleanBazelCache-start");
  await P.all([
    sh.exec("bazel clean --expunge"),
    sh.exec(`rm -rf .bazel/bazel-* .bazel/cache`, { wd: wsRoot }),
    sh.exec(`rm -rf /private/var/tmp/_bazel_${ENV.user}/*`),
  ]);
  log4("cleanBazelCache-end");
};

export const cleanYarnCache = async (wsRoot: string, names: string[]) => {
  log4("cleanYarnCache-start");
  await P.all([
    ...names.map((name) => sh.exec(`yarn cache clean @app/${name}`)),
    sh.exec(
      `find $(yarn cache dir)/.tmp -name package.json -exec grep -sl ${names
        .map((name) => `-e @app/${name}`)
        .join(" ")} {} \\; | xargs dirname | xargs rm -rf`,
      { wd: wsRoot }
    ),
  ]);
  log4("cleanYarnCache-end");
};
/**
 * traverse the directory tree from __dirname to find the nearest WORKSPACE.bazel
 * file and return the path
 */
export const findNearestWsRoot = async () => {
  log4("findNearestWsRoot-start");
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
  log4("installEnvDeps-start");
  await P.all([
    sh.assertCmdExists("yarn"),
    sh.assertCmdExists("bazel"),
    sh.assertCmdExists("git"),
    sh.assertCmdExists("jq"),
    // TODO: Figure out why this isn't working
    sh.cmdExists("bun").then(async (o) => {
      !o && sh.exec(`curl -fsSL https://bun.sh/install | bash`);
    }),
    sh.exec(`chmod +x ${__filename}; ln -sf ${__filename} /usr/local/bin/bz`),
    fs.copyFile(
      `${wsRoot}/.tool-versions`,
      `/private/var/tmp/_bazel_${ENV.user}`,
      { skipBackup: true }
    ),
  ]);
  log4("installEnvDeps-end");
};
export const installEnvDepsC = cachify(installEnvDeps);

export const restorePkgFromCache = async (wsRoot: string, name: string) => {
  log4("restorePkgFromCache-start", name);
  const srcDir = `${wsRoot}/packages/${name}`;
  const cacheDir = `${wsRoot}/.bazel/bazel-bin/packages/${name}`;
  await sh.exec(`rsync ${cacheDir}/package.tgz ${srcDir}/package.tgz`);
  log4("restorePkgFromCache-end");
};

if (import.meta.url === `file://${process.argv[1]}`) {
  // @ts-expect-error - gets confused args
  await main(...process.argv.slice(2));
}
