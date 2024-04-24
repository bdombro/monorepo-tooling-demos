#!/usr/bin/env node
/**
 * monorepocli (aka mrc) - A monorepo cli tool that links internal packages like npm packages
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
 *  - This script is called from somewhere inside a monorepocli monorepo
 *  - The ws root has a monorepocli.conf.js field
 *  - Workspace packages have a name field with a domain, ie @app/packageName
 *  - ws packages don't use postinstall or postbuild scripts
 */
import { exec as cpExec } from "child_process";
import chokidar from "chokidar";
import { promises as fsNode } from "fs";
import { dirname, basename } from "path";
import util from "util";

const ENV = {
  clearNxCache: Number(process.env.CC),
  logLevel: Number(process.env.LOG ?? 1),
  semiDry: Number(process.env.DRY),
  skipReset: Number(process.env.NORST),
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
  strap:
    - re-installs cross-linked packages as if they were
      file dependencies and builds them, bottom-up
    - bottom-up: builds a dep tree of cross-linked packages
      and processes them in order of dependencies, so that
      build artifacts are ready for dependents
  build: build deps AND the package
  sync: rsyncs the builds of all cross-linked packages with 
  watch: sync with watch mode
  reset: undoes changes made by build and installs package and all cross-links of it
  reset-and-build: reset and then build
  reset-and-build-deps: reset and then build-deps
  test-mode-semi-dry: build, but mocks the slow and high-risk parts
  `;
  if (!pkgName) return console.log(usage);

  let res = { error: null, step: "all" };

  try {
    switch (action) {
      case "strap": {
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

  if (res) {
    log1(
      strCondense(`
        Highlights:
        - target: ${res.target}
        - ctx: ${str2(res.ctx)}
        - pack: ${str2(res.pack)}
        - install: ${str2(res.install)}
        - build: ${str2(res.build)}
        ${res.error ? "" : "- completion: ALL"}
        ${res.error ? `- error: ${res.error}` : ""}
        ${res.errorPkgs ? `- errorPkgs: ${str2(res.errorPkgs ?? [])}` : ""}
        - total time: ${res.time}
      `).split("\n")
    );
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
 */
export class CrosslinkBuild {
  pkgName = "";
  buildPkgToo = false;

  ws = {};
  pkg = {};
  pkgsToFix = {};

  steps = {
    all: "all",
    start: "start",
    ctx: "ctx",
    pack: "pack",
    install: "install",
    build: "build",
  };

  /**
   * The return result of run, is the statistics of what was sucessfull
   *
   * each step of run also has it's own result object, including the duration
   */
  runResult = {
    /** the pkg being ran against */
    target: "",
    /** the flags used in the run */
    runFlags: {},
    /** if error, the error code */
    error: null,
    /** if error and was associated with a pkg, which pkg. */
    errorPkgs: null,
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
    /** install results */
    install: {
      time: 0,
      count: 0,
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
      log2(`${lctx}->resetting-packageJsons-and-lockFiles`);
      if (!(ENV.stopAfterStep || ENV.skipReset)) {
        await fs.resetChangedFiles();
        // await pAll(oVals(clb.pkgsToFix).map(async (ptf) => ptf.reset())); // this may be less fast or thorough
      } else {
        log2(
          `${lctx}:resetting-packageJsons-and-lockFiles->skipped-after-step`
        );
      }

      res.time = Time.diff(start);

      log1(`clb:res-json: ${str(res)}\n`);

      return this.runResult;
    };

    try {
      log1(
        `${lctx}:${this.pkgName}->${str2({
          buildPkgToo: clb.buildPkgToo,
          ...ENV,
        })}`
      );

      res.runFlags = ENV;

      if (!this.pkgName) throw Error("packageName is required");
      if (!this.pkgName.includes("/"))
        this.pkgName = `${wss.domainDefault}/${this.pkgName}`;

      res.target = this.pkgName;

      await clb.getCtx();
      if (ENV.stopAfterStep === clb.steps.ctx) process.exit(1);

      if (ENV.clearNxCache) {
        log1(`${lctx}:clearNxCache`);
        await sh.exec(`nx reset`, {
          mockStdout: "",
          workingDir: clb.ws.path,
        });
      }

      log1(
        `${lctx}:crosslinks->[${
          oKeys(clb.pkgsToFix).slice(1).join(",") ?? "none"
        }]`
      );

      await clb.pack();
      if (ENV.stopAfterStep === clb.steps.pack) process.exit(1);

      await clb.install();
      if (ENV.stopAfterStep === clb.steps.install) process.exit(1);

      await clb.build();

      // end main run try/catch
    } catch (e) {
      const msg = strCondense(e?.message ?? e?.stdout ?? "unknown");
      res.error = e?.step ?? msg.split("\n")?.[0]?.slice(0, 100);
      res.errorPkgs = e?.pkgs;
      log1(e);
      let logMsg = "CLB:ERROR!";
      if (e?.step) logMsg += ` STEP=${e.step}`;
      if (e?.pkg) logMsg += ` PKGs=${e.pkgs}`;
      log1(logMsg);
      log1(`CLB:ERRORJSON->${str(e)}`);
    }

    return finishCb();

    // end run
  }

  /** analyzes the nearest workstation, the package specified at this.pkgName, and all of it's crosslinks */
  async getCtx() {
    try {
      const start = Date.now();
      const lctx = `clb:getCtx`;
      const res = this.runResult.ctx;
      log2(`${lctx}->start!`);
      this.ws = await wss.getWorkspace();
      this.pkg = await wss.getPkg(this.pkgName);
      this.pkgsToFix = { [this.pkg.name]: this.pkg, ...this.pkg.crosslinksAll };

      res.crosslinks = oKeys(this.pkgsToFix).slice(1);

      res.time = Time.diff(start);
      log1(`${lctx}->done! ${res.time}`);
    } catch (e) {
      throw oAss(e, { step: `getCtx:${e?.step}` });
    }
  }

  /**
   * 1. delete the cross-linked packages from the yarn v1 cache to prevent cache conflicts
   * 2. for each cross-linked package, prepare it for packing, pack it, and then un-crosslink it
   */
  async pack() {
    try {
      const start = Date.now();
      const lctx = `clb:pack`;
      const res = this.runResult.pack;
      log2(`${lctx}->start!`);

      const _p = [];

      // 2. for each cross-linked package, prepare it for packing, pack it, then reset it
      _p.push(
        ...oVals(this.pkgsToFix).map(async (ptf) => {
          await ptf.rmCrosslinks({ nodeModules: false });
          await ptf.pack();
          await ptf.reset();
        })
      );

      await pAll(_p);

      res.time = Time.diff(start);
      log1(`${lctx}->done! ${res.time}`);

      // end packMain
    } catch (e) {
      throw oAss(e, { step: `pack:${e?.step}` });
    }
  }

  async install() {
    const clb = this;
    const res = clb.runResult.install;
    const lctx = `clb:install`;

    const start = Date.now();

    try {
      log2(`${lctx}->start!`);

      // 1. delete the cross-linked packages from the yarn v1 cache to prevent cache conflicts
      await wss.yarnBust(this.pkg);

      // TODO: use whatever package manager is in the ws root

      await pAll(
        oVals(this.pkgsToFix).map(async (ptf) => {
          log1(`${lctx}:install->${ptf.name}`);
          await sh
            .exec(`yarn install`, { mockStdout: "", workingDir: ptf.path })
            .catch((e) => {
              throw oAss(e, { pkgs: [ptf.name], step: "install" });
            });
        })
      );

      // end installMain
    } catch (e) {
      throw oAss(e, { step: `install:${e?.step}` });
    }

    res.time = Time.diff(start);
    log1(`${lctx}->done! ${res.time}`);
  }

  // TODO: combine with strap step
  // TODO: break out a "exec-bottom-up" feature in wss
  async build() {
    const lctx = `clb:build`;
    const clb = this;
    const res = clb.runResult.build;

    try {
      log3(`${lctx}->start!`);
      const start = Date.now();

      const ws = await wss.getWorkspace();
      const buildQueue = { ...clb.pkgsToFix };

      await pAll(
        oVals(clb.pkgsToFix).map(async function bldPkg(ptf) {
          try {
            const start = Date.now();

            // wait for the cross-linked packages to finish building
            while (oKeys(ptf.crosslinksAll).some((l) => l in buildQueue)) {
              await sh.sleep(100);
            }

            // TODO: Cache
            // TODO: wss.bottom-up-run
            const cached = null;
            if (cached) {
              res.time = Time.diff(start);
              log1(`${lctx}:${ptf.name}->cache-hit! ${res.time}`);
              delete buildQueue[ptf.name];
              res.count++;
              res.cacheHits++;
              return;
            }

            log2(`${lctx}:${ptf.name}->start!`);

            await sh
              .exec(`yarn build`, {
                mockStdout: ``,
                workingDir: ptf.path,
              })
              .catch((e) => {
                throw oAss(e, { pkgs: [ptf.name], step: "fresh" });
              });

            delete buildQueue[ptf.name];
            res.count++;
            res.cacheMiss++;
            res.time = Time.diff(start);
            log1(`${lctx}:${ptf.name}->built! ${res.time}`);

            // end bldPkgMain
          } catch (e) {
            throw oAss(e, { pkgs: [ptf.name] });
          }
          // end bldPkg
        })
        // end pAll
      );

      res.time = Time.diff(start);
      log1(`${lctx}->done! ${res.time}`);

      // end buildMain
    } catch (e) {
      throw oAss(e, { step: `build:${e?.step}` });
    }
  }
}

/** undoes changes made by build and install and all cross-links of it  */
export async function crosslinkReset(pkgName) {
  const lctx = `clReset: ${pkgName}`;
  log2(`${lctx}->start!`);

  const ws = await wss.getWorkspace();

  const pkg = await wss.getPkg(pkgName);

  // bail if there are no workspace deps
  if (!oKeys(pkg.crosslinksAll).length) {
    log1(`${lctx}:No cross-links to fix`);
    return;
  }

  const pkgsToUnfix = { [pkg.name]: pkg, ...pkg.crosslinksAll };
  log1(`${lctx}:unfix-todos->${str2(oKeys(pkgsToUnfix))}`);

  await pAll(
    oVals(pkgsToUnfix).map(async (ptu) => {
      log1(`${lctx}: ${ptu.pathWs}`);
      await ptu.rmCrosslinks({ pkgJson: false });
    })
  );

  log1(`${lctx}:install:`);
  await sh.exec(
    `yarn lerna install --scope=${pkg.name} --include-dependencies`,
    { workingDir: ws.path }
  );

  log1(`${lctx}:end`);
}

/**
 * Workspaces aka wss - Helper methods for Monorepo Workspaces
 */
class wss {
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
        log4(`${lctx}->loading`);
        await sh.sleep(300);
      }
      if (ws.state === 2) {
        return ws;
      }

      ws.state = 1;

      log3(`${lctx}->start!`);

      ws.path = process.cwd();
      let confImport = null;
      do {
        log5(`${lctx}:try->${ws.path}`);
        confImport = (await import(`${ws.path}/monorepocli.json`)).catch(
          () => {}
        );
      } while (!confImport && (ws.path = dirname(ws.path)) !== "/");

      if (!confImport) throw Error(`${lctx}->No workspace root found`);

      if (!confImport?.conf)
        throw Error(`${lctx}->monorepocli.json missing conf export`);

      oAss(ws, confImport.conf);

      if (!ws.workspaces?.length) {
        throw Error(
          `${lctx}->monorepocli.json.workspaces must be an array of packages`
        );
      }

      log2(`ws->${ws.path}`);

      const globs = ws.workspaces.filter((g) => g.endsWith("*"));
      ws.workspaces = ws.workspaces.filter((g) => !g.endsWith("*"));

      await pAll(
        // check that all workspaces are real folders
        ...ws.workspaces.map(async (g) => {
          await fs.fsStat(`${ws.path}/${g}`).catch(() => {
            throw Error(`${lctx}->${g} in workspace:${ws.path} not found`);
          });
        }),
        // enumerate globs
        ...globs.map(async (g) => {
          const dirPath = basename(g);
          const ls = await fs.ls(`${ws.path}/${dirPath}`).catch(() => {
            throw Error(`${lctx}->${dirPath} in workspace:${g} not found`);
          });
          ws.workspaces.push(...ls.files.map((f) => `${dirPath}/${f}`));
        })
      );

      ws.reset = async () => {
        log4(`${lctx}:reset->start!`);
        await pAll([we.jsonF.reset(), ws.lockFile.reset()]);
        log3(`${lctx}:reset->done!`);
      };

      ws.state = 2;
      return ws;
    } catch (e) {
      throw oAss(e, { step: `ws.getWorkspace` });
    }
  };
  static getWorkspaceCache = {
    /**
     * changes the cwd to the workspace root.
     */
    cd: () => {},
    /**
     * the full path to the ws
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

      log3(`${lctx}->${pkg.path}`);

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
            dest[name] = await wss.getPkg(name);
          })
      );

      log4(
        `${lctx}:dependencyCrosslinks->${str2(oKeys(pkg.dependencyCrosslinks))}`
      );
      log4(
        `${lctx}:devDependencyCrosslinks->${str2(
          oKeys(pkg.devDependencyCrosslinks)
        )}`
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

      log4(
        `${lctx}:crosslinksForBuild->${str2(oKeys(pkg.crosslinksForBuild))}`
      );
      log4(`${lctx}:crosslinksAll->${str2(oKeys(pkg.crosslinksAll))}`);

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
          log3(`${lctx}:pack->start!`);
          await sh.exec(
            pkg.yarnVersion === 1
              ? `yarn pack -f package.tgz`
              : `yarn pack -o package.tgz`,
            { workingDir: pkg.path }
          );
          log2(`${lctx}:pack->done!`);
        } catch (e) {
          throw oAss(e, { pkgs: [pkg.name], step: `pack` });
        }
      };

      /** resets package.json and lock file */
      pkg.reset = async () => {
        try {
          log5(`${lctx}:reset->start!`);
          // TODO: if lockfile is ws root lf, should do that once instead of for each pkg
          await pAll([pkg.pkgJsonF.reset(), pkg.lockFile.reset()]);
          log5(`${lctx}:reset->done!`);
        } catch (e) {
          throw oAss(e, { pkgs: [pkg.name], step: `reset` });
        }
      };

      pkg.unCrosslink = async () => {
        try {
          log3(`${lctx}:unCrosslink->start!`);
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

          log5(`${lctx}:unCrosslink->depsNext=${str2(devDepsNext)}`);
          log5(`${lctx}:unCrosslink->devDepsNext=${str2(devDepsNext)}`);

          await fs.writeFile(
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
          log2(`${lctx}:unCrosslink->done!`);
        } catch (e) {
          throw oAss(e, { pkgs: [pkg.name], step: `unCrosslinks` });
        }
      };

      pkg.rmCrosslinks = async (options = {}) => {
        try {
          const { nodeModules = true, pkgJson = true } = options;
          log3(`${lctx}:rmCrosslink->start!`);
          const _p = [];

          // remove the cross-linked packages from yarn v1 cache to avoid conflicts
          if (nodeModules) {
            _p.push(
              ...oKeys(pkg.crosslinksForBuild).map(async (cname) => {
                log3(`${lctx}:rmCls->${pkg.pathWs}/node_modules/${cname}`);
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
              log2(`${lctx}:rmCls->nothing-to-remove`);
              return;
            }

            log3(
              `${lctx}:rmCls:${pkg.pathWs}->${str2(
                matches.map((m) => m.split('"')[1])
              )}`
            );

            // TODO: Also remove file relative packages
            // relDepFilter = (deps = {}) =>
            //   Object.entries(deps)
            //     .filter(([d, v]) => v.startsWith("../"))
            //     .forEach(([d, v]) => delete deps[d]);
            // clFilter(js.dependencies);
            // clFilter(js.devDependencies);
            // clFilter(js.peerDependencies);

            const res = pkg.pkgJsonF.text.replace(clDepExp, "");

            _p.push(fs.writeFile(pkg.pkgJsonF.path, res));

            await pAll(_p);

            log2(`${lctx}:unCrosslink->done!`);
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
  static findLockFile = async (pkgPathAbs) => {
    const pkgPath = fs.pathRel(pkgPathAbs);
    const lctx = `ws.findLockFile:${pkgPath}`;
    let cached = wss.findLockFileCache[pkgPath];
    while (cached?.loading) {
      await sh.sleep(100);
      cached = wss.findLockFileCache[pkgPath];
    }
    if (cached) {
      log4(`${lctx}->cache-hit!`);
      return cached;
    }

    log5(`${lctx}->start!`);

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
      path = `${pkgPathAbs}/${lockFileName}`;
      rfRes = await fs.get(path, true);
      if (rfRes.text) break;
    }
    if (rfRes.text) {
      log4(`${lctx}->match-on-path ${wss.relPath(path)}`);
      cached = wss.findLockFileCache[pkgPath] = {
        ...cached,
        loading: false,
        name: lockFileName,
        path,
        reset: rfRes.reset,
        text: rfRes.text,
        yarnVersion: rfRes.text.includes("yarn lockfile v1") ? 1 : 2,
      };
    } else {
      log4(`${lctx}->fallback-on-ws`);
      cached = wss.findLockFileCache[pkgPath] = wss.getWorkspaceCache.lockFile;
    }
    log4(`${lctx}->done!`);
    return cached;
  };

  static findLockFileCache = {};

  /** searches the workspace globs for a package matching the pkgName */
  static findPkgJsonFInWs = async (pkgName, ws) => {
    const lctx = `ws.findPkgJsonFInWs:${pkgName}`;
    log4(`${lctx}->start!`);

    /** find a package in wsGlob with package.json:name=pkgName */
    const tryGlob = async (wsGlob) => {
      const _lctx = `${lctx}->${wsGlob}`;
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
        const globDirs = (await fs.ls(globDirRoot)).files;
        if (!globDirs) throw Error(`${_lctx}:dir-not-found`);

        const pkgNameNoDomain = pkgName.split("/")[1];
        if (!pkgNameNoDomain)
          throw Error(`${_lctx}->package name must be format {domain}/{name}`);

        tryPath = `${globDirRoot}/${pkgNameNoDomain}`;
        if (globDirs.includes(pkgNameNoDomain)) {
          log4(`${_lctx}: try ${wss.relPath(ws.path)}`);
          pkgJsonF = await fs.getPkgJsonFile(`${tryPath}/package.json`);
          if (pkgJsonF?.name === pkgName) {
            log4(`${_lctx}:match-on-wildcard-path-guess`);
            return { wsGlob, pkgJsonF };
          }
        }

        log4(`${_lctx}: else loop all folders in the wildcard path`);
        for (const pkgDir2 of globDirs) {
          tryPath = `${globDirRoot}/${pkgDir2}`;
          log4(`${_lctx}: try ${wss.relPath(ws.path)}`);
          pkgJsonF = await fs.getPkgJsonFile(`${tryPath}/package.json`);
          if (pkgJsonF?.name === pkgName) {
            log4(`${_lctx}:match-on-wildcard-brute-force`);
            return { wsGlob, pkgJsonF };
          }
        }
      } else {
        log4(`${_lctx}: wsglob not a wildcard. Try it out`);
        tryPath = `${ws.path}/${wsGlob}`;
        log4(`${_lctx}: try ${wss.relPath(tryPath)}`);
        pkgJsonF = await fs.getPkgJsonFile(`${tryPath}/package.json`);
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

  static relPath = (path) =>
    path.replace(wss.getWorkspaceCache.path, "").replace(/^\//, "") || ".";

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
    const lctx = `ws.yarnBustInit:${basename(pkgPath)}`;

    while (wss.yarnBustDir === "loading") {
      log3(`${lctx}:loading`);
      await sh.sleep(300);
    }
    if (wss.yarnBustDir) return wss.yarnBustDir;
    wss.yarnBustDir = "loading";

    log3(`${lctx}->start!`);

    return sh.exec("yarn cache dir", { workingDir: pkgPath }).then((out) => {
      wss.yarnBustDir =
        out.split("\n").filter(Boolean)?.[0] ??
        sh.throw(`${lctx}: Unexpected "yarn cache dir" output: `, { out });
      log3(`${lctx}->${wss.yarnBustDir}`);
    });
  };
}

/** Filesystem (aka fs) - helpers */
class fs {
  /**
   * Backups files for debugging and troubleshooting purposes
   * to: `/tmp/lerna-crosslink-build/${timestamp}`
   */
  static backup = async (path, options = {}) => {
    try {
      const { text = null, moveInsteadOfCopy = false } = options;

      await fs.tmpDirCreate();

      let backupPath =
        `${fs.tmpDir}/` +
        path
          // .replace(wss.getWorkspaceCache?.path ?? "", "")
          // .slice(1)
          .replace(/\//g, ".") +
        "-" +
        new Date().toISOString().slice(11, -2).replace(/:/g, ".");

      if (text) {
        await fs.writeFile(backupPath, text, { skipBackup: true });
      } else if (moveInsteadOfCopy) {
        await fs.rename(path, backupPath, { skipBackup: true });
      } else {
        await fs.copyFile(path, backupPath, { skipBackup: true });
      }
    } catch (e) {
      // don't throw if backup fails bc it's not critical and is often an unhandled error so will hard hault the process
      log1(
        oAss(e, {
          extra: "WARN: fs.backup failed",
          step: `fs.backup:${e?.step}`,
        })
      );
    }
  };

  static copyFile = async (from, to, { skipBackup }) => {
    try {
      if (!skipBackup) {
        if (fs.fsStat(to)) {
          await fs.backup(to);
          if (!(to in fs.dirtyFiles)) {
            fs.dirtyFiles[to] = { path: to, orig: (await fs.get(to)).text };
          }
        } else {
          fs.createdFiles.push(to);
        }
      }
      await fsNode.copyFile(from, to);
    } catch (e) {
      throw oAss(Error(e), { step: `fs.copyFile` });
    }
  };

  static createdFiles = [];

  static dirtyFiles = {};

  /** fs.stat or null. Is cleaner than dealing with exceptions. */
  static fsStat = async (path) => {
    return fsNode.stat(path).catch(() => null);
  };

  /** get's a file object, or null */
  static get = async (path, options = {}) => {
    const { skipCache = false } = options;
    let cached = fs.getCache[path];
    while (cached?.loading) {
      await sh.sleep(100);
      cached = fs.getCache[pkgName];
    }
    if (cached && !skipCache) {
      log4(`read->cache-hit!`);
      return cached;
    }

    cached = fs.getCache[path] = {
      loading: true,
      path: path,
      reset: async () => {},
      set: async () => {},
      text: null,
    };

    try {
      const text = await fsNode.readFile(path, "utf-8").catch(() => null);
      cached = fs.getCache[path] = {
        ...cached,
        loading: false,
        /** resets the file to the original state when first read */
        reset: async () => {
          if (text) {
            await fs.writeFile(path, text);
          }
        },
        set: async (newText) => {
          await fs.writeFile(path, newText);
        },
        text,
      };
    } catch (e) {
      cached = fs.getCache[path].loading = false;
    }
    log4(`fs.get->${cached.text ? "found" : "not-found"}: ${path}`);
    return cached;
  };
  static getCache = {};

  /** get package json from cache or file, or null */
  static getJsonFile = async (path, skipCd) => {
    let cached = fs.getJsonFileCache[path];
    while (cached?.state === 1) {
      await sh.sleep(100);
      cached = wss.getJsonFileCache[path];
    }
    if (cached?.state === 2) {
      log4(`getJsonFile->cache-hit!`);
      return cached;
    }

    const jsonF = (fs.getJsonFileCache[path] = {
      json: null,
      path,
      reset: async () => {},
      setJson: async () => {},
      state: 1,
      text: null,
    });

    const rfRes = await fs.get(path, skipCd);
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
  static getJsonFileCache = {};

  /** wrapper for getJsonFile with convenience and better typing */
  static getPkgJsonFile = async (path, skipCd) => {
    const jsonF = await fs.getJsonFile(path, skipCd);
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

  static getResetAllGotten = async () => {
    log1("getResetAllGotten");
    return pAll(oVals(fs.getCache).map((c) => c.reset()));
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

  static pathRel = (path) => {
    if (path.startsWith(process.cwd())) {
      return path.replace(process.cwd(), "").replace(/^\//, "") ?? "./";
    }
    return path;
  };

  static read = fs.get;

  static rename = async (from, to, options = {}) => {
    try {
      const { skipBackup = false } = options;
      if (!skipBackup) {
        await fs.backup(from);
        if (!(from in fs.dirtyFiles)) {
          fs.dirtyFiles[from] = { path: from, orig: (await fs.get(from)).text };
        }
        if (fs.fsStat(to)) {
          await fs.backup(to);
          if (!(to in fs.dirtyFiles)) {
            fs.dirtyFiles[to] = { path: to, orig: (await fs.get(to)).text };
          }
        } else {
          fs.createdFiles.push(to);
        }
      }
      await fsNode.rename(from, to);
    } catch (e) {
      throw oAss(Error(e), { step: `fs.rename` });
    }
  };

  static resetChangedFiles = async () => {
    try {
      const lctx = `fs.resetChangedFiles`;
      log4(`${lctx}->start!`);
      await pAll(
        oVals(fs.dirtyFiles).map((df) => {
          return fs.writeFile(df.path, df.orig, { skipBackup: true });
        })
      );
      await pAll(fs.createdFiles.map((cf) => fs.rm(cf, { skipBackup: true })));
    } catch (e) {
      throw oAss(Error(e), { step: lctx });
    }
  };

  /** wrapper for fs.rm with defaults and option to ignore not-found */
  static rm = async (path, options = {}) => {
    try {
      const { skipBackup = false, ...restOptions } = options;
      if (
        !skipBackup &&
        !(path in fs.dirtyFiles) &&
        (await fs.fsStat(path)?.isFile())
      ) {
        fs.dirtyFiles[path] = { path, orig: (await fs.get(path)).text };
      }
      if (!("recursive" in restOptions)) restOptions.recursive = true;
      if (!("force" in restOptions)) restOptions.force = true;
      return fsNode.rm(path, restOptions);
    } catch (e) {
      oAss(e, { cmd: `fs:rm->${path}`, step: "fs.rm" });
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
    )).catch((e) => {
      throw oAss(e, { step: `fs.tmpDirCreate` });
    });
  };
  static tmpDirPurge = async () => {
    log2("purgeTmpDir");
    await fs.rm(fs.tmpDir);
    fs.tmpDir = null;
  };

  static writeFile = async (to, data, options = {}) => {
    try {
      const { skipBackup = false } = options;
      if (!skipBackup) {
        if (fs.fsStat(to)) {
          await fs.backup(to);
          if (!(to in fs.dirtyFiles)) {
            fs.dirtyFiles[to] = { path: to, orig: (await fs.get(to)).text };
          }
        } else {
          fs.createdFiles.push(to);
        }
      }
      await fsNode.writeFile(to, data);
    } catch (e) {
      throw oAss(Error(e), { step: `fs.writeFile` });
    }
  };
}

/** Shell / Process helpers aka sh */
class sh {
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

    const id = (sh.execCount = (sh.execCount ?? 0) + 1);
    const lctx = `exec:${id}`;

    _log2(`${lctx} cmd='${cmd}'`);
    _log4(`${lctx} cwd=${workingDir}`);

    const maxStdOutLen = 20000;

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
      let out = strCondense(e.stdout ?? "none");
      let outFlags = "";
      if (out.length > maxStdOutLen) {
        out = out.slice(0, maxStdOutLen) + "...";
        outFlags = "(trimmed)";
      }

      let err = strCondense(e.stderr);
      let errFlags = "";
      if (err.length > maxStdOutLen) {
        err = err.slice(0, maxStdOutLen) + "...";
        errFlags = "(trimmed)";
      }

      _log1(
        (
          `ERROR!\n` +
          `cmd='${cmd}'\n` +
          `wd=${workingDir}\n\n` +
          `stdout: ${outFlags}\n` +
          `${out}\n\n\n` +
          `stderr: ${errFlags}\n` +
          `cmd='${cmd}'\n` +
          `${err}\n\n\n` +
          `context:\n` +
          `cmd='${cmd}'\n` +
          `wd=${workingDir}\n\n`
        )
          .split("\n")
          .map((l) => `${lctx} ${l}`)
      );

      _log1(`${lctx}:end`);
      const e2 = oAss(Error(`${lctx}->nonzero-return`), {
        cmd,
        execId: id,
        step: "exec",
        workingDir: workingDir,
      });
      throw e2;
    });

    let out = strCondense(execR.stdout ?? "none");
    let outPrefix = `stdout:`;
    if (out.length > maxStdOutLen) {
      out = out.slice(0, maxStdOutLen) + "...";
      outPrefix += " (trimmed)";
    }

    `${outPrefix}\n${out}`
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
  static file = `${fs.tmpDir}/run.log`;

  /** determines how much logging is printed to the console. Higher is more. */
  static logLevel = ENV.logLevel;

  static logn(n) {
    const logLevel = Log.logLevel;
    const logFnc = (...args) => {
      // This debug line helps find empty log calls
      // if ([...args].join("").trim() === "") console.trace();

      // if first arg is an array, log each item in the array
      if (isArr(args[0])) {
        args[0].forEach((a) => logFnc(a));
        return;
      }

      // ts = yyyy:hh:mm:ss:msms -> ie 2024:15:12:41.03
      const ts = new Date().toISOString().slice(0, -2);

      // skip logging to console if the log message level is higher than the log level
      if (logLevel >= n) {
        if (logLevel <= 1) console.log(...args);
        else {
          const tsNoYear = ts.slice(11);
          // prepend the log level to the log message
          const argsExtra =
            args[0] instanceof Error ? args : [tsNoYear, `L${n}`, ...args];
          console.log(...argsExtra);
        }
      }

      // lazily log to file
      fs.tmpDirCreate().then(() => {
        let txt = "";
        if (args[0] instanceof Error) {
          let lines = [];
          // dump of the error in a the way that mimics console
          lines.push(args[0].stack + " {");
          lines.push(...oEnts(args[0]).map(([k, v]) => `  ${k}: ${v}`));
          lines.push("}");
          txt = lines.join("\n") + "\n";
        } else {
          let lines = [];
          lines.push(`${ts} L${n}`);
          const hasObjs = args.some((a) => !isTypeOf(a, ["string", "number"]));
          if (!hasObjs) lines[0] += ` ${args.join(" ")}`;
          else lines.push(...args.map(str));
          txt = lines.join(" ") + "\n";
        }
        fsNode.appendFile(Log.file, txt);
      });

      return args;

      // end of logFnc
    };
    return logFnc;
    // end of logn
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
  static l5(...args) {
    return Log.logn(5)(...args);
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
    if (d > 0) str += `${d}d`;
    if (h > 0) str += `${h}h`;
    if (m > 0) str += `${m}m`;
    if (s > 0) str += `${s}s`;

    // Remove the trailing comma and space if present
    str = str.trim();

    return str || "0s"; // Return "0 seconds" for no difference
  };
}

(function aliases() {
  // Regular expression to match ANSI escape codes
  const strAnsiEscapeExp = /(?:\x1B[@-Z\\-_]|\x9B|\x1B\[)[0-?]*[ -/]*[@-~]/g;
  Object.assign(globalThis, {
    log1: Log.l1,
    log2: Log.l2,
    log3: Log.l3,
    log4: Log.l4,
    log5: Log.l5,
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
    /** alias for JSON.stringify(arg1, repl, arg2) */
    str: (o, spaces) =>
      JSON.stringify(
        o,
        (k, v) => {
          if (v instanceof Error) return { ...v, stack: v.stack };
          if (v instanceof Map) return Object.fromEntries(v.entries());
          if (v instanceof Set) return Array.from(v);
          return v;
        },
        spaces ? 2 : 0
      ),
    /* stringify an object but try to make it more concise and semi-pretty, like for logging */
    str2: (o) => {
      if (!o) return "";
      let s = str(o);
      if (s === "{}") return s;
      if (s === "[]") return s;
      s = s
        // remove first and last brackets
        .replace(/^[{[]/, "")
        .replace(/[}\]]$/, "")
        // remove quotes
        .replace(/["]/g, "")
        // add a space after commas
        .replace(/,/g, ", ");
      return s;
    },
    strCondense: (str) =>
      str
        .replace(strAnsiEscapeExp, "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .join("\n"),
    strAnsiEscapeExp,
  });
})();

if (import.meta.url === `file://${process.argv[1]}`) {
  main(...process.argv.slice(2));
}
