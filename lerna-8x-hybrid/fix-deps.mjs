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
 *  - This cwd is somewhere inside a yarn ws
 *  - The ws root has a yarn.lock file
 *  - The ws root has a package.json with a workspaces field
 *  - Workspace packages have a name field with a domain, ie @app/packageName
 *  - Using lerna+nx package manager
 */

import { exec } from "child_process";
import { promises as fs } from "fs";
import pathNode from "path";
import util from "util";
import chokidar from "chokidar";

const defaultDomain = "@app";

async function main(packageName, action) {
  const usage = `
  Usage: [DEBUG=1] node fix-deps.mjs {packageName} {action}

  DEBUG=1: enables debug logs

  Actions:
  init:
    - re-installs cross-linked packages as if they were
      file dependencies and builds them, bottom-up
    - bottom-up: builds a dep tree of cross-linked packages
      and processes them in order of dependencies, so that
      build artifacts are ready for dependents
    - resets the package.json and yarn.lock files so that
      lerna+nx are unaware
  un-init: undoes the changes made by init
  re-init: un-inits and then re-inits
  build: init + build 
  reset: reverts the changes made by init
  sync: rsyncs the dist folders of all cross-linked packages
  watch: sync with watch mode
  `;
  if (!packageName) return log1(usage);
  switch (action) {
    case "init":
      await fixDeps(packageName);
      break;
    case "un-init":
      await unfixDeps(packageName);
      break;
    case "re-init":
      await unfixDeps(packageName);
      await fixDeps(packageName);
      break;
    case "build":
      await fixDeps(packageName, { minimalBuilds: false });
      break;
    case "sync":
      await rsyncDists(packageName);
      break;
    case "watch":
      await rsyncDists(packageName, true);
      break;
    default:
      return log1(usage);
  }
}

/**
 * fixDeps:
 * - re-installs cross-linked packages as if they were
 *   file dependencies and builds them, bottom-up
 * - bottom-up: builds a dep tree of cross-linked packages
 *   and processes them in order of dependencies, so that
 *   build artifacts are ready for dependents
 * - resets the package.json and yarn.lock files so that
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
    `fixDeps:start:${
      minimalBuilds ? "minimal-build" : "full-build"
    }: ${pkgName}`
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
 * - resets the package.json and yarn.lock files so that
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
      m.jsonReset(),
      ws.lockReset(),
    ]);
  }

  if (build) {
    // now build it with nx
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

  const wsDepPath = `${meta.path}/node_modules/${meta.domain}`;

  // bail if there are no workspace deps
  if (!(await fsStatOrNull(wsDepPath))) {
    log1("No ws packages to sync");
    return;
  }

  async function doSync() {
    const delta = await Promise.all(
      meta.crosslinks.map(async (crosslink) =>
        execP(
          `rsync -av --delete packages/${crosslink}/dist/ ` +
            `${wsDepPath}/${crosslink}/dist`
        ).then((r) =>
          (r.match(/done([\s\S]*?)\n\n/)?.[1] ?? "")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .forEach((l) => console.log(`${crosslink}: ${l} upserted`))
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
    for (const l of wsDeps) {
      const distPath = `packages/${l}/dist`;
      log1(`watching dep: ${ws.domain}/${l}/dist`);
      watcher.add(distPath);
    }
    return () => {
      watcher.close().then(() => log1("resyncDists:end"));
    };
  } else log1("resyncDists:end");
}

/**
 * find workspace metadata by looking for the nearest yarn.lock file, reading the
 * corresponding package.json, and verifying it has a workspaces field
 */
export async function findWorkspace() {
  if (findWorkspace.last) return findWorkspace.last;
  let dir = process.cwd();
  let packageJsonRaw = "";
  let packageJson = {};
  while (dir !== "/") {
    if (await fsStatOrNull(`${dir}/yarn.lock`)) {
      packageJsonRaw = await fs.readFile(`${dir}/package.json`, "utf-8");
      packageJson = JSON.parse(packageJsonRaw);
      if (packageJson.workspaces) break;
    }
    dir = pathNode.dirname(dir);
  }
  if (dir === "/") throw Error("No workspace root found");

  const wsPackage = packageJson.workspaces?.[0];
  if (!wsPackage) throw Error("No workspace packages");

  const lock = await fs.readFile(`${dir}/yarn.lock`, "utf-8");

  const ws = {
    cd: () => process.chdir(ws.dir),
    dir,
    lockReset: () => fs.writeFile(`${dir}/yarn.lock`, lock),
    json: packageJson,
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
  if (!pkgName.includes("/")) pkgName = `${defaultDomain}/${pkgName}`;
  log2("gpm:start", pkgName);
  let cached = gpm.cache[pkgName];
  if (cached?.loading) {
    await cached?.loading;
    cached = gpm.cache[pkgName];
  }
  if (cached) return cached;

  gpm.cache[pkgName] = { loading: true };

  const ws = await findWorkspace();
  ws.cd();

  log4("try workspaces which have the name in the path");
  let match = (
    await Promise.all(
      ws.json.workspaces
        .filter(
          (pkgPath) => pathNode.basename(pkgPath) === pathNode.basename(pkgName)
        )
        .map((pkgPath) => gpm.findPkgByName(pkgName, pkgPath))
    )
  ).find(Boolean);
  if (!match) {
    log4("else try the rest");
    match = (
      await Promise.all(
        ws.json.workspaces
          .filter(
            (pkgPath) =>
              pathNode.basename(pkgPath) !== pathNode.basename(pkgName)
          )
          .map((p) => gpm.findPkgByName(pkgName, p))
      )
    ).find(Boolean);
    if (!match) throw Error(`Package ${pkgName} not found in workspaces`);
  }

  const [domain, afterDomain] = pkgName.split("/");
  if (!afterDomain) throw Error("Package name must have a domain");

  const { json, path } = match;
  log4("match", path);

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

  const res = {
    /** dictionary of direct crosslinked packages */
    crosslinksDirect,
    /** dictionary of crosslinked packages, including nested */
    crosslinks,
    /** domain of json.name = {domain}/{name} */
    domain,
    /** full json of package.json */
    json,
    /** reset json file back to original state */
    jsonReset: () =>
      fs.writeFile(
        `${ws.dir}/${path}/package.json`,
        gpm.packageJsonCache[path]?.raw ??
          throwError(`missing package.json cache for ${path}`)
      ),
    /** loading indicator for the cache */
    loading: false,
    /** name = json.name */
    name: json.name,
    /** path to the package rel to ws */
    path,
  };
  gpm.cache[pkgName] = res;
  log4("gpm:end", res);
  return res;
}
gpm.cache = {};
/** get package json from cache or file */
gpm.getPackageJson = async (pathToPackage) => {
  let cached = gpm.packageJsonCache[pathToPackage];
  if (!cached) {
    try {
      const ws = await findWorkspace();
      ws.cd();
      const raw = await fs.readFile(`${pathToPackage}/package.json`, "utf-8");
      const json = JSON.parse(raw);
      gpm.packageJsonCache[pathToPackage] = { json, raw };
      return json;
    } catch (e) {
      return { name: "" };
    }
  }
};
gpm.packageJsonCache = {};
/** compare the pkgName with the name in pkgPath/package.json  */
gpm.findPkgByName = async (pkgName, wsGlob) => {
  log4("findPkgByName", pkgName, wsGlob);

  const ws = await findWorkspace();
  ws.cd();

  /** Parsed json */
  let json = "";
  /** Path to the package */
  let path = "";

  if (wsGlob.endsWith("*")) {
    const pkgsDir = pathNode.dirname(wsGlob);
    log4("if a wildcard path includes name, try that one first");
    path = `${pkgsDir}/${pkgName}`;
    json = await getPackageJson(path);
    if (json?.name === pkgName) {
      return { json, path: path };
    }
    log4("else loop all folders in the wildcard path");
    for (const pkgDir2 of await fs.readdir(pkgsDir)) {
      path = `${pkgsDir}/${pkgDir2}`;
      json = await getPackageJson(path);
      if (json?.name === pkgName) {
        return { json, path };
      }
    }
  } else {
    log4("else is a path to a package. Try it out");
    path = wsGlob;
    json = await gpm.getPackageJson(path);
    if (json?.name === pkgName) {
      return { json, path };
    }
  }
  log4("findPkgByName", pkgName, wsGlob);
  return null;
};

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

const logLevel = parseInt(process.env.LOG || "1");
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
