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
 */

import { exec } from "child_process";
import { promises as fs } from "fs";
import pathNode from "path";
import util from "util";
import chokidar from "chokidar";

const logLevel = parseInt(process.env.LOG || "1");
const domainDefault = process.env.DOMAIN_DEFAULT || "@app";

async function main(
  /** the full name of a package including domain, or short if using default domain */
  pkgName,
  /** action to take: see usage */
  action
) {
  const usage = `
  Usage: node fix-deps.mjs {packageName} {action}

  Env:
  LOG=n: sets log level, 1-4 (default 1)
  DOMAIN_DEFAULT=@app: sets the default domain (default @app) for
    package names. You may omit the domain if using the default.

  Actions:
  init:
    - re-installs cross-linked packages as if they were
      file dependencies and builds them, bottom-up
    - bottom-up: builds a dep tree of cross-linked packages
      and processes them in order of dependencies, so that
      build artifacts are ready for dependents
    - resets the package.json and lock files so that
      lerna+nx are unaware
  un-init: undoes the changes made by init
  re-init: un-inits and then re-inits
  build: init + build 
  reset: reverts the changes made by init
  sync: rsyncs the dist folders of all cross-linked packages
  watch: sync with watch mode
  `;
  if (!pkgName) return console.log(usage);
  switch (action) {
    case "init":
      await fixDeps(pkgName);
      break;
    case "un-init":
      await unfixDeps(pkgName);
      break;
    case "re-init":
      await unfixDeps(pkgName);
      await fixDeps(pkgName);
      break;
    case "build":
      await fixDeps(pkgName, { minimalBuilds: false });
      break;
    case "sync":
      await rsyncDists(pkgName);
      break;
    case "watch":
      await rsyncDists(pkgName, true);
      break;
    default:
      return console.log(usage);
  }
}

/**
 * fixDeps:
 * - re-installs cross-linked packages as if they were
 *   file dependencies and builds them, bottom-up
 * - bottom-up: builds a dep tree of cross-linked packages
 *   and processes them in order of dependencies, so that
 *   build artifacts are ready for dependents
 * - resets the package.json and lock files so that
 *   lerna+nx are unaware
 */
export async function fixDeps(
  /** the full name of a package including domain, or short if using default domain */
  pkgName,
  {
    /** whether to also build pkgName */
    minimalBuilds = true,
  } = {}
) {
  log1(`fixDeps:${pkgName}:${minimalBuilds ? "minimal-build" : "full-build"}`);
  const start = Date.now();

  const ws = await findWorkspace();
  const meta = await getPkg(pkgName);
  ws.cd();

  // bootstrap if not already
  if (!(await fsStatOrNull(`${meta.path}/node_modules`))) {
    log1("bootstrapping");
    await execWs(
      `node_modules/.bin/lerna bootstrap --scope=${meta.name} --include-dependencies`
    );
  }

  // bail if there are no workspace deps
  if (!Object.keys(meta.crosslinks).length) {
    log1("No cross-links to fix");
    return;
  }

  const pkgMetasToBundle = { [meta.name]: meta, ...meta.crosslinks };
  log1("fixDeps:fix-todos:", Object.keys(pkgMetasToBundle));

  await Promise.all(
    Object.values(pkgMetasToBundle).map(async (pmtb) => {
      while (Object.keys(pmtb.crosslinks).some((l) => l in pkgMetasToBundle)) {
        await sleep(100);
      }
      await fixDeps
        .apply(pmtb, minimalBuilds ? pmtb.name !== meta.name : true)
        .catch((e) => {
          log1(`fixDeps:error:on:${pmtb.name}`);
          log1("fixDeps:error:", e);
          log1("fixDeps:error:end");
          throw e;
        });
      delete pkgMetasToBundle[pmtb.name];
    })
  ).catch(async (e) => {
    log1("fixDeps:resetting-world");
    await getFile.resetAll();
    await unfixDeps(pkgName);
    throw e;
  });

  log1(`fixDeps:end:${Date.now() - start}ms`);

  // Cleanup tmp dir since success
  // await getTmpDir.purge();
}
/**
 * init:
 * - re-installs cross-linked packages as if they were
 *   file dependencies and builds them, bottom-up
 * - bottom-up: uses a dep tree of cross-linked packages
 *   and processes them in order of dependencies, so that
 *   build artifacts are ready for dependents
 * - resets the package.json and lock files so that
 *   lerna+nx are unaware
 */
fixDeps.apply = async (pkgMeta, build = true) => {
  const lctx = `fixDeps.apply:${pkgMeta.name}`;
  log1(lctx);
  const start = Date.now();

  const ws = await findWorkspace();
  ws.cd();

  const m = pkgMeta;
  const clNames = Object.keys(m.crosslinks);

  if (Object.keys(m.crosslinks).length) {
    log1(`${lctx}:crosslinks-todo:`, clNames);

    await Promise.all([
      // delete the cross-linked packages from the yarn v1 cache to prevent cache conflicts
      yarnBust(m),
      // delete the cross-linked packages from yarn v1 cache to avoid conflicts
      ...clNames.map((cname) => {
        log1(`${lctx}:rm ${m.path}/node_modules/${cname}`);
        return fs.rm(`${m.path}/node_modules/${cname}`, {
          recursive: true,
          force: true,
        });
      }),
      // remove the cross-linked packages from the package.json to avoid conflicts
      m.rmCrosslinks(),
    ]);

    // Do fixes: install the cross-linked packages as relative file dependencies so that
    // they are installed as if they were npm packages
    log1(`${lctx}:yarn-adds`);
    await execWs(
      // note: we use yarn add bc is faster than lerna add
      `cd ${m.path}; yarn add ${Object.values(m.crosslinks)
        .map(
          (cm) =>
            `${"../".repeat(m.path.split("/").length)}${cm.path}/package.tgz`
        )
        .join(" ")};`
    );

    log1(`${lctx}:cleanup`);
    await m.reset();
  }

  if (build) {
    // now build it and pack it for dependents

    /// build it!
    log1(`${lctx}:build`);
    await execWs(`node_modules/.bin/lerna run build --scope=${m.name}`);

    // pack it!
    log1(`${lctx}:pack`);
    // - remove the cross-linked packages from the package.json to avoid conflicts
    await m.rmCrosslinks();
    await m.pack();

    // reset the state of the package.json and lock file so that lerna+nx are unaware
    log1(`${lctx}:reset`);
    await m.reset();
  }

  log2(`${lctx}:end:${Date.now() - start}ms`);
};

export async function unfixDeps(packageName) {
  const lctx = `unfixDeps:${packageName}`;
  log1(lctx);

  const ws = await findWorkspace();
  ws.cd();

  const m = await getPkg(packageName);

  // bail if there are no workspace deps
  if (!Object.keys(m.crosslinks).length) {
    log1(`${lctx}:No cross-links to fix`);
    return;
  }

  const pkgMetasToUnfix = { [m.name]: m, ...m.crosslinks };
  log1(`${lctx}:unfix-todos:`, Object.keys(pkgMetasToUnfix));

  await Promise.all(
    Object.values(pkgMetasToUnfix).map((pmtu) => {
      log1(`${lctx}:rm ${pmtu.path}/node_modules`);
      return fs.rm(`${pmtu.path}/node_modules`, {
        recursive: true,
        force: true,
      });
    })
  );

  log1(`${lctx}:bootstrap:`);
  await execWs(
    `node_modules/.bin/lerna bootstrap --scope=${m.name} --include-dependencies`
  );

  log1(`${lctx}:end`);
}

/**
 * syncs the dist folders of all workspace deps in the packagePath
 */
export async function rsyncDists(pkgName, watch = false) {
  const lctx = `rsyncDists:${pkgName}`;
  log1(lctx + watch ? ":with-watch" : "");

  findWorkspace.init();

  const ws = await findWorkspace();
  ws.cd();

  const meta = await getPkg(pkgName);

  const nestedNodeModules = `${meta.path}/node_modules`;

  // bail if there are no workspace deps
  if (!(await fsStatOrNull(nestedNodeModules))) {
    log1(`${lctx}No ws packages to sync`);
    return;
  }

  async function doSync() {
    log1(`${lctx}:syncing`);
    const delta = await Promise.all(
      Object.values(meta.crosslinks).map(async (cl) =>
        execWs(
          `rsync -av --delete ${cl.path}/dist/ ` +
            `${nestedNodeModules}/${cl.name}/dist`
        ).then((r) =>
          (r.match(/done([\s\S]*?)\n\n/)?.[1] ?? "")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .forEach((l) => log1(`${cl.name}: ${l} upserted`))
        )
      )
    );
    return delta;
  }

  doSync();

  if (watch) {
    const watcher = chokidar.watch([], {
      ignored: /node_modules/,
      persistent: true,
    });
    watcher.on("change", () => doSync());
    Object.values(meta.crosslinks).map(async (cl) => {
      const distPath = `${cl.path}/dist/`;
      log1(`watching dep: ${distPath}`);
      watcher.add(distPath);
    });
    return () => {
      watcher.close().then(() => log1(`${lctx}:end`));
    };
  } else log1(`${lctx}:end`);
}

/**
 * find workspace metadata by looking for the first package.json in the
 * directory tree, starting from the current directory, and moving up
 * until it finds either a workspaces field or a lerna.json file
 */
export async function findWorkspace() {
  while (findWorkspace.last === "loading") {
    log4("findWorkspace:loading");
    await sleep(300);
  }
  if (findWorkspace.last) {
    // log4("findWorkspace:cache-hit");
    return findWorkspace.last;
  }
  findWorkspace.last = "loading";

  log1("findWorkspace:init");
  let wsPath = process.cwd();
  let packageJsonF = null;
  let lernaJsonF = null;
  let workspaces = [];
  stepUpDir: while (wsPath !== "/") {
    log3("findWorkspace:try:", wsPath);
    packageJsonF = await getPkgJsonFile(`${wsPath}/package.json`, true);
    if (packageJsonF?.workspaces?.[0]) {
      workspaces = workspaces.concat(packageJsonF.workspaces);
    }
    if (packageJsonF) {
      lernaJsonF = await getJsonFile(`${wsPath}/lerna.json`, true);
      if (lernaJsonF?.json?.packages?.[0]) {
        workspaces = workspaces.concat(lernaJsonF.json.packages);
      }
    }
    if (workspaces.length) break stepUpDir;
    wsPath = pathNode.dirname(wsPath);
  }
  if (!workspaces.length) throw Error("No workspace root found");

  workspaces = [...new Set(workspaces)]; // de-dupe

  const lockFile = await findLockFile(wsPath, true);
  if (!lockFile.name) {
    throw Error("Workspace missing lock file");
  }
  if (lockFile.name !== "yarn.lock") {
    throw Error(
      `${lctx}:yarn-check:error:${pkgJsonF.name} has unsupported package manager with lockFile=${lockFile.name}`
    );
  }
  if (lockFile.yarnVersion === 1) {
    yarnBust.init(wsPath);
  }

  const ws = {
    /**
     * changes the cwd to the workspace root.
     */
    cd: () => {
      log4("findWorkspace:cd:" + wsPath);
      process.chdir(wsPath);
    },
    /**
     * the full path to the ws. tip: prefer using ws.cd() and relative paths instead
     * so logs are cleaner
     */
    path: wsPath,
    lockFile,
    /** resets the lock to the original state when first read */
    reset: () => lockFile.reset(),
    /** An array of workspaces = [...packageJson.workspaces, ...lernaJson.packages] */
    workspaces,
    yarnVersion: lockFile.yarnVersion,
  };
  findWorkspace.last = ws;
  log1("findWorkspace:" + wsPath);
  return ws;
}
findWorkspace.last = null;

/**
 * gets package metadata (aka getPkg) about a monorepo package by package name
 * and builds a cross-link dependency tree of package metadatas
 *
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
async function getPkg(pkgName) {
  if (!pkgName) throw Error("packageName is required");
  if (!pkgName.includes("/")) pkgName = `${domainDefault}/${pkgName}`;
  const lctx = `getPkg:${pkgName}`;
  log2(`${lctx}:start`);

  let cached = getPkg.cache[pkgName];
  while (cached?.loading) {
    await sleep(100);
    cached = getPkg.cache[pkgName];
  }
  if (cached) {
    log2(`${lctx}:cache-hit`);
    return cached;
  }

  getPkg.cache[pkgName] = { loading: true };

  const ws = await findWorkspace();
  ws.cd();

  // split the workspaces into 3 groups: with the package name, with wildcard, and the rest
  // based on best guess
  const wsGlobsWithPkgName = ws.workspaces.filter(
    (wsGlob) => pathNode.basename(wsGlob) === pathNode.basename(pkgName)
  );
  const wsGlobWilds = ws.workspaces.filter((wsGlob) => wsGlob.endsWith("*"));
  const wsGlobsRest = ws.workspaces.filter(
    (wsGlob) => !(wsGlob in wsGlobsWithPkgName) && !(wsGlob in wsGlobWilds)
  );

  let pkgJsonF;
  if (wsGlobsWithPkgName.length) {
    log4(`${lctx}:try-wsGlobsWithPkgName`, wsGlobsWithPkgName);
    pkgJsonF = (
      await Promise.all(
        wsGlobsWithPkgName.map((wsGlob) => findPkgByName(pkgName, wsGlob))
      )
    ).find((res) => res.name);
  }
  if (!pkgJsonF && wsGlobWilds.length) {
    log4(`${lctx}:try-wsGlobWilds`, wsGlobWilds);
    pkgJsonF = (
      await Promise.all(wsGlobWilds.map((p) => findPkgByName(pkgName, p)))
    ).find((res) => res.name);
  }
  if (!pkgJsonF && wsGlobsRest.length) {
    log4(`${lctx}:try-wsGlobsRest`, wsGlobsRest);
    pkgJsonF = (
      await Promise.all(wsGlobsRest.map((p) => findPkgByName(pkgName, p)))
    ).find((res) => res.name);
  }
  if (!pkgJsonF) throw Error(`${lctx}:no-match-found`);

  log4(`${lctx}:match on ${pkgJsonF.path}`);

  const crosslinksDirect = {};
  await Promise.all(
    Object.entries(pkgJsonF.dependencies || {})
      .filter(
        ([name, version]) =>
          name.startsWith(pkgJsonF.domain) &&
          (version === "*" || version === "workspace:*")
      )
      .map(async ([name]) => {
        crosslinksDirect[name] = await getPkg(name);
      })
  );
  log4(`${lctx}:crosslinksDirect`, Object.keys(crosslinksDirect));

  function flattenCrosslinks(crosslinks) {
    const flat = { ...crosslinks };
    for (const [name, meta] of Object.entries(crosslinks)) {
      flat[name] = meta;
      Object.assign(flat, flattenCrosslinks(meta.crosslinks));
    }
    return flat;
  }
  const crosslinks = flattenCrosslinks(crosslinksDirect);
  log4(`${lctx}:crosslinks`, Object.keys(crosslinks));

  const pkgPath = pathNode.dirname(pkgJsonF.path);
  const pkgPathAbs = pathNode.dirname(pkgJsonF.pathAbs);

  const lockFile = await findLockFile(pkgPath);
  if (lockFile.name && lockFile.name !== "yarn.lock") {
    throw Error(
      `${lctx}:yarn-check:error:${pkgJsonF.name} has unsupported package manager with lockFile=${lockFile.name}`
    );
  }
  if (lockFile.yarnVersion === 1) {
    yarnBust.init(pkgPathAbs);
  }

  // TODO: consider if root package has a dep on a cross-linked package

  const res = {
    ...pkgJsonF,
    /** dictionary of direct crosslinked packages */
    crosslinksDirect,
    /** dictionary of crosslinked packages, including nested */
    crosslinks,
    lockFile,
    pack: async () => {
      log2(`${lctx}:pack`);
      await execWs(
        `cd ${pkgPath} && ` +
          (lockFile.yarnVersion === 1
            ? `yarn pack -f package.tgz`
            : `yarn pack -o package.tgz`)
      );
    },
    /** path to the package */
    path: pkgPath,
    /** full path to the package */
    pathAbs: pkgPathAbs,
    /** resets package to original state so lerna is unaware of changes */
    reset: () => Promise.all([pkgJsonF.reset(), lockFile.reset()]),
    /**
     * removes crosslinks from the package.json file (and no other side-effects)
     * this is done ahead of adding ../{pkgName}/package.tgz to the package.json
     */
    rmCrosslinks: async () => {
      ws.cd();
      const regex = new RegExp(
        `"${pkgJsonF.domain}/[^:]+: "(workspace:\\*|\\*)",*`,
        "g"
      );
      const matches = pkgJsonF.text.match(regex);
      if (!matches) {
        log1(`${lctx}:rmCrosslinks:nothing-to-remove`);
        return;
      }
      const res = pkgJsonF.text.replace(regex, "");
      log1(`${lctx}:rmCrosslinks:${pkgPath}:`, matches);
      await fs.writeFile(pkgJsonF.pathAbs, res);
      backupToTmpDir(pkgJsonF.pathAbs, { text: res });
    },
    /** loading indicator for the cache */
    loading: false,
    yarnVersion: lockFile.yarnVersion,
  };
  getPkg.cache[pkgName] = res;
  log4(`${lctx}:end`);
  return res;
}
getPkg.cache = {};

/** find a package in wsGlob with package.json:name=pkgName */
async function findPkgByName(pkgName, wsGlob) {
  const lctx = `findPkgByName:${pkgName}:${wsGlob}`;

  log4(`${lctx}:start`);

  const ws = await findWorkspace();
  ws.cd();

  let jsonF = null;
  let tryPath = "";

  if (wsGlob.endsWith("*")) {
    log4(`${lctx}:wsGlob ends with *`);
    if (wsGlob.at(-2) !== "/") {
      throw Error(
        "Only wildcards with full directory are supported, ie 'packages/*' and not 'packages/foo*'"
      );
    }
    const globDirRoot = wsGlob.slice(0, -2);
    const globDirs = (await getReadDir(globDirRoot)).files;
    if (!globDirs) throw Error(`${lctx}:dir-not-found`);

    const pkgNameNoDomain = pkgName.split("/")[1];
    if (!pkgNameNoDomain)
      throw Error(`${lctx}:Package name must be format {domain}/{name}`);

    tryPath = `${globDirRoot}/${pkgNameNoDomain}`;
    log4(`${lctx}:try best guess = wsGlob + pkgNameNoDomain = ${tryPath}`);
    if (globDirs.includes(pkgNameNoDomain)) {
      jsonF = await getPkgJsonFile(`${tryPath}/package.json`);
      if (jsonF?.name === pkgName) {
        log4(`${lctx}:match-on-wildcard-path-guess`);
        return jsonF;
      }
    }

    log4(`${lctx}:else loop all folders in the wildcard path`);
    for (const pkgDir2 of globDirs) {
      tryPath = `${globDirRoot}/${pkgDir2}`;
      log4(`${lctx}:try ${tryPath}`);
      jsonF = await getPkgJsonFile(`${tryPath}/package.json`);
      if (jsonF?.name === pkgName) {
        log4(`${lctx}:match-on-wildcard-brute-force`);
        return jsonF;
      }
    }
  } else {
    log4(
      `${lctx}:wsglob doesn't have wildcard, so is a path to a package. Try it out`
    );
    log4(`${lctx}:try ${wsGlob}`);
    jsonF = await getPkgJsonFile(`${wsGlob}/package.json`);
    if (jsonF?.name === pkgName) {
      log4(`${lctx}:match-on-path`);
      return jsonF;
    }
  }
  log4(`${lctx}:no-match`);
  return null;
}

/** clear pkgNames from yarn v1 cache if yarn v1 */
async function yarnBust(pkg) {
  const clNames = Object.keys(pkg.crosslinks);
  log3(`yarnBust:${pkg.name}:`, clNames);

  if (pkg.yarnVersion !== 1) {
    log4("yarnBust:skip-bc-v2+");
    return;
  }

  if (!yarnBust.cacheDir) {
    await yarnBust.init(pkg.pathAbs);
  }
  while (yarnBust.cacheDir === "loading") {
    await sleep(300);
  }

  const cDir = yarnBust.cacheDir;

  const cPkgDirs = await fs.readdir(cDir);
  const toDelete = cPkgDirs.filter((cpd) =>
    clNames.some((n) => cpd.includes(n.replace("/", "-")))
  );
  await Promise.all(
    toDelete.map((cpd) => {
      log1(`yarnBust:rm:${cpd}`);
      return fs.rm(`${cDir}/${cpd}`, { force: true, recursive: true });
    })
  );
  log3("yarnBust:end");
}
yarnBust.cacheDir = null;
// this takes a second, so do proactively it in the background when we first find a yarn v1 pkg
yarnBust.init = async (pkgPath) => {
  while (yarnBust.cacheDir === "loading") {
    await sleep(300);
  }
  if (yarnBust.cacheDir) return yarnBust.cacheDir;
  yarnBust.cacheDir = "loading";

  log2("yarnBust:init");
  // cd to the package path so we can use the yarn cache dir command
  process.chdir(pkgPath);
  // This is one of the few places that we cd out of the workspace root, so we want to cd for as
  // short a time as possible, hence the wsCd function called several times.
  const wsCd = () =>
    findWorkspace.last?.path && process.chdir(findWorkspace.last.path);
  return execP("yarn cache dir").then((out) => {
    wsCd();
    yarnBust.cacheDir =
      out.split("\n").filter(Boolean)?.[0] ??
      throwError('Unexpected "yarn cache dir" output: ', { out });
    log2("yarnBust:cacheDir", yarnBust.cacheDir);
  });
};

/** get file list from cache or fs, or null */
async function getReadDir(path, skipCd) {
  const lctx = `getReadDir:${path}`;
  let cached = getReadDir.cache[path];
  while (cached?.loading) {
    await sleep(100);
    cached = getReadDir.cache[path];
  }
  if (cached) {
    log4(`${lctx}:cache-hit`);
    return cached;
  }

  log4(`${lctx}:start`);

  if (!skipCd) {
    const ws = await findWorkspace();
    ws.cd();
  }

  cached = getReadDir.cache[path] = {
    loading: true,
    path,
    files: null,
  };

  cached = getReadDir.cache[path] = {
    ...cached,
    loading: false,
    files: await fs.readdir(path).then(
      (p) => p.filter((p) => p !== ".DS_Store"),
      () => null
    ),
  };
  log4(`${lctx}:`, cached.files ? cached.files : "not found");
  return cached;
}
getReadDir.cache = {};

/** get file from cache or fs, or null */
async function getFile(path, skipCd) {
  let cached = getFile.cache[path];
  while (cached?.loading) {
    await sleep(100);
    cached = getFile.cache[pkgName];
  }
  if (cached) {
    log4(`getFile:cache-hit:${path}`);
    return cached;
  }

  if (!skipCd) {
    const ws = await findWorkspace();
    ws.cd();
  }
  const cwd = process.cwd() + "/";
  const pathAbs = path.includes(cwd) ? path : cwd + path;

  cached = getFile.cache[path] = {
    loading: true,
    path,
    pathAbs,
    reset: async () => {},
    text: null,
  };

  try {
    const text = await fs.readFile(path, "utf-8").catch(() => null);
    cached = getFile.cache[path] = {
      ...cached,
      loading: false,
      /** resets the file to the original state when first read */
      reset: async () => {
        if (text) {
          await backupToTmpDir(pathAbs, { moveInsteadOfCopy: true });
          await fs.writeFile(pathAbs, text);
        }
      },
      text,
    };
  } catch (e) {
    cached = getFile.cache[path].loading = false;
  }
  log4(`readFile:${cached.text ? "found" : "not-found"}:${path}`);

  if (cached.text) {
    backupToTmpDir(pathAbs, { text: cached.text }); // no need to await
  }

  return cached;
}
getFile.cache = {};
getFile.resetAll = () => {
  log1("getFile:resetAll");
  return Promise.all(Object.values(getFile.cache).map((c) => c.reset()));
};

/** finds the yarn.lock, package-json.lock, or pnpm-lock.json in pkgPath with workspace root fallback */
async function findLockFile(pkgPath) {
  let cached = findLockFile.cache[pkgPath];
  while (cached?.loading) {
    await sleep(100);
    cached = findLockFile.cache[pkgPath];
  }
  if (cached) {
    log4(`findLockFile:cache-hit:${pkgPath}`);
    return cached;
  }

  cached = findLockFile.cache[pkgPath] = {
    loading: true,
    name: null,
    path: null,
    pathAbs: null,
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
    rfRes = await getFile(path, true);
    if (rfRes.text) break;
  }
  if (rfRes.text) {
    cached = findLockFile.cache[pkgPath] = {
      ...cached,
      loading: false,
      name: lockFileName,
      path,
      pathAbs: rfRes.pathAbs,
      reset: rfRes.reset,
      text: rfRes.text,
      yarnVersion: rfRes.text.includes("yarn lockfile v1") ? 1 : 2,
    };
  } else if (findWorkspace.last?.lockFile) {
    cached = findLockFile.cache[pkgPath] = findWorkspace.last?.lockFile;
  } else {
    cached = findLockFile.cache[pkgPath] = {
      ...cached,
      loading: false,
    };
  }
  return cached;
}
findLockFile.cache = {};

/** get package json from cache or file, or null */
async function getJsonFile(path, skipCd) {
  let cached = getJsonFile.cache[path];
  while (cached?.loading) {
    await sleep(100);
    cached = getJsonFile.cache[path];
  }
  if (cached) {
    log4(`getJsonFile:cache-hit:${path}`);
    return cached;
  }

  cached = getJsonFile.cache[path] = {
    loading: true,
    json: null,
    path,
    pathAbs: null,
    reset: async () => {},
    text: null,
  };

  const rfRes = await getFile(path, skipCd);
  if (rfRes.text) {
    cached = getJsonFile.cache[path] = {
      ...cached,
      ...rfRes,
      loading: false,
      json: JSON.parse(rfRes.text),
    };
  } else {
    cached = getJsonFile.cache[path] = {
      ...cached,
      loading: false,
    };
  }
  return cached;
}
getJsonFile.cache = {};

/** wrapper for getJsonFile with convenience and better typing */
async function getPkgJsonFile(path, skipCd) {
  const jsonF = await getJsonFile(path, skipCd);
  const [domain, nameNoDomain] = jsonF?.json?.name?.split("/") ?? [];
  return {
    ...jsonF,
    name: jsonF?.json?.name,
    domain,
    nameNoDomain,
    dependencies: jsonF?.json?.dependencies,
    devDependencies: jsonF?.json?.devDependencies,
    workspaces: jsonF?.json?.workspaces,
  };
}

async function fsStatOrNull(path) {
  return fs.stat(path).catch(() => null);
}

async function execP(...execArgs) {
  execP.count = (execP.count ?? 0) + 1;
  const lctx = `execP:${execP.count}`;
  log2(`${lctx}:${execArgs[0]}`, ...execArgs.slice(1));
  const res = await util.promisify(exec)(...execArgs);
  const stdout = (res.stdout || res.stderr)
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      log2(`${lctx}:${l.replace(new RegExp(process.cwd(), "g"), "{ws}")}`);
      return l;
    })
    .join("\n");
  if (!stdout) {
    log2(`${lctx}:none`);
  }

  log3(`${lctx}:end`);
  return stdout;
}
execP.count = 0;

/** wrapper for execP that ws.cd()'s first. Is safer. */
async function execWs(...execArgs) {
  const ws = await findWorkspace();
  ws.cd();
  return execP(...execArgs);
}

/**
 * Backups files for debugging and troubleshooting purposes
 * to: `/tmp/lerna-fix-deps/${timestamp}`
 */
async function backupToTmpDir(path, options) {
  const { text = null, moveInsteadOfCopy = false } = options;

  const tmpDir = await getTmpDir();

  let backupPath =
    `${tmpDir}/` +
    path
      .replace(findWorkspace.last?.path ?? "", "")
      .slice(1)
      .replace(/\//g, ".") +
    "-" +
    new Date().toISOString().slice(11, -2).replace(/:/g, ".");

  if (text) {
    await fs.writeFile(backupPath, text);
  } else if (moveInsteadOfCopy) {
    await fs.rename(path, backupPath);
  } else {
    await fs.copyFile(path, backupPath);
  }
}

async function getTmpDir() {
  while (getTmpDir.last === "loading") {
    await sleep(300);
  }
  if (getTmpDir.last) return getTmpDir.last;
  getTmpDir.last = "loading";
  const ts = new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/(\-|T|:)/g, ".");
  const tmpDir = `/tmp/lerna-fix-deps/${ts}`;
  log1(`getTmpDir:${tmpDir}`);
  return execP(`mkdir -p ${tmpDir}`).then(
    () => (getTmpDir.last = tmpDir),
    (e) => {
      log1(`getTmpDir:error`, e);
      throw Object.assign(e, { context: `getTmpDir:error` });
    }
  );
}
getTmpDir.purge = async () => {
  log2("getTmpDir:purge");
  await fs.rm(getTmpDir.last, { recursive: true, force: true });
  getTmpDir.last = null;
};

function logn(n) {
  getTmpDir();
  return (...args) => {
    const argsExtra = [
      // print a human timestamp with ms
      new Date().toISOString().slice(11, -2),
      `L${n}`,
      ...args,
    ];
    if (logLevel >= n) {
      if (logLevel <= 1) console.log(...args);
      else console.log(...argsExtra);
    }
    getTmpDir().then((tmpDir) =>
      fs.appendFile(
        `${tmpDir}/run.log`,
        argsExtra
          .map((a) =>
            ["string", "number"].includes(typeof a)
              ? a
              : JSON.stringify(a, null, 2) + "\n"
          )
          .join(" ") + "\n"
      )
    );
    return args;
  };
}
function log1(...args) {
  return logn(1)(...args);
}
function log2(...args) {
  return logn(2)(...args);
}
function log3(...args) {
  return logn(3)(...args);
}
function log4(...args) {
  return logn(4)(...args);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function throwError(message, ...extra) {
  const e = new Error(message);
  e.extra = extra;
  Object.assign(e, extra);
  throw e;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(...process.argv.slice(2));
}
