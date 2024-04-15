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
  log1(
    `fixDeps:start:${minimalBuilds ? "minimal-build" : "full-build"}:${pkgName}`
  );

  const ws = await findWorkspace();
  ws.cd();
  const meta = await gpm(pkgName);

  // bootstrap if not already
  if (!(await fsStatOrNull(`${meta.path}/node_modules`))) {
    log1("bootstrapping");
    await execP(
      `yarn lerna bootstrap --scope=${meta.name} --include-dependencies`
    );
  }

  // bail if there are no workspace deps
  if (!Object.keys(meta.crosslinks).length) {
    log1("No cross-links to fix");
    return;
  }

  const pkgMetasToBundle = { [meta.name]: meta, ...meta.crosslinks };
  log1("fixDeps:bundler:todos:", Object.keys(pkgMetasToBundle));

  await Promise.all(
    Object.values(pkgMetasToBundle).map(async (pmtb) => {
      while (Object.keys(pmtb.crosslinks).some((l) => l in pkgMetasToBundle)) {
        await sleep(100);
      }
      await fixDeps.apply(pmtb, minimalBuilds ? pmtb.name !== meta.name : true);
      delete pkgMetasToBundle[pmtb.name];
    })
  );

  log1("fixDeps:end");
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
  log2(`${pkgMeta.name}:bundler:start`);

  const ws = await findWorkspace();
  ws.cd();
  const m = pkgMeta;

  if (Object.keys(m.crosslinks).length) {
    log2(`${pkgMeta.name}:bundler:fixing: `, Object.keys(m.crosslinks));
    await Promise.all(
      Object.keys(m.crosslinks).map((cname) =>
        fs.rm(`${m.path}/node_modules/${cname}`, {
          recursive: true,
          force: true,
        })
      )
    );
    await execP(
      `cd ${m.path}; yarn add ${Object.values(m.crosslinks)
        .map((cm) => `${ws.dir}/${cm.path}/package.tgz`)
        .join(" ")};`
    );
    await Promise.all([
      // remove cross-links bc yarn add creates nested symlinks which we don't
      // need or want bc we install them as file dependencies
      execP(`find ${m.path}/node_modules/${m.domain} -type l -delete`),
      // restore the original files
      m.reset(),
    ]);
  }

  if (build) {
    // now build it with nx and pack to package.tgz
    await execP(`nx build ${m.name}`);
    await execP(`cd ${m.path}; yarn pack`);
  }
  log2(`${pkgMeta.name}:bundler:end`);
};

export async function unfixDeps(packageName) {
  log1("unfixDeps:start", packageName);

  const ws = await findWorkspace();
  ws.cd();

  const meta = await gpm(packageName);

  // bail if there are no workspace deps
  if (!Object.keys(meta.crosslinks).length) {
    log2("No cross-links to fix");
    return;
  }

  const pkgMetasToUnfix = { [meta.name]: meta, ...meta.crosslinks };
  log1("unfixDeps:bundler:todos:", Object.keys(pkgMetasToUnfix));

  await Promise.all(
    Object.values(pkgMetasToUnfix).map((pmtu) => {
      log2(`rm ${pmtu.path}/node_modules`);
      return fs.rm(`${pmtu.path}/node_modules`, {
        recursive: true,
        force: true,
      });
    })
  );

  await execP(
    `yarn lerna bootstrap --scope=${meta.json.name} --include-dependencies`
  );

  log2("unfixDeps:end", packageName);
}

/**
 * syncs the dist folders of all workspace deps in the packagePath
 */
export async function rsyncDists(pkgName, watch = false) {
  log1("resyncDists:start", pkgName, watch);

  const ws = await findWorkspace();
  ws.cd();

  const meta = await gpm(pkgName);

  const nestedNodeModules = `${meta.path}/node_modules`;

  // bail if there are no workspace deps
  if (!(await fsStatOrNull(nestedNodeModules))) {
    log1("No ws packages to sync");
    return;
  }

  async function doSync() {
    const delta = await Promise.all(
      Object.values(meta.crosslinks).map(async (cl) =>
        execP(
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
      watcher.close().then(() => log1("resyncDists:end"));
    };
  } else log1("resyncDists:end");
}

/**
 * find workspace metadata by looking for the first package.json in the
 * directory tree, starting from the current directory, and moving up
 * until it finds either a workspaces field or a lerna.json file
 */
export async function findWorkspace() {
  if (findWorkspace.last) return findWorkspace.last;
  let dir = process.cwd();
  let packageJson = null;
  let lernaJson = null;
  let workspaces = [];
  stepUpDir: while (dir !== "/") {
    log2("findWorkspace:try:", dir);
    packageJson = await readJsonFile(`${dir}/package.json`, true);
    if (packageJson?.workspaces?.[0]) {
      workspaces = workspaces.concat(packageJson.workspaces);
    }
    if (packageJson) {
      lernaJson = await readJsonFile(`${dir}/lerna.json`, true);
      if (lernaJson?.packages?.[0]) {
        workspaces = workspaces.concat(lernaJson.packages);
      }
    }
    if (workspaces.length) break stepUpDir;
    dir = pathNode.dirname(dir);
  }
  if (!workspaces.length) throw Error("No workspace root found");

  workspaces = [...new Set(workspaces)]; // de-dupe

  const lockFile = await findLockFile(dir, true);
  if (!lockFile.path) {
    throw Error("Workspace missing lock file");
  }

  const ws = {
    /**
     * changes the cwd to the workspace root.
     */
    cd: () => process.chdir(ws.dir),
    /**
     * the full path to the ws. tip: prefer using ws.cd() and relative paths instead
     * so logs are cleaner
     */
    dir,
    /** resets the lock to the original state when first read */
    reset: () => lockFile.reset(),
    /** An array of workspaces = [...packageJson.workspaces, ...lernaJson.packages] */
    workspaces,
  };
  findWorkspace.last = ws;
  log2("ws: " + dir);
  return ws;
}
findWorkspace.last = null;

/**
 * gets package metadata (aka gpm) about a monorepo package by package name
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
 *   - key: package name, value: gpm(packageName)
 * - Heavy caching for speed
 */
async function gpm(pkgName) {
  if (!pkgName) throw Error("packageName is required");
  if (!pkgName.includes("/")) pkgName = `${domainDefault}/${pkgName}`;
  const logPrefix = `gpm:${pkgName}`;
  log2(`${logPrefix}:start`);
  let cached = gpm.cache[pkgName];
  if (cached?.loading) {
    await cached?.loading;
    cached = gpm.cache[pkgName];
  }
  if (cached) return cached;

  gpm.cache[pkgName] = { loading: true };

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

  let match;
  if (wsGlobsWithPkgName.length) {
    log4(`${logPrefix}:try`, wsGlobsWithPkgName);
    match = (
      await Promise.all(
        wsGlobsWithPkgName.map((wsGlob) => gpm.findPkgByName(pkgName, wsGlob))
      )
    ).find(Boolean);
  }
  if (!match && wsGlobWilds.length) {
    log4(`${logPrefix}:try`, wsGlobWilds);
    match = (
      await Promise.all(wsGlobWilds.map((p) => gpm.findPkgByName(pkgName, p)))
    ).find(Boolean);
  }
  if (!match && wsGlobsRest.length) {
    log4(`${logPrefix}:try`, wsGlobsRest);
    match = (
      await Promise.all(wsGlobsRest.map((p) => gpm.findPkgByName(pkgName, p)))
    ).find(Boolean);
  }
  if (!match) throw Error(`${logPrefix}:no-match-found`);

  const [domain, afterDomain] = pkgName.split("/");
  if (!afterDomain) throw Error(`${logPrefix}:Package name must have a domain`);

  const { json, path } = match;
  log4(`${logPrefix}:match on ${path}`);

  const crosslinksDirect = {};
  await Promise.all(
    Object.entries(json.dependencies || {})
      .filter(
        ([name, version]) =>
          name.startsWith(domain) &&
          (version === "*" || version === "workspace:*")
      )
      .map(async ([name]) => {
        crosslinksDirect[name] = await gpm(name);
      })
  );

  function flattenCrosslinks(crosslinks) {
    const flat = { ...crosslinks };
    for (const [name, meta] of Object.entries(crosslinks)) {
      flat[name] = meta;
      Object.assign(flat, flattenCrosslinks(meta.crosslinks));
    }
    return flat;
  }
  const crosslinks = flattenCrosslinks(crosslinksDirect);

  const lockfile = await findLockFile(path);

  const res = {
    /** dictionary of direct crosslinked packages */
    crosslinksDirect,
    /** dictionary of crosslinked packages, including nested */
    crosslinks,
    /** domain of json.name = {domain}/{name} */
    domain,
    /** full json of package.json */
    json,
    /** resets package to original state */
    reset: () =>
      Promise.all([
        resetFileFromCache(`${path}/package.json`),
        // if local no lockfile, rset the workspace lockfile
        lockfile.path ? lockfile.reset() : ws.reset(),
      ]),
    /** loading indicator for the cache */
    loading: false,
    /** name = json.name */
    name: json.name,
    /** path to the package rel to ws */
    path,
  };
  gpm.cache[pkgName] = res;
  return res;
}
gpm.cache = {};
/** compare the pkgName with the name in pkgPath/package.json  */
gpm.findPkgByName = async (pkgName, wsGlob) => {
  const logPrefix = `findPkgByName:${pkgName}:${wsGlob}`;
  log4(`${logPrefix}:start`);

  const ws = await findWorkspace();
  ws.cd();

  /** Parsed json */
  let json = "";
  /** Path to the package */
  let path = "";

  if (wsGlob.endsWith("*")) {
    log4(`${logPrefix}:wsGlob ends with *`);
    if (wsGlob.at(-2) !== "/") {
      throw Error(
        "Only wildcards with full directory are supported, ie 'packages/*' and not 'packages/foo*'"
      );
    }
    const pkgsDir = wsGlob.slice(0, -2);
    path = `${pkgsDir}/${pkgName.split("/")[1]}`;
    log4(`${logPrefix}:try ${path}`);
    json = await readJsonFile(`${path}/package.json`);
    if (json?.name === pkgName) {
      log4(`${logPrefix}:match-on-wildcard-path-guess`);
      return { json, path };
    }
    log4(`${logPrefix}:else loop all folders in the wildcard path`);
    // TODO: cache readdir
    for (const pkgDir2 of await fs.readdir(pkgsDir)) {
      path = `${pkgsDir}/${pkgDir2}`;
      log4(`${logPrefix}:try ${path}`);
      json = await readJsonFile(`${path}/package.json`);
      if (json?.name === pkgName) {
        log4(`${logPrefix}:match-on-wildcard-brute-force`);
        return { json, path };
      }
    }
  } else {
    log4(
      `${logPrefix}:wsglob doesn't have wildcard, so is a path to a package. Try it out`
    );
    path = wsGlob;
    log4(`${logPrefix}:try ${path}`);
    json = await readJsonFile(`${path}/package.json`);
    if (json?.name === pkgName) {
      log4(`${logPrefix}:match-on-path`);
      return { json, path };
    }
  }
  log4(`${logPrefix}:no-match`);
  return null;
};

/** get package json from cache or file, or null */
async function readFile(path, skipCd) {
  let cached = readFile.cache[path];
  if (!cached) {
    try {
      if (!skipCd) {
        const ws = await findWorkspace();
        ws.cd();
      }
      cached = await fs.readFile(path, "utf-8");
    } catch (e) {}
    log4("readFile", path, cached ? "found" : "not found");
    readFile.cache[path] = cached;
  }
  return cached;
}
readFile.cache = {};

async function resetFileFromCache(path) {
  const ws = await findWorkspace();
  ws.cd();
  await fs.writeFile(
    path,
    readFile.cache[path] ?? throwError(`no cache for file "${path}"`)
  );
}

/** finds the yarn.lock, package-json.lock, or pnpm-lock.json in pkgPath */
async function findLockFile(pkgPath, skipCd) {
  if (findLockFile.cache[pkgPath]) {
    return findLockFile.cache[pkgPath];
  }
  if (!skipCd) {
    const ws = await findWorkspace();
    ws.cd();
  }
  let path = "";
  let contents = "";
  const lockFileNames = ["yarn.lock", "package-lock.json", "pnpm-lock.yaml"];
  for (const lockFileName of lockFileNames) {
    path = `${pkgPath}/${lockFileName}`;
    contents = await readFile(path, true);
    if (contents) break;
  }
  const res = {
    path: contents ? path : null,
    /**  */
    reset: () => contents && fs.writeFile(path, contents),
  };
  findLockFile.cache[pkgPath] = res;
  return res;
}
findLockFile.cache = {};

/** get package json from cache or file, or null */
async function readJsonFile(path, skipCd) {
  let cached = readJsonFile.cache[path];
  if (!cached) {
    const raw = await readFile(path, skipCd);
    let json = null;
    if (raw) json = JSON.parse(raw);
    const res = {
      json,
      /** resets the package.json to the original state when first read */
      reset: () => fs.writeFile(path, raw),
    };
    readJsonFile.cache[path] = json;
    return json;
  }
}
readJsonFile.cache = {};

async function fsStatOrNull(path) {
  return fs.stat(path).catch(() => null);
}

async function execP(...execArgs) {
  log2("execP:start", ...execArgs);
  const { stdout } = await util.promisify(exec)(...execArgs);
  log3("\nexecP:STDOUT\n", stdout + "\nENDSTDOUT");
  log3("execP:end");
  return stdout;
}

const logn = (n) =>
  logLevel >= n
    ? (...args) => {
        if (logLevel <= 1) console.log(...args);
        else
          console.log(
            // print a human timestamp with ms
            new Date().toISOString().slice(11, -2),
            ...args
          );
      }
    : () => {};
const log1 = logn(1);
const log2 = logn(2);
const log3 = logn(3);
const log4 = logn(4);

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
