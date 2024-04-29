#!/usr/bin/env bun
/**
 * bz - A bazel JS monorepo cli tool orchestrates the building of and development of packages in
 * a bazel monorepo, with careful handling of crosslinks to mimic the install behavior of npm
 * published packages.
 *
 * bz orchestrates bazel for cache-assisted builds, and a companion tool pkg-cli for bootstrapping,
 * building, and developing a packages.
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
 * Goal: De-conflict nested dependencies with a great developer experience
 */
import arg from "arg";
import {
  Bazel,
  cachify,
  HashM,
  fs,
  keyBy,
  Log,
  logDefault,
  P,
  sh,
  stepErr,
  Time,
  UTIL_ENV,
  Yarn,
} from "./util.js";
import { main as pkgMain, Pkg, PKG_ENV } from "./pkg-cli.js";

const __filename = fs.fileURLToPath(import.meta.url);
const __dirname = fs.dirname(__filename);

export const MONO_ENV = {
  logLevel: Number(process.env["LOG"] ?? 1),
  ci: process.env["CI"] === "1" ? true : false,
  user: process.env["USER"],
  install: cachify(async () => {
    await P.all([
      UTIL_ENV.installDeps(),
      PKG_ENV.install(),
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

// TODO: How to handle npmrc issue that we need npm token to install private packages, which
// didn't work when I first tried od/code

const log = new Log({ prefix: "MONO:" });
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
  mono [options] <action> [...action args]
  ...after install, or use \`bun ${__filename}\` the first time to install

Env:
LOG=n: sets log level, 1-4 (default 1)
TODO: what to do about domain
DOMAIN_DEFAULT=@app: sets the default domain (default @app) for
  pkg names. You may omit the domain if using the default.

Actions:
bootstrap: bootstrap a package and build it's dependencies
build: build a package and it's dependencies
clean: purge bazel+yarn caches, crosslinks in node_modules, build artifacts
clean-hard: also purge node_modules folders
clean-yarn-cache: purge yarn caches for packages
cloud-cache-disable: disable cloud caching
cloud-cache-enable: enable cloud caching
install: check and install env deps. Also add bz-cli to /usr/local/bin
pkg: pass a command to the pkg-cli
sync: sync a package's crosslinks' to {package}/node_modules/{cl}
watch: sync + watch for changes
`;

  const allArgs = process.argv.slice(2);

  const args = arg({
    "--all": Boolean,
    "--ci": String,
    /** Disable remote caching and purge local caches before build/bootstrapping */
    "--no-cache": Boolean,
    "--help": Boolean,
    "--show-loglevels": Boolean,
    "--show-timestamps": Boolean,
    "--loglevel": Number,
    "--verbose": arg.COUNT, // Counts the number of times --verbose is passed
    // the location of the workspace root (optional, will find on own)
    "--ws": String,

    // Aliases
    "-a": "--all",
    "-h": "--help",
    "-v": "--verbose",
  });

  const action = args._?.[0];
  if (!action) return console.log(usage);

  if (action === "pkg") {
    return pkgMain();
  }

  if (args["--help"]) return console.log(usage);

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

  const parsePkgNames = () => {
    const pkgNames = args._.slice(2).map((n) =>
      [".", "./"].includes(n) ? fs.basename(process.cwd()) : n
    );
    return pkgNames;
  };

  log1(`>${allArgs.join(" ")}`);
  log4(`>ENV CI=${MONO_ENV.ci} logLevel=${MONO_ENV.logLevel}`);

  try {
    const wsRoot = args["--ws"] || (await Bazel.findNearestWsRootC());
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
        const pkgNames = parsePkgNames();
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
        await clean(wsRoot);
        return;
      }
      case "clean-hard": {
        await clean(wsRoot, { rmAllNodeModules: true });
        return;
      }
      case "clean-yarn-cache": {
        await Yarn.cachePurge();
        return;
      }
      case "cloud-cache-disable": {
        // FIXME: await c.setCloudCacheEnabled(false);
        return;
      }
      case "cloud-cache-enable": {
        // FIXME:  await c.setCloudCacheEnabled(true);
        return;
      }
      case "install": {
        await MONO_ENV.install();
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

const build = async (
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
  const pkg = await Pkg.getPkg(`${wsRoot}/packages/${pkgBasename}`);
  await pkg.build({ noCache });
  log1(`${lctx}->end ${Time.diff(start)}`);
};

export const buildAllPkgs = async (
  wsRoot: string,
  options: {
    noCache?: boolean;
  } = {}
) => {
  log4("buildAllPkgs->start");
  const start = Date.now();
  const { noCache } = options;
  const pkgBasenames = (await getPkgPaths(wsRoot)).map((p) => fs.basename(p));
  for (const name of pkgBasenames.reverse()) {
    await build(wsRoot, name), { noCache };
  }
  log4(`buildAllPkgs->end ${Time.diff(start)}`);
};

export const clean = async (
  wsRoot: string,
  options: {
    rmAllNodeModules?: boolean;
  } = {}
) => {
  try {
    const { rmAllNodeModules } = options;
    const pkgs = await getPkgs(wsRoot);
    log1(`clean->start ${pkgs.length} packages`);
    await Pkg.cachePurge();
    await P.all(pkgs.map((p) => p.clean({ rmAllNodeModules })));
    log1(`clean->done`);
  } catch (e) {
    throw stepErr(e, "cleanAll");
  }
};

export const getPkgPaths = cachify(async (wsRoot: string) => {
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

export const getPkgs = cachify(async (wsRoot: string) => {
  const pkgBasenames = await getPkgPaths(wsRoot);
  const pkgs = await P.all(pkgBasenames.map((n) => Pkg.getPkg(n)));
  return pkgs;
});

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
