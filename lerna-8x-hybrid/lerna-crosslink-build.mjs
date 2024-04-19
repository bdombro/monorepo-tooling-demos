#!/usr/bin/env node
/**
 * Motivation:
 *   monorepos install devDependencies for all workspaces (ws), and use simple symlinks to connect them.
 *   This can lead to nested devDependencies, which can cause resolution conflicts in the a package.
 *   Example conflicts:
 *   - a React app may have deps that have a diff version of React in their devDependencies. This
 *     will cause bundlers to include multiple versions of React, which blows up the bundle size,
 *     causes runtime errors, and typescript errors.
 * Goal: De-conflict nested dependencies
 * Approach: Re-installing cross-linked packages as if they were file dependencies.
 *
 * Assumptions:
 *  - This cwd is somewhere inside a lerna ws
 *  - The ws root has a package.json with a workspaces field or lerna.json with a packages field
 *  - Workspace packages have a name field with a domain, ie @app/packageName
 *  - Using lerna+nx package manager
 *  - ws packages don't use postinstall or postbuild scripts
 */
import { exec as cpExec } from "child_process";
import chokidar from "chokidar";
import { promises as fsNode } from "fs";
import { dirname, basename } from "path";
import util from "util";

const ENV = {
  logLevel: Number(process.env.LOG ?? 1),
  semiDry: Number(process.env.DRY),
  stopAfterStep: Number(process.env.SAS),
};

async function main(
  /** the full name of a package including domain, or short if using default domain */
  pkgName,
  /** action to take: see usage */
  action
) {
  const usage = `
  Usage: node crosslink-build.mjs {packageName} {action}

  Env:
  LOG=n: sets log level, 1-4 (default 1)
  DOMAIN_DEFAULT=@app: sets the default domain (default @app) for
    package names. You may omit the domain if using the default.

  Actions:
  build-deps:
    - re-installs cross-linked packages as if they were
      file dependencies and builds them, bottom-up
    - bottom-up: builds a dep tree of cross-linked packages
      and processes them in order of dependencies, so that
      build artifacts are ready for dependents
    - resets the package.json and lock files so that
      lerna+nx are unaware
  build: build deps AND the package
  sync: rsyncs the builds of all cross-linked packages with 
  watch: sync with watch mode
  reset: undoes changes made by build and bootstraps package and all cross-links of it
  reset-and-build: reset and then build
  reset-and-build-deps: reset and then build-deps
  test-mode-semi-dry: build, but mocks the slow and high-risk parts
  `;
  if (!pkgName) return console.log(usage);

  let res = { error: null };

  try {
    switch (action) {
      case "build-deps": {
        const clb = new CrosslinkBuild(pkgName);
        res = await clb.run();
        break;
      }
      case "build": {
        const clb = new CrosslinkBuild(pkgName, { buildPkgToo: true });
        res = await clb.run();
        break;
      }
      case "sync": {
        await wss.syncCrosslinks(pkgName);
        break;
      }
      case "watch": {
        await wss.syncCrosslinks(pkgName, { watch: true });
        break;
      }
      case "reset": {
        await crosslinkReset(pkgName);
        break;
      }
      case "reset-and-build-deps": {
        await crosslinkReset(pkgName);
        const clb = new CrosslinkBuild(pkgName);
        res = await clb.run();
        break;
      }
      case "reset-and-build": {
        await crosslinkReset(pkgName);
        const clb = new CrosslinkBuild(pkgName, { buildPkgToo: true });
        res = await clb.run();
        break;
      }
      case "test-mode-semi-dry": {
        ENV.semiDry = 1;
        const clb = new CrosslinkBuild(pkgName, { buildPkgToo: true });
        res = await clb.run();
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
  if (res.error) process.exit(1);
}

/**
 * crosslinkBuild:
 * - re-installs cross-linked packages as if they were
 *   file dependencies and builds them, bottom-up
 * - bottom-up: builds a dep tree of cross-linked packages
 *   and processes them in order of dependencies, so that
 *   build artifacts are ready for dependents
 * - resets the package.json and lock files so that
 *   lerna+nx are unaware
 */
export class CrosslinkBuild {
  pkgName = "";
  buildPkgToo = false;

  ws = {};
  pkg = {};
  pkgsToFix = {};

  steps = {
    success: 0,
    start: 1,
    ctx: 2,
    pack: 3,
    strap: 4,
    build: 5,
  };

  /**
   * The return result of run, is the statistics of what was sucessfull
   *
   * each step of run also has it's own result object, including the duration
   */
  runResult = {
    /** if error, the error code */
    error: null,
    /** if error and was associated with a pkg, which pkg. */
    errorPkg: null,
    /** the pkg being ran against */
    pkg: "",
    /** the last step that was started. Is useful for fail analytics/logs */
    step: 1,
    /** the duration of the entire run as a time string: ie 10m00s */
    time: "",

    /** getCtx results */
    ctx: {
      time: 0,
      /** the names of the crosslinked pkgs */
      crosslinks: [],
    },
    /** yarn pack results */
    pack: {
      time: 0,
    },
    /** bootstrap results */
    strap: {
      time: 0,
      /**
       * count of pkgs that lerna bootstrap failed on. Seems to happen only when using lerna legacy
       * plugins, and we tolerate it with a fallback to `cd pkg; yarn install`
       */
      lernaMissCount: 0,
      /** which pkgs lerna bootstrap failed on */
      lernaMisses: [],
    },
    /** build results */
    build: {
      time: 0,
      count: 0,
      /**
       * count of pkgs that nx build cache-missed on. This should be low if nothing
       * changed since last build. Typically for example, nx won't pull from cache on the pkg that it's
       * targeting, ie pkgName in `nx build --scope=pkgName`. But it should hopefully cache most of the
       * time for the cross-linked packages of pkgName.
       */
      cacheHits: 0,
      cacheMisses: 0,
      /** which pkgs nx cache-missed on. */
      cacheMissPkgs: [],
    },
  };

  constructor(
    /** the full name of a package including domain, or short if using default domain */
    pkgName,
    options = {}
  ) {
    this.pkgName = pkgName;
    oAss(this, options);
  }

  async run() {
    const lctx = `clb:run`;
    const clb = this;
    const res = clb.runResult;

    const start = Date.now();
    const finishCb = async () => {
      log1(`${lctx}:resetting-packageJsons-and-lockFiles`);
      if (!ENV.stopAfterStep) {
        await pAll(oVals(clb.pkgsToFix).map(async (ptf) => ptf.reset()));
      } else {
        log1(`${lctx}:resetting-packageJsons-and-lockFiles:skipped-after-step`);
      }

      res.dur = Time.diff(start);

      log1(`clb:res: ` + str(res));
      log1(`clb:res-pretty: ` + str(res, 2));

      // Cleanup tmp dir since success
      // FIXME: Should we bother?
      // await fs.purgeTmpDir();

      return this.runResult;
    };

    try {
      log1(
        `${lctx}: ${this.pkgName}: ${ENV.semiDry ? ":test-mode" : ""}${
          clb.buildPkgToo ? "" : ":build-entry-pkg-too"
        }`
      );

      res.pkg = clb.pkgName;

      await clb.getCtx();
      if (ENV.stopAfterStep === clb.steps.ctx) return finishCb();

      log1(`${lctx}:fix-todos->${str(oKeys(clb.pkgsToFix).join(","))}`);

      if (oKeys(clb.pkgsToFix).length === 1) {
        log1(`${lctx}: No cross-links to fix`);
        return finishCb();
      }

      await clb.pack();
      if (ENV.stopAfterStep === clb.steps.pack) return finishCb();

      await clb.bootstrap();
      if (ENV.stopAfterStep === clb.steps.strap) return finishCb();

      await clb.build();

      res.step = clb.steps.success;

      return finishCb();

      // end run:runMain
    } catch (e) {
      const msg = strCondense(e?.message ?? e?.stdout ?? "unknown");
      res.error = e?.step ?? msg.split("\n")?.[0]?.slice(0, 100);
      res.pkg = e?.pkg;
      let logMsg = "CLB:ERROR!";
      if (e?.step) logMsg += ` STEP=${e.step}`;
      if (e?.pkg) logMsg += ` PKGs=${e.pkgs}`;
      log1(logMsg);
      const ret = await finishCb();
      log1(logMsg);
      return ret;
    }
  }

  async getCtx() {
    try {
      const start = Date.now();
      const lctx = `clb:getCtx`;
      const res = this.runResult.ctx;
      log1(`${lctx}->start!`);
      this.runResult.step = this.steps.ctx;
      this.ws = await wss.getWorkspace();
      this.pkg = await wss.getPkg(this.pkgName);
      this.pkgsToFix = { [this.pkg.name]: this.pkg, ...this.pkg.crosslinksAll };
      res.crosslinks = oKeys(this.pkgsToFix);

      res.time = Time.diff(start);
      log4(`${lctx}->done! ${res.time}`);
    } catch (e) {
      throw oAss(e, { step: `getCtx:${e?.step}` });
    }
  }

  async pack() {
    try {
      const start = Date.now();
      const lctx = `clb:pack`;
      const res = this.runResult.pack;
      log1(`${lctx}->start!`);

      this.runResult.step = this.steps.pack;
      const _p = [];

      _p.push(
        ...oVals(this.pkgsToFix).map(async (ptf) => {
          await ptf.rmCrosslinks();
          await ptf.pack();
          await ptf.unCrosslink();
        })
      );

      _p.push(wss.yarnBust(this.pkg));

      await pAll(_p);

      res.time = Time.diff(start);
      log4(`${lctx}->done! ${res.time}`);

      // end packMain
    } catch (e) {
      throw oAss(e, { step: `${lctx}: ${e?.step}` });
    }
  }

  async bootstrap() {
    try {
      const clb = this;
      const res = clb.runResult.strap;
      const lctx = `clb:strap`;
      log1(`${lctx}->start!`);

      const start = Date.now();
      const finishCb = () => {
        res.time = Time.diff(start);
        log4(`${lctx}->done! ${res.time}`);
      };

      clb.runResult.step = clb.steps.strap;

      // bootstrap all at once using lerna bootstrap and --scopes for each pkg
      const lernaBootstrapCmd =
        `yarn lerna bootstrap ` +
        oKeys(clb.pkgsToFix)
          .map((name) => `--scope=${name}`)
          .join(" ");
      await sh
        .exec(lernaBootstrapCmd, {
          mockStdout: "",
          workingDir: clb.ws.path,
        })
        .catch((e) => {
          throw oAss(e, { step: `lerna:${e?.step}` });
        });

      /**
       * count of pkgs that lerna bootstrap failed on. Seems to happen only when using lerna legacy
       * plugins
       */
      const pkgsLernaMissed = await (async function findPkgsLernaMissed() {
        return (
          await pAll(
            oVals(clb.pkgsToFix).map(async (ptf) => {
              // check if the package hasn't been bootstrapped at all
              const missingNodeModules = !(await fs.fsStat(
                `${ptf.path}/node_modules`
              ));
              if (missingNodeModules) return ptf;
              // Also check if any of the cross-linked packages are missing
              const missingCls = (
                await pAll(
                  oVals(ptf.crosslinksForBuild).map(async (ptf2) => {
                    return !(await fs.fsStat(
                      `${ptf.path}/node_modules/${ptf2.name}`
                    ));
                  })
                )
              ).find(Boolean);
              if (missingCls) return ptf;
            })
          )
        ).filter(Boolean);
      })().catch((e) => {
        throw oAss(e, { step: "findPkgsLernaMissed" });
      });

      res.lernaMissCount = pkgsLernaMissed.length;
      res.lernaMisses = pkgsLernaMissed.map((p) => p.name);

      // If empty then all packages were bootstrapped sufficiently (hopefully)
      if (!pkgsLernaMissed.length) {
        finishCb();
        return;
      }

      log1(`${lctx}:missed->${str(pkgsLernaMissed.map((p) => p.name))}`);

      /**
       * Ok Lerna failed to fully bootstrap some pkgs. That's okay and we can
       * fallback to just running `yarn install` in each package. This is a little
       * slower, but it's a good fallback.
       *
       * But, we can't fallback though if the package is part of a yarn workspace,
       * because `cd pkg; yarn install` will install all the workspace packages. But,
       * lerna bootstrap *should* be reliable on yarn workspaces so I don't expect
       * this ot happen. Checking anyways though for posterity.
       */

      /** check if any of the failed pkgs are in a yarn workspace */
      const pkgWsPkgsThatFailed = pkgsLernaMissed
        .filter((p) => p.isPkgJsonWsPkg)
        .map((p) => p.name);
      if (pkgWsPkgsThatFailed.length) {
        const step = "checkForPkgWsPkgsThatFailed";
        const error = oAss(
          Error(`strap:${step}:ERROR>${str(pkgWsPkgsThatFailed)}`),
          { pkgs: pkgWsPkgsThatFailed, step }
        );
        if (!ENV.semiDry) throw error;
        log4(e.message);
      }

      /** apply fallback to failed pkgs = `cd pkg; yarn install` */
      await pAll(
        pkgsLernaMissed.map(async (ptf) => {
          log1(`${lctx}:yarnInstall->${ptf.name}`);
          const yarnInstallCmd = `cd ${ptf.path} && yarn install`;
          await sh.exec(yarnInstallCmd, { mockStdout: "" }).catch((e) => {
            throw oAss(e, { pkgs: [ptf.name], step: "yarnInstall" });
          });
        })
      );

      // end bootstrapMain
    } catch (e) {
      throw oAss(e, { step: `strap:${e?.step}` });
    }

    return finishCb();
  }

  async build() {
    const lctx = `clb:build`;
    const clb = this;
    const res = clb.runResult.build;

    try {
      log1(`${lctx}->start!`);
      const start = Date.now();
      clb.runResult.step = clb.steps.build;
      const buildQueue = { ...clb.pkgsToFix };
      await pAll(
        oVals(clb.pkgsToFix).map(async function bldPkg(ptf) {
          try {
            const _p = []; // promise array

            // wait for the cross-linked packages to finish building
            while (oKeys(ptf.crosslinksAll).some((l) => l in buildQueue)) {
              await sh.sleep(100);
            }

            log1(`${lctx}: ${ptf.name}`);

            // sync the cross-linked packages with the build artifacts in ptf
            _p.push(wss.syncCrosslinks(ptf, { verbose: false }));

            // remove the cross-links from the package.json file
            _p.push(ptf.rmCrosslinks({ nodeModules: false }));

            await pAll(_p);

            const stdout = await sh.exec(
              `yarn lerna run build --scope=${ptf.name}`,
              {
                mockStdout: `Nx read the output from the cache instead of running the command for 1 out of 1 tasks`,
              }
            );

            const [cacheHits = 0, buildTasks = 1] =
              stdout
                .matchAll(
                  /Nx read the output from the cache instead of running the command for (\d+) out of (\d+) tasks/g
                )
                .next()
                ?.value?.slice(1)
                .map(Number) ?? [];

            res.count += buildTasks;

            /** We expect there to only be one build task per pkg, bc we ran ptf.unCrosslink in pack step. */
            if (buildTasks !== 1) {
              throw Error(
                `${lctx}: ${ptf.name}:build:[ptf]:error: ${buildTasks} tasks, expected 1`
              );
            }

            /**
             * count of pkgs that nx build cache-missed on. This should be low if nothing
             * changed since last build. Typically for example, nx won't pull from cache on the pkg that it's
             * targeting, ie pkgName in `nx build --scope=pkgName`. But it should hopefully cache most of the
             * time for the cross-linked packages of pkgName.
             */
            if (cacheHits) {
              res.cacheHits += 1;
            } else {
              res.cacheMisses += 1;
              res.cacheMissPkgs.push(ptf.name);
            }

            delete buildQueue[ptf.name];

            // end bldPkgMain
          } catch (e) {
            throw oAss(e, { pkgs: [ptf.name] });
          }
          // end bldPkg
        })
        // end pAll
      );

      res.time = Time.diff(start);
      log4(`${lctx}->done! ${res.time}`);

      // end buildMain
    } catch (e) {
      throw oAss(e, { step: `build:${e?.step}` });
    }
  }
}

/** undoes changes made by build and bootstraps package and all cross-links of it  */
export async function crosslinkReset(pkgName) {
  const lctx = `clReset: ${pkgName}`;
  log1(`${lctx}->start!`);

  const ws = await wss.getWorkspace();

  const pkg = await wss.getPkg(pkgName);

  // bail if there are no workspace deps
  if (!oKeys(pkg.crosslinksAll).length) {
    log1(`${lctx}:No cross-links to fix`);
    return;
  }

  const pkgsToUnfix = { [pkg.name]: pkg, ...pkg.crosslinksAll };
  log1(`${lctx}:unfix-todos:`, oKeys(pkgsToUnfix));

  await pAll(
    oVals(pkgsToUnfix).map(async (ptu) => {
      log1(`${lctx}: ${ptu.pathWs}`);
      await ptu.rmCrosslinks({ pkgJson: false });
    })
  );

  log1(`${lctx}:bootstrap:`);
  await sh.exec(
    `yarn lerna bootstrap --scope=${pkg.name} --include-dependencies`
  );

  log1(`${lctx}:end`);
}

/**
 * Helper methods for Monorepo Workspaces
 * alias: wss
 */
class Workspaces {
  static domainDefault = process.env.DOMAIN_DEFAULT || "@app";

  /** find workspace metadata for the nearest workspace root */
  static getWorkspace = async () => {
    try {
      /**
       * find workspace metadata by looking for the first package.json in the
       * directory tree, starting from the current directory, and moving up
       * until it finds either a workspaces field or a lerna.json file
       */
      const lctx = `ws.getWorkspace`;
      const ws = wss.getWorkspaceCache;
      while (ws.state === 1) {
        log4(`${lctx}:getWorkspace:loading`);
        await sh.sleep(300);
      }
      if (ws.state === 2) {
        return ws;
      }

      ws.state = 1;

      log3(`${lctx}:init`);

      ws.path = process.cwd();
      stepUpDir: while (ws.path !== "/") {
        log4(`${lctx}:try:`, ws.path);
        ws.pkgJsonF = await fs.readPkgJsonFile(`${ws.path}/package.json`, true);
        if (ws.pkgJsonF?.workspaces?.[0]) {
          ws.pkgJsonWsGlobs = ws.pkgJsonF.workspaces;
          ws.wsGlobs = ws.wsGlobs.concat(ws.pkgJsonF.workspaces);
        }
        if (ws.pkgJsonF) {
          ws.lernaJsonF = await fs.readJsonFile(`${ws.path}/lerna.json`, true);
          if (ws.lernaJsonF?.json?.packages?.[0]) {
            ws.wsGlobs = ws.wsGlobs.concat(ws.lernaJsonF.json.packages);
          }
        }
        if (ws.wsGlobs.length) break stepUpDir;
        ws.path = dirname(ws.path);
      }
      if (!ws.wsGlobs.length) throw Error("No workspace root found");

      log1(`${lctx}::match: ${ws.path}`);

      ws.cd = () => {
        log4(`${lctx}:cd: ${ws.path}`);
        process.chdir(ws.path);
      };

      ws.wsGlobs = [...new Set(ws.wsGlobs)]; // de-dupe

      ws.lockFile = await wss.findLockFile(ws.path, true);
      if (!ws.lockFile.name) {
        throw Error(`${lctx}: Workspace missing lock file`);
      }
      ws.yarnVersion = ws.lockFile.yarnVersion;
      if (ws.lockFile.name !== "yarn.lock") {
        throw Error(
          `${lctx}:yarn-check:error: ${ws.pkgJsonF.name} has unsupported package manager with lockFile=${ws.lockFile.name}`
        );
      }
      if (ws.yarnVersion === 1) {
        wss.yarnBustInit(ws.path);
      }

      // TODO: Maybe consolidate these paths with all paths and simplify stuff above
      ws.pkgJsonWsPaths = await (async () => {
        const globs = ws.pkgJsonWsGlobs.filter((g) => g.endsWith("*"));
        const paths = ws.pkgJsonWsGlobs.filter((g) => !g.endsWith("*"));
        await pAll(
          globs.map(async (g) => {
            const dirPath = basename(g);
            const ls = await fs.readRead(`${ws.path}/${dirPath}`, true);
            paths.push(...ls.files.map((f) => `${dirPath}/${f}`));
          })
        );
        return paths;
      })();

      ws.reset = async () => {
        log1("getWorkspace:reset");
        await pAll([we.jsonF.reset(), ws.lockFile.reset()]);
      };

      ws.state = 2;
      return ws;
    } catch (e) {
      throw oAss(e, { step: `getWorkspace` });
    }
  };
  static getWorkspaceCache = {
    /**
     * changes the cwd to the workspace root.
     */
    cd: () => {},
    /**
     * the full path to the ws. tip: prefer using ws.cd() and relative paths instead
     * so logs are cleaner
     */
    path: "",
    pkgJsonF: {},
    lernaJsonF: {},
    lockFile: {},
    /** workspaces from packageJson.workspaces */
    pkgJsonWsGlobs: [],
    /** resets the lock and package.json to the original state when first read */
    reset: async () => {},
    /** 0:unitiated, 1: loading, 2: ready */
    state: 0,
    /** Converts package.json.workspace globs to enumerated paths */
    unGlob: async () => {},
    /** An array of workspace globs = [...packageJson.workspaces, ...lernaJson.packages] */
    wsGlobs: [],
    yarnVersion: 1,
  };

  /**  gets a class-like obj for a ws package with many convenience methods and meta */
  static getPkg = async (pkgName) => {
    try {
      /**
       * - heuristically locates the package folder by name
       *   1. Loops through folders declared in the workspace's package.json
       *      workspaces field, sorted by best guess
       *   2. Reads package.json files in each folder until it finds a match
       *      on the name field
       * - Discovers direct cross-linked packages from package.json:dependencies
       *   by looking for packages with versions of "*" or "workspace:*"
       * - Builds out a crosslinks dictionary of all cross-linked packages, including
       *   nested cross-linked packages.
       *   - key: package name, value: getPkg(packageName)
       * - Heavy caching for speed
       */

      if (!pkgName) throw Error("packageName is required");
      if (!pkgName.includes("/")) pkgName = `${wss.domainDefault}/${pkgName}`;

      const lctx = `ws.getPkg:${pkgName}`;
      log4(`${lctx}->start!`);

      let cached = wss.getPkgCache[pkgName];
      while (cached?.state === 1) {
        await sh.sleep(100);
        cached = wss.getPkgCache[pkgName];
      }
      if (cached?.state === 2) {
        log2(`${lctx}->cache-hit!`);
        return cached;
      }

      const pkg = (wss.getPkgCache[pkgName] = {
        /**
         * dictionary of crosslinked packages, including nested
         *
         * in contrast to crosslinksAll, this only includes the crosslinks
         * needed for dependents of this package
         */
        crosslinksForBuild: {},
        /**
         * dictionary of all crosslinked packages, including nested
         *
         * in contrast to crosslinksForBuild, this includes all crosslinks
         * needed to build this and any dependency cross-link package
         */
        crosslinksAll: {},
        /** dictionary of dependencies from package.json */
        dependencies: {},
        /** dictionary of dependency crosslinked packages */
        dependencyCrosslinks: {},
        /** dictionary of devDependencies from package.json */
        devDependencies: {},
        /** dictionary of devDependency crosslinked packages */
        devDependencyCrosslinks: {},
        domain: "",
        /** Whether the pkg is included in ws:package.json.workspaces */
        isPkgJsonWsPkg: false,
        lockFile: {},
        /** name from package.json.name */
        name: pkgName,
        /** name from package.json.name without domain */
        nameNoDomain: "",
        pack: async () => {},
        /** full path to the package */
        path: "",
        /** rel path to the package from ws.path */
        pathWs: "",
        pkgJsonF: undefined,
        /** resets package to original state so lerna is unaware of changes */
        reset: async () => {},
        /**
         * 1. delete the cross-linked packages from the yarn v1 cache to prevent cache conflicts
         * 2. delete the cross-linked packages from yarn v1 cache to avoid conflicts
         * 3. removes crosslinks from the package.json file (and no other side-effects)
         * this is done ahead of adding ../{pkgName}/package.tgz to the package.json
         */
        rmCrosslinks: async () => {},
        state: 1,
        /** workspaces from package.json.workspaces */
        workspaces: [],
        yarnVersion: 1,
      });

      const ws = await wss.getWorkspace();

      await wss.findPkgJsonFInWs(pkgName, ws).then((match) => {
        const pjf = match.pkgJsonF;
        pkg.wsGlob = match.wsGlob;
        pkg.pkgJsonF = pjf;
        pkg.domain = pjf.domain;
        pkg.json = pjf.json;
        pkg.nameNoDomain = pjf.nameNoDomain;
        pkg.dependencies = pjf.dependencies;
        pkg.devDependencies = pjf.devDependencies;
        pkg.isPkgJsonWsPkg = ws.pkgJsonWsGlobs.includes(pkg.wsGlob);
        pkg.path = dirname(pjf.path);
        pkg.pathWs = wss.relPath(dirname(pjf.path));
        pkg.workspaces = pjf.workspaces;
      });

      log4(`${lctx}:match on ${pkg.path}`);

      // get crosslinks from dependencies
      await pAll(
        oEnts({ ...pkg.dependencies, ...pkg.devDependencies })
          .filter(([name, version]) => {
            // TODO: would be better not to assume all the cls are the same domain, but leave for now bc
            // will catch non-crosslinked packages until I switch to workspace:* syntax only
            // Either that, or gracefully handle if the package is not in the workspace
            return (
              name.startsWith(pkg.domain) &&
              (version === "*" || version === "workspace:*")
            );
          })
          .map(async ([name]) => {
            const dest =
              name in pkg.dependencies
                ? pkg.dependencyCrosslinks
                : pkg.devDependencyCrosslinks;
            console.log({ name, dest });
            dest[name] = await wss.getPkg(name);
          })
      );

      log4(`${lctx}:dependencyCrosslinks`, oKeys(pkg.dependencyCrosslinks));
      log4(
        `${lctx}:devDependencyCrosslinks`,
        oKeys(pkg.devDependencyCrosslinks)
      );

      /** traverses through pkg.dependencyCrosslinks to enumerate all essential crosslinks to build this pkg */
      function flattenCrosslinks(crosslinks, includeIndirect = false) {
        const flat = { ...crosslinks };
        for (const [name, cl] of oEnts(crosslinks)) {
          flat[name] = cl;
          oAss(flat, flattenCrosslinks(cl.dependencyCrosslinks));
          if (includeIndirect) {
            oAss(flat, flattenCrosslinks(cl.devDependencyCrosslinks));
          }
        }
        return flat;
      }
      pkg.crosslinksForBuild = flattenCrosslinks(
        {
          ...pkg.dependencyCrosslinks,
          ...pkg.devDependencyCrosslinks,
        },
        false
      );
      pkg.crosslinksAll = flattenCrosslinks(
        {
          ...pkg.dependencyCrosslinks,
          ...pkg.devDependencyCrosslinks,
        },
        true
      );
      log4(`${lctx}:crosslinksForBuild`, oKeys(pkg.crosslinksForBuild));
      log4(`${lctx}:crosslinksAll`, oKeys(pkg.crosslinksAll));

      pkg.lockFile = await wss.findLockFile(pkg.path);
      if (pkg.lockFile.name && pkg.lockFile.name !== "yarn.lock") {
        throw Error(
          `${lctx}:yarn-check:error: ${pkg.name} has unsupported package manager with lockFile=${pkg.lockFile.name}`
        );
      }
      pkg.yarnVersion = pkg.lockFile.yarnVersion;
      if (pkg.yarnVersion === 1) {
        wss.yarnBustInit(pkg.path);
      }

      pkg.pack = async () => {
        try {
          log2(`${lctx}:pack`);
          await sh.exec(
            pkg.yarnVersion === 1
              ? `yarn pack -f package.tgz`
              : `yarn pack -o package.tgz`,
            { workingDir: pkg.path }
          );
        } catch (e) {
          throw oAss(e, { pkgs: [pkg.name], step: `pack` });
        }
      };

      pkg.reset = async () => {
        try {
          await pAll([pkg.pkgJsonF.reset(), pkg.lockFile.reset()]);
          log4(`${lctx}:reset`);
        } catch (e) {
          throw oAss(e, { pkgs: [pkg.name], step: `reset` });
        }
      };

      pkg.unCrosslink = async () => {
        try {
          log1(`${lctx}:unCrosslink`);
          const depsNext = { ...pkg.dependencies };
          const devDepsNext = { ...pkg.devDependencies };
          const relPath = "../".repeat(pkg.pathWs.split("/").length);
          for (const [name, cl] of oEnts(pkg.crosslinksForBuild)) {
            if (name in depsNext) {
              depsNext[name] = `${relPath}${cl.pathWs}/package.tgz`;
            } else {
              devDepsNext[name] = `${relPath}${cl.pathWs}/package.tgz`;
            }
          }

          log4(`${lctx}:unCrosslink:`, { depsNext, devDepsNext });

          await fsNode.writeFile(
            pkg.pkgJsonF.path,
            str(
              {
                ...pkg.pkgJsonF.json,
                // version: `${Date.now()}`,
                dependencies: depsNext,
                devDependencies: devDepsNext,
              },
              2
            )
          );
        } catch (e) {
          throw oAss(e, { pkgs: [pkg.name], step: `unCrosslinks` });
        }
      };

      pkg.rmCrosslinks = async (options = {}) => {
        try {
          const { nodeModules = true, pkgJson = true } = options;
          const _p = [];

          // remove the cross-linked packages from yarn v1 cache to avoid conflicts
          if (nodeModules) {
            _p.push(
              ...oKeys(pkg.crosslinksForBuild).map(async (cname) => {
                log1(`${lctx}:rm ${pkg.path}/node_modules/${cname}`);
                await fs.rm(`${pkg.path}/node_modules/${cname}`);
              })
            );
          }

          // remove the cross-linked packages from the package.json to avoid conflicts
          if (pkgJson) {
            const clDepExp = new RegExp(
              `"${pkg.domain}/[^:]+: "(workspace:\\*|\\*)",*`,
              "g"
            );

            const matches = pkg.pkgJsonF.text.match(clDepExp);

            if (!matches) {
              log1(`${lctx}:rmCrosslinks:nothing-to-remove`);
              return;
            }

            log1(`${lctx}:rmCrosslinks: ${pkg.pkgJsonF.path}:`, matches);

            const res = pkg.pkgJsonF.text.replace(clDepExp, "");

            _p.push(fsNode.writeFile(pkg.pkgJsonF.path, res));
            fs.backup(pkg.pkgJsonF.path, { text: res });

            await pAll(_p);
          }
        } catch (e) {
          throw oAss(e, { pkg: pkg.name, step: `rmCrosslinks` });
        }
      };

      pkg.state = 2;

      log4(`${lctx}:end`);
      return pkg;
    } catch (e) {
      throw oAss(e, { pkgs: [pkgName], step: `getPkg` });
    }
  };
  static getPkgCache = {};

  /** finds the yarn.lock, package-json.lock, or pnpm-lock.json in pkgPath with workspace root fallback */
  static findLockFile = async (pkgPath) => {
    let cached = wss.findLockFileCache[pkgPath];
    while (cached?.loading) {
      await sh.sleep(100);
      cached = wss.findLockFileCache[pkgPath];
    }
    if (cached) {
      log4(`ws.findLockFile->cache-hit`);
      return cached;
    }

    cached = wss.findLockFileCache[pkgPath] = {
      loading: true,
      name: null,
      path: null,
      pkgPath,
      reset: async () => {},
      text: null,
      yarnVersion: null,
    };

    let path = "";
    let rfRes = null;
    let lockFileName = "";
    const lockFileNames = ["yarn.lock", "package-lock.json", "pnpm-lock.yaml"];
    while ((lockFileName = lockFileNames.shift())) {
      path = `${pkgPath}/${lockFileName}`;
      rfRes = await fs.read(path, true);
      if (rfRes.text) break;
    }
    if (rfRes.text) {
      cached = wss.findLockFileCache[pkgPath] = {
        ...cached,
        loading: false,
        name: lockFileName,
        path,
        reset: rfRes.reset,
        text: rfRes.text,
        yarnVersion: rfRes.text.includes("yarn lockfile v1") ? 1 : 2,
      };
    } else if (wss.getWorkspaceCache?.lockFile) {
      cached = wss.findLockFileCache[pkgPath] = wss.getWorkspaceCache?.lockFile;
    } else {
      cached = wss.findLockFileCache[pkgPath] = {
        ...cached,
        loading: false,
      };
    }
    return cached;
  };
  static findLockFileCache = {};

  /** searches the workspace globs for a package matching the pkgName */
  static findPkgJsonFInWs = async (pkgName, ws) => {
    const lctx = `ws.findPkgJsonFInWs:${pkgName}`;
    log4(`${lctx}->start!`);

    /** find a package in wsGlob with package.json:name=pkgName */
    const tryGlob = async (wsGlob) => {
      const _lctx = `${lctx}: ${wsGlob}`;
      log4(`${_lctx}`);

      let pkgJsonF = null;
      let tryPath = "";

      if (wsGlob.endsWith("*")) {
        log4(`${_lctx}: wsGlob ends with *`);
        if (wsGlob.at(-2) !== "/") {
          throw Error(
            "Only wildcards with full directory are supported, ie 'packages/*' and not 'packages/foo*'"
          );
        }
        const globDirRoot = `${ws.path}/${wsGlob.slice(0, -2)}`;
        const globDirs = (await fs.readRead(globDirRoot)).files;
        if (!globDirs) throw Error(`${_lctx}:dir-not-found`);

        const pkgNameNoDomain = pkgName.split("/")[1];
        if (!pkgNameNoDomain)
          throw Error(`${_lctx}:Package name must be format {domain}/{name}`);

        tryPath = `${globDirRoot}/${pkgNameNoDomain}`;
        if (globDirs.includes(pkgNameNoDomain)) {
          log4(`${_lctx}: try ${wss.relPath(ws.path)}`);
          pkgJsonF = await fs.readPkgJsonFile(`${tryPath}/package.json`);
          if (pkgJsonF?.name === pkgName) {
            log4(`${_lctx}:match-on-wildcard-path-guess`);
            return { wsGlob, pkgJsonF };
          }
        }

        log4(`${_lctx}: else loop all folders in the wildcard path`);
        for (const pkgDir2 of globDirs) {
          tryPath = `${globDirRoot}/${pkgDir2}`;
          log4(`${_lctx}: try ${wss.relPath(ws.path)}`);
          pkgJsonF = await fs.readPkgJsonFile(`${tryPath}/package.json`);
          if (pkgJsonF?.name === pkgName) {
            log4(`${_lctx}:match-on-wildcard-brute-force`);
            return { wsGlob, pkgJsonF };
          }
        }
      } else {
        log4(`${_lctx}: wsglob not a wildcard. Try it out`);
        tryPath = `${ws.path}/${wsGlob}`;
        log4(`${_lctx}: try ${wss.relPath(tryPath)}`);
        pkgJsonF = await fs.readPkgJsonFile(`${tryPath}/package.json`);
        if (pkgJsonF?.name === pkgName) {
          log4(`${_lctx}:match-on-path`);
          return { wsGlob, pkgJsonF };
        }
      }
      log4(`${_lctx}:no-match`);
      return null;
    };

    // split the workspaces into 3 groups: with the package name, with wildcard, and the rest
    // based on best guess
    const wsGlobsWithPkgName = ws.wsGlobs.filter(
      (wsGlob) => basename(wsGlob) === basename(pkgName)
    );
    const wsGlobWilds = ws.wsGlobs.filter((wsGlob) => wsGlob.endsWith("*"));
    const wsGlobsRest = ws.wsGlobs.filter(
      (wsGlob) => !(wsGlob in wsGlobsWithPkgName) && !(wsGlob in wsGlobWilds)
    );

    let match = null;
    if (wsGlobsWithPkgName.length) {
      match = (await pAll(wsGlobsWithPkgName.map((g) => tryGlob(g)))).find(
        Boolean
      );
    }
    if (!match && wsGlobWilds.length) {
      match = (await pAll(wsGlobWilds.map((g) => tryGlob(g)))).find(Boolean);
    }
    if (!match && wsGlobsRest.length) {
      match = (await pAll(wsGlobsRest.map((g) => tryGlob(g)))).find(Boolean);
    }
    if (!match) throw Error(`${lctx}:no-match-found`);

    return match;
  };

  static relPath = (path) => path.replace(wss.getWorkspaceCache.path + "/", "");

  /** syncs the dist folders of all workspace deps in the packagePath */
  static syncCrosslinks = async (pkgOrPkgName, options = {}) => {
    const lctx = `ws.clSync${pkgOrPkgName?.name ?? pkgOrPkgName}`;

    const { verbose = true, watch = false } = options;

    let _log1 = log1;
    let _log2 = log2;
    let _log3 = log3;
    let _log4 = log4;
    if (verbose) {
      _log1 = _log2 = _log3 = _log4 = log1;
    }

    _log3(`${lctx}->start!`);

    const ws = await wss.getWorkspace();

    const pkg =
      typeof pkgOrPkgName === "string"
        ? await wss.getPkg(pkgName)
        : pkgOrPkgName;

    const nestedNodeModules = `${pkg.pathWs}/node_modules`;

    // bail if there are no workspace deps
    if (!(await fs.fsStat(nestedNodeModules))) {
      _log3(`${lctx}->no ws packages to sync`);
      return;
    }

    async function doSync() {
      _log3(`${lctx}->syncing`);
      const pkgs = oVals(pkg.crosslinksForBuild);
      const delta = await pAll(
        pkgs.map(async (cl) => {
          if (await fs.fsStat(`${cl.path}`)) {
            return sh.exec(
              `rsync -av --delete --exclude=node_modules ${cl.pathWs}/ ` +
                `${nestedNodeModules}/${cl.name}`,
              { workingDir: ws.path, silent: true }
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
    }

    await doSync();

    if (watch) {
      const watcher = chokidar.watch([], {
        // FIXME: maybe don't sync whole folder
        ignored: /(node_modules)/,
        persistent: true,
      });
      watcher.on("change", () => doSync());
      oVals(pkg.crosslinks).map(async (cl) => {
        _log1(`${lctx}:watching: ${cl.path}`);
        watcher.add(`${cl.path}`);
      });
      return () => {
        watcher.close().then(() => log1(`${lctx}:end`));
      };
    }
    _log4(`${lctx}:end`);
  };

  /** clear pkgNames from yarn v1 cache if yarn v1 */
  static yarnBust = async (pkg) => {
    try {
      const clNames = oKeys(pkg.crosslinksAll);
      log3(`ws.yarnBust: ${pkg.name}:`, clNames);

      while (wss.yarnBustDir === "loading") {
        await sh.sleep(300);
      }
      if (!wss.yarnBustDir) {
        log2("yarnBust:skip-bc-no-cacheDir-bc-no-yarn-v1s-found");
        return;
      }
      if (1) return;

      const cDir = wss.yarnBustDir;
      const promises = [];

      // Note: No need `${cDir}/.tmp` -- seems like yarn v1 doesn't re-use .tmp folder anyways

      const cPkgDirs = await fsNode.readdir(cDir);
      const toDelete = cPkgDirs.filter((cpd) =>
        clNames.some((n) => cpd.includes(n.replace("/", "-")))
      );
      promises.push(
        ...toDelete.map((cpd) => {
          log3(`yarnBust:rm: ${cpd}`);
          return fs.rm(`${cDir}/${cpd}`);
        })
      );

      await pAll(promises);
      log3("yarnBust:end");
    } catch (e) {
      throw oAss(e, { pkgs: [pkg.name], step: `yarnBust` });
    }
  };
  static yarnBustDir = null;
  // this takes a second, so do proactively it in the background when we first find a yarn v1 pkg
  static yarnBustInit = async (pkgPath) => {
    const lctx = `ws.yarnBustInit: ${pkgPath}`;
    log2(`${lctx}->start!`);

    while (wss.yarnBustDir === "loading") {
      log3(`${lctx}:loading`);
      await sh.sleep(300);
    }
    if (wss.yarnBustDir) return wss.yarnBustDir;
    wss.yarnBustDir = "loading";

    // cd to the package path so we can use the yarn cache dir command
    process.chdir(pkgPath);
    // This is one of the few places that we cd out of the workspace root, so we want to cd for as
    // short a time as possible, hence the wsCd function called several times.
    const wsCd = () =>
      wss.getWorkspaceCache?.path && process.chdir(wss.getWorkspaceCache.path);
    return sh.exec("yarn cache dir").then((out) => {
      wsCd();
      wss.yarnBustDir =
        out.split("\n").filter(Boolean)?.[0] ??
        sh.throw(`${lctx}: Unexpected "yarn cache dir" output: `, { out });
      log3(`${lctx}:cacheDir: ${wss.yarnBustDir}`);
    });
  };
}

/** Filesystem (aka fs) - helpers */
class Filesystem {
  /**
   * Backups files for debugging and troubleshooting purposes
   * to: `/tmp/lerna-crosslink-build/${timestamp}`
   */
  static backup = async (path, options = {}) => {
    const { text = null, moveInsteadOfCopy = false } = options;

    await fs.tmpDirCreate();

    let backupPath =
      `${fs.tmpDir}/` +
      path
        .replace(wss.getWorkspaceCache?.path ?? "", "")
        .slice(1)
        .replace(/\//g, ".") +
      "-" +
      new Date().toISOString().slice(11, -2).replace(/:/g, ".");

    if (text) {
      await fsNode.writeFile(backupPath, text);
    } else if (moveInsteadOfCopy) {
      await fsNode.rename(path, backupPath);
    } else {
      await fsNode.copyFile(path, backupPath);
    }
  };

  static tmpDir =
    `/tmp/lerna-crosslink-build/` +
    new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/(\-|T|:)/g, ".");
  static tmpDirCreate = async () => {
    if (fs.tmpDirCreateLast) return fs.tmpDirCreateLast;
    return (fs.tmpDirCreateLast = util.promisify(cpExec)(
      `mkdir -p ${fs.tmpDir}`
    ));
  };
  static tmpDirPurge = async () => {
    log2("purgeTmpDir");
    await fs.rm(fs.tmpDir);
    fs.tmpDir = null;
  };

  /** fs.stat or null. Is cleaner than dealing with exceptions. */
  static fsStat = async (path) => {
    return fsNode.stat(path).catch(() => null);
  };

  /** get file list from cache or fs, or null */
  static ls = async (path) => {
    const lctx = `fs.ls: ${path}`;
    let cached = fs.lsCache[path];
    while (cached?.loading) {
      await sh.sleep(100);
      cached = fs.lsCache[path];
    }
    if (cached) {
      log4(`${lctx}->cache-hit!`);
      return cached;
    }

    log4(`${lctx}:start`);

    cached = fs.lsCache[path] = {
      loading: true,
      path,
      files: null,
    };

    cached = fs.lsCache[path] = {
      ...cached,
      loading: false,
      files: await fsNode.readdir(path).then(
        (p) => p.filter((p) => p !== ".DS_Store"),
        () => null
      ),
    };
    log4(
      `${lctx}: ${
        cached.files ? `found: ${cached.files.length}` : " not found"
      }`
    );
    return cached;
  };
  static lsCache = {};

  /** read file from cache or fs, or null */
  static read = async (path, options = {}) => {
    const { skipCache = false } = options;
    let cached = fs.readCache[path];
    while (cached?.loading) {
      await sh.sleep(100);
      cached = fs.readCache[pkgName];
    }
    if (cached && !skipCache) {
      log4(`read->cache-hit!`);
      return cached;
    }

    cached = fs.readCache[path] = {
      loading: true,
      path,
      reset: async () => {},
      set: async () => {},
      text: null,
    };

    try {
      const text = await fsNode.readFile(path, "utf-8").catch(() => null);
      cached = fs.readCache[path] = {
        ...cached,
        loading: false,
        /** resets the file to the original state when first read */
        reset: async () => {
          if (text) {
            await fs.backup(path);
            await fsNode.writeFile(path, text);
          }
        },
        set: async (newText) => {
          await fs.backup(path);
          await fsNode.writeFile(path, newText);
          fs.backup(path, { text: newText });
        },
        text,
      };
    } catch (e) {
      cached = fs.readCache[path].loading = false;
    }
    log4(`fs.read->${cached.text ? "found" : "not-found"}: ${path}`);

    if (cached.text) {
      fs.backup(path, { text: cached.text }); // no need to await
    }

    return cached;
  };
  static readCache = {};
  static readResetAllGotten = async () => {
    log1("getResetAllGotten");
    return pAll(oVals(fs.readCache).map((c) => c.reset()));
  };

  /** get package json from cache or file, or null */
  static readJsonFile = async (path, skipCd) => {
    let cached = fs.readJsonFileCache[path];
    while (cached?.state === 1) {
      await sh.sleep(100);
      cached = wss.getJsonFileCache[path];
    }
    if (cached?.state === 2) {
      log4(`getJsonFile->cache-hit!`);
      return cached;
    }

    const jsonF = (fs.readJsonFileCache[path] = {
      json: null,
      path,
      reset: async () => {},
      setJson: async () => {},
      state: 1,
      text: null,
    });

    const rfRes = await fs.read(path, skipCd);
    if (rfRes.text) {
      oAss(jsonF, {
        ...cached,
        ...rfRes,
        setJson: async (json) => rfRes.set(str(json, 2)),
        state: 2,
        json: JSON.parse(rfRes.text),
      });
    } else {
      oAss(jsonF, {
        ...cached,
        state: 2,
      });
    }
    return jsonF;
  };
  static readJsonFileCache = {};

  /** wrapper for getJsonFile with convenience and better typing */
  static readPkgJsonFile = async (path, skipCd) => {
    const jsonF = await fs.readJsonFile(path, skipCd);
    const [domain, nameNoDomain] = jsonF?.json?.name?.split("/") ?? [];
    return {
      ...jsonF,
      name: jsonF?.json?.name,
      domain,
      nameNoDomain,
      dependencies: jsonF?.json?.dependencies ?? {},
      devDependencies: jsonF?.json?.devDependencies ?? {},
      workspaces: jsonF?.json?.workspaces,
    };
  };

  /** wrapper for fs.rm with defaults and option to ignore not-found */
  static rm = async (path, options = {}) => {
    const { recursive = true, force = true } = options;
    return fsNode
      .rm(path, options)
      .catch((e) => oAss(e, { cmd: `fs:rm->${path}`, step: "fs.rm" }));
  };
}

/** Shell / Process helpers aka sh */
class Shell {
  static _exec = util.promisify(cpExec);

  /** Node exec wrapper with lots of special sauce */
  static exec = async (cmd, options = {}) => {
    const {
      mockStderr = null,
      mockStdout = null,
      silent = false,
      verbose = false,
      workingDir = process.cwd(),
    } = options;

    sh.execCount = (sh.execCount ?? 0) + 1;

    let _log1 = log1;
    let _log2 = log2;
    let _log3 = log3;
    let _log4 = log4;
    if (verbose) {
      _log1 = _log2 = _log3 = _log4 = log1;
    }
    if (silent) {
      _log1 = _log2 = _log3 = _log4 = log9;
    }

    const lctx = `exec:${sh.execCount}`;
    _log2(`${lctx} cmd=${cmd}`);
    _log4(`${lctx} cwd=${workingDir}`);

    const mockExec = async () => {
      const execR = {
        code: 1,
        killed: false,
        signal: null,
        stderr: mockStderr,
        stdout: mockStdout,
      };
      if (mockStderr) {
        throw oAss(Error(mockStderr), execR);
      }
      return execR;
    };

    const cwdExp = new RegExp(process.cwd(), "g");

    const execOrMock =
      ENV.semiDry && (isStr(mockStdout) || isStr(mockStderr))
        ? mockExec
        : sh._exec;
    const cmdWithCd = options.workingDir ? `cd ${workingDir} && ${cmd}` : cmd;

    const execR = await execOrMock(cmdWithCd).catch((e) => {
      const stderr = strCondense(e.stderr);
      stderr
        .split("\n")
        .forEach((l) => _log1(`${lctx}:ERROR> ${l.replace(cwdExp, "wd:")}`));
      _log1(`${lctx}:end`);
      _log1(e);
      throw oAss(e, { stderr, cmd, step: "exec", workingDir: workingDir });
    });

    const out = strCondense(execR.stdout);
    out
      .split("\n")
      .forEach((l) => _log3(`${lctx} ${l.replace(cwdExp, "wd:")}`));
    if (!out) {
      _log3(`${lctx}>none`);
    }

    _log3(`${lctx}:end`);
    return out;
  };
  static execCount = 0;

  static sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Convenience method for throwing an error */
  static throw = (message, ...extra) => {
    /**
     * Is extra useful for throwing where you normally can't easily,
     * i.e.: const foo = falsyVar || Pr.throw('error');
     */
    const e = new Error(message);
    e.extra = extra;
    oAss(e, extra);
    throw e;
  };
}

class Log {
  static file = `${Filesystem.tmpDir}/run.log`;
  static logLevel = ENV.logLevel;

  static logn(n) {
    const logLevel = Log.logLevel;
    const logFnc = (...args) => {
      if (isArr(args[0])) {
        args[0].forEach((a) => logFnc(a));
        return;
      }

      // ts = yyyy:hh:mm:ss:msms -> ie 15:12:41.03
      const ts = new Date().toISOString().slice(6, -2);
      const tsNoYear = ts.slice(5);
      const argsExtra =
        args[0] instanceof Error ? args : [tsNoYear, `L${n}`, ...args];

      if (logLevel >= n) {
        if (logLevel <= 1) console.log(...args);
        else console.log(...argsExtra);
      }

      fs.tmpDirCreate().then(() => {
        const hasObjs = args.some((a) => !isTypeOf(a, ["string", "number"]));
        let lines = [`${ts} L${n}`];
        if (hasObjs) lines[0] += ` ${args.join(" ")}`;
        else lines.push(...args.map(str));
        fsNode.appendFile(Log.file, lines.join(" ") + "\n");
      });
      return args;
    };
    return logFnc;
  }
  static l1(...args) {
    return Log.logn(1)(...args);
  }
  static l2(...args) {
    return Log.logn(2)(...args);
  }
  static l3(...args) {
    return Log.logn(3)(...args);
  }
  static l4(...args) {
    return Log.logn(4)(...args);
  }
  /** High number that's used mainly to print to log file without console  */
  static l9(...args) {
    return Log.logn(9)(...args);
  }
}

class Time {
  static diff = (start, end) => {
    const startMs = start instanceof Date ? start.getTime() : start;
    const endMs = end instanceof Date ? end.getTime() : end ? end : Date.now();
    const ms = Math.abs(endMs - startMs);

    const d = Math.floor(ms / (1000 * 60 * 60 * 24));
    const h = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const m = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    const s = Math.floor((ms % (1000 * 60)) / 1000);

    let str = "";
    if (d > 0) str += `${d} day${d > 1 ? "s" : ""}, `;
    if (h > 0) str += `${h} hour${h > 1 ? "s" : ""}, `;
    if (m > 0) str += `${m} minute${m > 1 ? "s" : ""}, `;
    if (s > 0) str += `${s} second${s > 1 ? "s" : ""}`;

    // Remove the trailing comma and space if present
    str = str.trim();

    return str || "0 seconds"; // Return "0 seconds" for no difference
  };
}

(function aliases() {
  Object.assign(globalThis, {
    fs: Filesystem,
    log1: Log.l1,
    log2: Log.l2,
    log3: Log.l3,
    log4: Log.l4,
    log9: Log.l9,
    isTypeOf: (a, typeOrTypes) => {
      const types = isArr(typeOrTypes) ? typeOrTypes : [typeOrTypes];
      return types.includes(typeof a);
    },
    isArr: (a) => Array.isArray(a),
    isNum: (a) => typeof a === "number",
    isStr: (s) => typeof s === "string",
    oAss: (...a) => Object.assign(...a),
    oKeys: (...a) => Object.keys(...a),
    oEnts: (...a) => Object.entries(...a),
    oVals: (...a) => Object.values(...a),
    /**
     * similar to Promise.all, but also flushes the list, which is convenient if
     * using re-useable promise arrays.
     */
    pAll: (ps) => Promise.all(ps.splice(0, ps.length)),
    sh: Shell,
    /** alias for JSON.stringify(arg1, repl, arg2) */
    str: (o, spaces) =>
      JSON.stringify(
        o,
        (k, v) => {
          if (v instanceof Map) return Object.fromEntries(v.entries());
          if (v instanceof Set) return Array.from(v);
          return v;
        },
        spaces ? 2 : 0
      ),
    strCondense: (str) =>
      str
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join("\n"),
    wss: Workspaces,
  });
})();

if (import.meta.url === `file://${process.argv[1]}`) {
  main(...process.argv.slice(2));
}
