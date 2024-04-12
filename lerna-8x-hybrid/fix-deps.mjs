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
  Usage: [DEBUG=1] node fix-deps.mjs {packageName} {init|reset|sync|watch}

  DEBUG=1: enables debug logs
  init: re-installs cross-linked packages as if they were file dependencies without side-effects
  reset: reverts the changes made by init
  sync: syncs the dist folders of all cross-linked packages in a package
  watch: sync with watch mode
  `;
  if (!packageName) return console.error(usage);
  switch (action) {
    case "init":
      await fixDeps(packageName);
      break;
    case "reset":
      await unfixDeps(packageName);
      break;
    case "sync":
      await rsyncDists(packageName);
      break;
    case "watch":
      await rsyncDists(packageName, true);
      break;
    default:
      console.error(usage);
  }
}

/**
 * Re-installs cross-linked packages as if they were file dependencies without side-effects
 *
 * aka deps, builds, and packs the dependencies of a package by name, while respecting topology
 */
export async function fixDeps(
  /** the full name of a package including domain, or short if using default domain */
  pkgName
) {
  console.debug(`fixDeps:start: ${pkgName}`);

  if (!pkgName) throw Error("packageName is required");

  if (!pkgName.includes("/")) pkgName = `${defaultDomain}/${pkgName}`;

  const meta = await gpm(pkgName);

  // bootstrap if not already
  if (!(await fsStatOrNull(`${meta.path}/node_modules`))) {
    console.debug("bootstrapping");
    await execP(
      `yarn lerna bootstrap --scope=${meta.name} --include-dependencies`
    );
  }

  // bail if there are no workspace deps
  if (!Object.keys(meta.crosslinks).length) {
    console.debug("No cross-links to fix");
    return;
  }

  const pkgMetasToBundle = Object.values({ meta, ...meta.crosslinks });
  console.debug("fixDeps:bundler:todos:", Object.keys(pkgMetasToBundle));

  await Promise.all(
    Object.values(pkgMetasToBundle).map(async (pmtb) => {
      while (Object.keys(pmtb.crosslinks).some((l) => l in pkgMetasToBundle)) {
        await sleep(100);
      }
      await fixDeps.bundlePackage(pmtb, pmtb.name === meta.name);
      delete pkgMetasToBundle[pmtb.name];
    })
  );

  console.debug("fixDeps:end");
}
fixDeps.bundlePackage = async (pkgMeta, skipBuild = false) => {
  console.debug(`${pkgMeta.name}:bundler:start`);
  const m = pkgMeta;
  if (Object.keys(m.crosslinks).length) {
    console.debug(`${pkgMeta.name}:bundler:rm: `, Object.keys(m.crosslinks));
    await Promise.all(
      Object.keys(m.crosslinks).map((cname) =>
        fs.rm(`${m.path}/node_modules/${cname}`, {
          recursive: true,
          force: true,
        })
      )
    );
    console.debug(
      `${pkgMeta.name}:bundler:install: `,
      Object.keys(m.crosslinks)
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

  if (!skipBuild) {
    // now build it with nx
    await execP(`nx build ${m.name}`);
    await execP(`cd ${m.path}; yarn pack`);
  }
  console.debug(`${pkgMeta.name}:bundler:end`);
};

/** gets package metadata (aka gpm) about a monorepo package by package name */
async function gpm(pkgName) {
  console.debug("gpm:start", pkgName);
  let cached = gpm.cache[pkgName];
  if (cached?.loading) {
    await cached?.loading;
    cached = gpm.cache[pkgName];
  }
  if (cached) return cached;

  gpm.cache[pkgName] = { loading: true };

  const ws = await findWorkspace();

  console.debug("try workspaces which have the name in the path");
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
    console.debug("else try the rest");
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

  const crosslinksDirect = {};
  await Promise.all(
    Object.entries(json.dependencies || {})
      .filter(
        ([name, version]) =>
          name.startsWith(domain) &&
          (version === "*" || version === "workspace:*")
      )
      .map(async ([jsonName]) => {
        const name = jsonName.split("/")[1];
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
        gpm.packageJsonCache[pathToPackage]?.raw ??
          throwError(`missing package.json cache for ${path}`)
      ),
    /** loading indicator for the cache */
    loading: false,
    /** dirname of the package path */
    dirname,
    /** name = json.name */
    name: json.name,
    /** path to the package rel to ws */
    path,
    /** raw contents of package.json as text */
    raw,
  };
  gpm.cache[pkgName] = res;
  console.debug("gpm:end", pkgName);
  return res;
}
gpm.cache = {};
/** get package json from cache or file */
gpm.getPackageJson = async (pathToPackage) => {
  let cached = gpm.packageJsonCache[pathToPackage];
  if (!cached) {
    try {
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
  console.debug("findPkgByName", pkgName, wsGlob);
  /** Parsed json */
  let json = "";
  /** Path to the package */
  let path = "";

  if (wsGlob.endsWith("*")) {
    const pkgsDir = path.dirname(wsGlob);
    // if a wildcard path includes name, try that one first
    path = `${pkgsDir}/${pkgName}`;
    json = await getPackageJson(path);
    if (json?.name === pkgName) {
      return { json, path: path };
    }
    // else loop all folders in the wildcard path
    for (const pkgDir2 of await fs.readdir(pkgsDir)) {
      path = `${pkgsDir}/${pkgDir2}`;
      json = await getPackageJson(path);
      if (json?.name === pkgName) {
        return { json, path };
      }
    }
  } else {
    // else is a path to a package. Try it out
    path = wsGlob;
    json = await gpm.getPackageJson(path);
    console.log("json", json, pkgName, path);
    if (json?.name === pkgName) {
      return { json, path };
    }
  }
  return null;
};

export async function unfixDeps(packageName) {
  console.debug("unfixDeps-start");

  packageName || throwError("packageName is required");

  const ws = await findWorkspace();
  ws.cd();

  const meta = await gpm(packageName);

  await execP(
    `yarn lerna exec --scope=${meta.json.name} --include-dependencies -- rm -rf node_modules/${ws.domain}`
  );

  await execP(
    `yarn lerna bootstrap --scope=${meta.json.name} --include-dependencies`
  );

  console.debug("unfixDeps-end");
}

// syncs the dist folders of all workspace deps in the packagePath
export async function rsyncDists(packageName, watch = false) {
  console.debug("resyncDists-start", packageName);

  packageName || throwError("packageName is required");

  const ws = await findWorkspace();
  ws.cd();

  const meta = await gpm(packageName);

  const wsDepPath = `${meta.path}/node_modules/${meta.domain}`;

  // bail if there are no workspace deps
  if (!(await fsStatOrNull(wsDepPath))) {
    console.debug("No ws packages to sync");
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
      // ignored: /node_modules/,
      persistent: true,
    });
    watcher.on("change", () => doSync());
    for (const l of wsDeps) {
      const distPath = `packages/${l}/dist`;
      console.log(`watching dep: ${ws.domain}/${l}/dist`);
      watcher.add(distPath);
    }
    return () => {
      watcher.close().then(() => console.log("watching ended"));
      console.debug("resyncDists-end");
    };
  }
}

// find workspace root dir by looking for the nearest yarn.lock file and checking if it has a workspaces field
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
    dir = path.dirname(dir);
  }
  if (dir === "/") throwError("No workspace root found");

  const wsPackage = packageJson.workspaces?.[0];
  if (!wsPackage) throwError("No workspace packages");

  const lock = await fs.readFile(`${dir}/yarn.lock`, "utf-8");

  const ws = {
    cd: () => process.chdir(ws.dir),
    dir,
    lockReset: () => fs.writeFile(`${dir}/yarn.lock`, lock),
    json: packageJson,
  };
  findWorkspace.last = ws;
  console.debug("ws: " + dir);
  return ws;
}
findWorkspace.last = null;

async function fsStatOrNull(path) {
  return fs.stat(path).catch(() => null);
}

async function execP(...execArgs) {
  console.debug("execP-start", ...execArgs);
  const { stdout } = await util.promisify(exec)(...execArgs);
  console.debug("execP-end", stdout + "\nENDSTDOUT");
  return stdout;
}

function handleDebugEnvVar() {
  if (process.env.DEBUG !== "1") console.debug = () => {};
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
  handleDebugEnvVar();
  main(...process.argv.slice(2));
}
