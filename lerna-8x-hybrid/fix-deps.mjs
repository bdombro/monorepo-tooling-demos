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
import chokidar from "chokidar";
import { promises as fs } from "fs";
import pathNode from "path";
import util from "util";

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
      await fixDeps(pkgName, { buildPkgToo: true });
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
  options = {}
) {
  const { buildPkgToo = false } = options;
  log1(`fixDeps:${pkgName}:${buildPkgToo ? "minimal-build" : "build-pkg-too"}`);
  const start = Date.now();

  const ws = await getWorkspace();
  const pkg = await getPkg(pkgName);
  ws.cd();

  // bootstrap if self or any cross-links not already
  const needsStrap = [];
  await Promise.all(
    Object.values({ [pkg.name]: pkg, ...pkg.crosslinksAll }).map(async (p) => {
      if (!(await fsStatOrNull(`${p.path}/node_modules`))) {
        needsStrap.push(p.name);
      }
    })
  );
  if (needsStrap.length) {
    log1(`fixdeps:bootstrapping bc`, needsStrap);
    await execWs(
      `yarn lerna bootstrap --scope=${pkg.name} --include-dependencies`
    );
  } else {
    log2(`fixdeps:skipping-bootstrap`);
  }

  // bail if there are no workspace deps
  if (!Object.keys(pkg.crosslinksForDependents).length) {
    log1("No cross-links to fix");
    return;
  }

  const pkgsToFix = { [pkg.name]: pkg, ...pkg.crosslinksAll };
  log1("fixDeps:fix-todos:", Object.keys(pkgsToFix));

  await Promise.all(
    Object.values(pkgsToFix).map(async (ptf) => {
      await ptf.unCrosslink();
    })
  );

  await execWs(
    `yarn lerna bootstrap ` +
      Object.keys(pkgsToFix)
        .map((name) => `--scope=${name}`)
        .join(" ")
  );

  await Promise.all(Object.values(pkgsToFix).map(async (ptf) => ptf.reset()));

  const buildQueue = { ...pkgsToFix };
  await Promise.all(
    Object.values(pkgsToFix).map(async (ptf) => {
      while (Object.keys(ptf.crosslinksAll).some((l) => l in buildQueue)) {
        await sleep(100);
      }
      // build it!
      log1(`fixDeps:build:${ptf.name}`);
      await rsyncDists(ptf.name, false);
      const stdout = await execWs(`yarn lerna run build --scope=${ptf.name}`);
      stdout.split("\n").forEach((l) => log2(`fixdeps:build:${ptf.name}:`, l));

      // pack it!
      // log1(`fixDeps:pack:${ptf.name}`);
      // await ptf.pack();

      // await fixDeps
      //   .apply(ptf, buildPkgToo ? true : ptf.name !== pkg.name)
      //   .catch((e) => {
      //     log1(`fixDeps:error:on:${ptf.name}`);
      //     log1("fixDeps:error:", e);
      //     log1("fixDeps:error:end");
      //     throw e;
      //   });
      delete buildQueue[ptf.name];
    })
  );

  // now reset ws and packages

  // const stdout = await execWs(`yarn lerna run build --scope=${pkg.name}`);
  // stdout.split("\n").forEach((l) => log2(`${lctx}:build:`, l));

  // await Promise.all(
  //   Object.values(pkgsToFix).map(async (ptf) => {
  //     await ptf.pack();
  //   })
  // );

  // await Promise.all(
  //   Object.values(pkgsToFix).map(async (ptf) => {
  //     while (Object.keys(ptf.crosslinksAll).some((l) => l in pkgsToFix)) {
  //       await sleep(100);
  //     }
  //     await fixDeps
  //       .apply(ptf, buildPkgToo ? true : ptf.name !== pkg.name)
  //       .catch((e) => {
  //         log1(`fixDeps:error:on:${ptf.name}`);
  //         log1("fixDeps:error:", e);
  //         log1("fixDeps:error:end");
  //         throw e;
  //       });
  //     delete pkgsToFix[ptf.name];
  //   })
  // ).catch(async (e) => {
  //   log1("fixDeps:resetting-world");
  //   // await getFile.resetAll();
  //   // await unfixDeps(pkgName);
  //   throw e;
  // });

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
fixDeps.apply = async (pkg, build = true) => {
  const lctx = `fixDeps.apply:${pkg.name}`;
  log1(lctx);
  const start = Date.now();

  const ws = await getWorkspace();
  ws.cd();

  const clNames = Object.keys(pkg.crosslinksForDependents);

  if (clNames.length) {
    log1(`${lctx}:crosslinks-todo:`, clNames);

    await pkg.rmCrosslinks();

    // shield crosslinks from yarn trying to re-do workspace linking
    // const unhidePkgJsonWsPkgs = await ws.hidePkgJsonWsPkgs(
    //   pkg.crosslinksForDependents
    // );

    // Do fixes: install the cross-linked packages as relative file dependencies so that
    // they are installed as if they were npm packages
    log1(`${lctx}:yarn-adds`);
    await execWs(
      // note: we use yarn add bc is faster than lerna add
      `cd ${pkg.path} && ` +
        ` yarn add ` +
        `${Object.values(pkg.crosslinksForDependents)
          .map(
            (cm) =>
              `${"../".repeat(pkg.path.split("/").length)}${
                cm.path
              }/package.tgz`
          )
          .join(" ")};`
    );

    log1(`${lctx}:cleanup`);
    await pkg.reset();
    // await unhidePkgJsonWsPkgs();
  }

  if (build) {
    // now build it and pack it for dependents

    /// build it!
    log1(`${lctx}:build`);
    const stdout = await execWs(`yarn lerna run build --scope=${pkg.name}`);
    stdout.split("\n").forEach((l) => log2(`${lctx}:build:`, l));

    // pack it!
    log1(`${lctx}:pack`);
    // - remove the cross-linked packages from the package.json to avoid conflicts
    await pkg.rmCrosslinks();
    await pkg.pack();

    // reset the state of the package.json and lock file so that lerna+nx are unaware
    log1(`${lctx}:reset`);
    await pkg.reset();
  }

  log2(`${lctx}:end:${Date.now() - start}ms`);
};

export async function unfixDeps(pkgName) {
  const lctx = `unfixDeps:${pkgName}`;
  log1(lctx);

  const ws = await getWorkspace();
  ws.cd();

  const pkg = await getPkg(pkgName);

  // bail if there are no workspace deps
  if (!Object.keys(pkg.crosslinksAll).length) {
    log1(`${lctx}:No cross-links to fix`);
    return;
  }

  const pkgsToUnfix = { [pkg.name]: pkg, ...pkg.crosslinksAll };
  log1(`${lctx}:unfix-todos:`, Object.keys(pkgsToUnfix));

  await Promise.all(
    Object.values(pkgsToUnfix).map((ptu) => {
      log1(`${lctx}:rm ${ptu.path}/node_modules`);
      return fs.rm(`${ptu.path}/node_modules`, {
        recursive: true,
        force: true,
      });
    })
  );

  log1(`${lctx}:bootstrap:`);
  await execWs(
    `yarn lerna bootstrap --scope=${pkg.name} --include-dependencies`
  );

  log1(`${lctx}:end`);
}

/**
 * syncs the dist folders of all workspace deps in the packagePath
 */
export async function rsyncDists(pkgName, watch = false) {
  const lctx = `rsyncDists:${pkgName}`;
  log1(lctx + watch ? ":with-watch" : "");

  const ws = await getWorkspace();
  ws.cd();

  const pkg = await getPkg(pkgName);

  const nestedNodeModules = `${pkg.path}/node_modules`;

  // bail if there are no workspace deps
  if (!(await fsStatOrNull(nestedNodeModules))) {
    log1(`${lctx}No ws packages to sync`);
    return;
  }

  async function doSync() {
    log1(`${lctx}:syncing`);
    const delta = await Promise.all(
      Object.values(pkg.crosslinksForDependents).map(async (cl) =>
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

  await doSync();

  if (watch) {
    const watcher = chokidar.watch([], {
      ignored: /node_modules/,
      persistent: true,
    });
    watcher.on("change", () => doSync());
    Object.values(pkg.crosslinks).map(async (cl) => {
      const distPath = `${cl.path}/dist/`;
      log1(`watching dep: ${distPath}`);
      watcher.add(distPath);
    });
    return () => {
      watcher.close().then(() => log1(`${lctx}:end`));
    };
  }
  log1(`${lctx}:end`);
}

/**
 * find workspace metadata by looking for the first package.json in the
 * directory tree, starting from the current directory, and moving up
 * until it finds either a workspaces field or a lerna.json file
 */
export async function getWorkspace() {
  const ws = getWorkspace.cache;
  while (ws.state === 1) {
    log4("getWorkspace:loading");
    await sleep(300);
  }
  if (ws.state === 2) {
    // log4("getWorkspace:cache-hit");
    return ws;
  }

  ws.state = 1;

  log1("getWorkspace:init");

  ws.path = process.cwd();
  stepUpDir: while (ws.path !== "/") {
    log3("getWorkspace:try:", ws.path);
    ws.pkgJsonF = await getPkgJsonFile(`${ws.path}/package.json`, true);
    if (ws.pkgJsonF?.workspaces?.[0]) {
      ws.pkgJsonWorkspaceGlobs = ws.pkgJsonF.workspaces;
      ws.workspaceGlobs = ws.workspaceGlobs.concat(ws.pkgJsonF.workspaces);
    }
    if (ws.pkgJsonF) {
      ws.lernaJsonF = await getJsonFile(`${ws.path}/lerna.json`, true);
      if (ws.lernaJsonF?.json?.packages?.[0]) {
        ws.workspaceGlobs = ws.workspaceGlobs.concat(
          ws.lernaJsonF.json.packages
        );
      }
    }
    if (ws.workspaceGlobs.length) break stepUpDir;
    ws.path = pathNode.dirname(ws.path);
  }
  if (!ws.workspaceGlobs.length) throw Error("No workspace root found");

  log1("getWorkspace:match:" + ws.path);

  ws.cd = () => {
    log4("getWorkspace:cd:" + ws.path);
    process.chdir(ws.path);
  };

  ws.workspaceGlobs = [...new Set(ws.workspaceGlobs)]; // de-dupe

  ws.lockFile = await findLockFile(ws.path, true);
  if (!ws.lockFile.name) {
    throw Error("Workspace missing lock file");
  }
  ws.yarnVersion = ws.lockFile.yarnVersion;
  if (ws.lockFile.name !== "yarn.lock") {
    throw Error(
      `${lctx}:yarn-check:error:${ws.pkgJsonF.name} has unsupported package manager with lockFile=${ws.lockFile.name}`
    );
  }
  if (ws.yarnVersion === 1) {
    yarnBust.init(ws.path);
  }

  log3("getWorkspace:paths");
  // TODO: Maybe consolidate these paths with all paths and simplify stuff above
  ws.pkgJsonWsPaths = await (async () => {
    const globs = ws.pkgJsonWorkspaceGlobs.filter((g) => g.endsWith("*"));
    const paths = ws.pkgJsonWorkspaceGlobs.filter((g) => !g.endsWith("*"));
    await Promise.all(
      globs.map(async (g) => {
        const dirPath = pathNode.basename(g);
        const ls = await getReadDir(`${ws.path}/${dirPath}`, true);
        paths.push(...ls.files.map((f) => `${dirPath}/${f}`));
      })
    );
    return paths;
  })();

  ws.hidePkgJsonWsPkgs = async (pkgs) => {
    log1("hidePkgJsonWsPkgs:hidePkgs");

    // TODO: consider rm p.isPkgJsonWsPkg

    const pkgsToHide = Object.values(pkgs).filter((p) => p.isPkgJsonWsPkg);

    await Promise.all([
      // hide the node_modules of the cross-linked packages
      ...pkgsToHide.map(async (pkg) => {
        await fs.rename(
          `${pkg.pathAbs}/node_modules`,
          `${pkg.pathAbs}/node_modules.bak`
        );
      }),
      // hide the cross-linked packages from the package.json to avoid conflicts
      // ws.pkgJsonF.setJson({
      //   ...ws.pkgJsonF.json,
      //   workspaces: ws.pkgJsonWsPaths.filter(
      //     (p) => !pkgsToHide.some((p2) => p2.path === p)
      //   ),
      // }),
    ]);

    return async function unhide() {
      log1("hidePkgJsonWsPkgs:unhidePkgs");

      // delete the new node_modules folder
      await Promise.all(
        pkgsToHide.map(async (pkg) => {
          await fs.rm(`${pkg.pathAbs}/node_modules`, {
            recursive: true,
            force: true,
          });
        })
      );

      await Promise.all(
        pkgsToHide.map(async (pkg) => {
          await fs.rename(
            `${pkg.pathAbs}/node_modules.bak`,
            `${pkg.pathAbs}/node_modules`
          );
        })
      );
    };
  };

  ws.reset = async () => {
    log1("getWorkspace:reset");
    await Promise.all([we.jsonF.reset(), ws.lockFile.reset()]);
  };

  ws.state = 2;

  log1("getWorkspace:end");
  return ws;
}
getWorkspace.cache = {
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
  pkgJsonWorkspaceGlobs: [],
  /** resets the lock and package.json to the original state when first read */
  reset: async () => {},
  /** 0:unitiated, 1: loading, 2: ready */
  state: 0,
  /** Converts package.json.workspace globs to enumerated paths */
  unGlob: async () => {},
  /** An array of workspace globs = [...packageJson.workspaces, ...lernaJson.packages] */
  workspaceGlobs: [],
  yarnVersion: 1,
};

/**
 * gets a class-like obj for a ws package with many convenience methods and meta
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
  while (cached?.state === 1) {
    await sleep(100);
    cached = getPkg.cache[pkgName];
  }
  if (cached?.state === 2) {
    log2(`${lctx}:cache-hit`);
    return cached;
  }

  const pkg = (getPkg.cache[pkgName] = {
    /**
     * dictionary of crosslinked packages, including nested
     *
     * in contrast to crosslinksAll, this only includes the crosslinks
     * needed for dependents of this package
     */
    crosslinksForDependents: {},
    /**
     * dictionary of all crosslinked packages, including nested
     *
     * in contrast to crosslinksForDependents, this includes all crosslinks
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
    /** path to the package */
    path: "",
    /** full path to the package */
    pathAbs: "",
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

  const ws = await getWorkspace();

  await findPkgInWs(pkgName).then((match) => {
    const pjf = match.pkgJsonF;
    pkg.wsGlob = match.wsGlob;
    pkg.pkgJsonF = pjf;
    pkg.domain = pjf.domain;
    pkg.json = pjf.json;
    pkg.nameNoDomain = pjf.nameNoDomain;
    pkg.dependencies = pjf.dependencies;
    pkg.devDependencies = pjf.devDependencies;
    pkg.isPkgJsonWsPkg = ws.pkgJsonWorkspaceGlobs.includes(pkg.wsGlob);
    pkg.path = pathNode.dirname(pjf.path);
    pkg.pathAbs = pathNode.dirname(pjf.pathAbs);
    pkg.workspaces = pjf.workspaces;
  });

  log4(`${lctx}:match on ${pkg.path}`);

  // get crosslinks from dependencies
  await Promise.all(
    Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
      .filter(
        ([name, version]) =>
          name.startsWith(pkg.domain) &&
          (version === "*" || version === "workspace:*")
      )
      .map(async ([name]) => {
        const dest =
          name in pkg.dependencies
            ? pkg.dependencyCrosslinks
            : pkg.devDependencyCrosslinks;
        dest[name] = await getPkg(name);
      })
  );
  log4(`${lctx}:dependencyCrosslinks1`, Object.keys(pkg.dependencyCrosslinks));
  log4(
    `${lctx}:devDependencyCrosslinks1`,
    Object.keys(pkg.devDependencyCrosslinks)
  );

  /** traverses through pkg.dependencyCrosslinks to enumerate all essential crosslinks to build this pkg */
  function flattenCrosslinks(crosslinks, includeIndirect = false) {
    const flat = { ...crosslinks };
    for (const [name, cl] of Object.entries(crosslinks)) {
      flat[name] = cl;
      Object.assign(flat, flattenCrosslinks(cl.dependencyCrosslinks));
      if (includeIndirect) {
        Object.assign(flat, flattenCrosslinks(cl.devDependencyCrosslinks));
      }
    }
    return flat;
  }
  pkg.crosslinksForDependents = flattenCrosslinks(
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
    `${lctx}:crosslinksForDependents`,
    Object.keys(pkg.crosslinksForDependents)
  );
  log4(`${lctx}:crosslinksAll`, Object.keys(pkg.crosslinksAll));

  pkg.lockFile = await findLockFile(pkg.path);
  if (pkg.lockFile.name && pkg.lockFile.name !== "yarn.lock") {
    throw Error(
      `${lctx}:yarn-check:error:${pkg.name} has unsupported package manager with lockFile=${pkg.lockFile.name}`
    );
  }
  pkg.yarnVersion = pkg.lockFile.yarnVersion;
  if (pkg.yarnVersion === 1) {
    yarnBust.init(pkg.pathAbs);
  }

  pkg.pack = async () => {
    log2(`${lctx}:pack`);
    await execWs(
      `cd ${pkg.path} && ` +
        (pkg.yarnVersion === 1
          ? `yarn pack -f package.tgz`
          : `yarn pack -o package.tgz`)
    );
  };

  pkg.reset = async () => {
    await Promise.all([pkg.pkgJsonF.reset(), pkg.lockFile.reset()]);
    log4(`${lctx}:reset`);
  };

  pkg.hideFromWs = async () => {
    ws.cd();
    if (pkg.isPkgJsonWsPkg) {
      // move the node_modules to a hidden folder
      log1(`${lctx}:hide ${pkg.path}/node_modules`);
      await fs.rename(
        `${pkg.pathAbs}/node_modules`,
        `${pkg.pathAbs}/.node_modules`
      );
      // find the package in
    }
  };

  pkg.unCrosslink = async () => {
    ws.cd();
    log1(`${lctx}:unCrosslink`);
    const depsNext = { ...pkg.dependencies };
    const devDepsNext = { ...pkg.devDependencies };
    for (const [name, cl] of Object.entries(pkg.crosslinksForDependents)) {
      if (name in depsNext) {
        depsNext[name] = `${"../".repeat(pkg.path.split("/").length)}${
          cl.path
        }`;
      }
      if (name in devDepsNext) {
        devDepsNext[name] = `${"../".repeat(pkg.path.split("/").length)}${
          cl.path
        }`;
      }
    }
    await fs.writeFile(
      pkg.pkgJsonF.pathAbs,
      JSON.stringify(
        {
          ...pkg.pkgJsonF.json,
          dependencies: depsNext,
          devDependencies: devDepsNext,
        },
        null,
        2
      )
    );
  };

  pkg.rmCrosslinks = async () => {
    ws.cd();

    const promises = [];

    // delete the cross-linked packages from the yarn v1 cache to prevent cache conflicts
    promises.push(yarnBust(pkg));

    // remove the cross-linked packages from yarn v1 cache to avoid conflicts
    promises.push(
      ...Object.keys(pkg.crosslinksForDependents).map(async (cname) => {
        log1(`${lctx}:rm ${pkg.path}/node_modules/${cname}`);
        await fs.rm(`${pkg.path}/node_modules/${cname}`, {
          recursive: true,
          force: true,
        });
      })
    );

    // remove the cross-linked packages from the package.json to avoid conflicts
    const regex = new RegExp(
      `"${pkg.domain}/[^:]+: "(workspace:\\*|\\*)",*`,
      "g"
    );
    const matches = pkg.pkgJsonF.text.match(regex);
    if (!matches) {
      log1(`${lctx}:rmCrosslinks:nothing-to-remove`);
      return;
    }
    const res = pkg.pkgJsonF.text.replace(regex, "");
    log1(`${lctx}:rmCrosslinks:${pkg.pkgJsonF.path}:`, matches);
    promises.push(fs.writeFile(pkg.pkgJsonF.pathAbs, res));

    await Promise.all(promises);

    backupToTmpDir(pkg.pkgJsonF.pathAbs, { text: res });
  };

  pkg.state = 2;

  log4(`${lctx}:end`);
  return pkg;
}
getPkg.cache = {};

/** searches the workspace globs for a package matching the pkgName */
async function findPkgInWs(pkgName) {
  const lctx = `findPkgInWs:${pkgName}`;
  log4(`${lctx}:start`);

  const tryGlob = findPkgInWs.tryGlob;
  const ws = await getWorkspace();

  // split the workspaces into 3 groups: with the package name, with wildcard, and the rest
  // based on best guess
  const wsGlobsWithPkgName = ws.workspaceGlobs.filter(
    (wsGlob) => pathNode.basename(wsGlob) === pathNode.basename(pkgName)
  );
  const wsGlobWilds = ws.workspaceGlobs.filter((wsGlob) =>
    wsGlob.endsWith("*")
  );
  const wsGlobsRest = ws.workspaceGlobs.filter(
    (wsGlob) => !(wsGlob in wsGlobsWithPkgName) && !(wsGlob in wsGlobWilds)
  );

  let match = null;
  if (wsGlobsWithPkgName.length) {
    log4(`${lctx}:try-wsGlobsWithPkgName`, wsGlobsWithPkgName);
    match = (
      await Promise.all(
        wsGlobsWithPkgName.map((wsGlob) => tryGlob(pkgName, wsGlob))
      )
    ).find(Boolean);
  }
  if (!match && wsGlobWilds.length) {
    log4(`${lctx}:try-wsGlobWilds`, wsGlobWilds);
    match = (
      await Promise.all(wsGlobWilds.map((p) => tryGlob(pkgName, p)))
    ).find(Boolean);
  }
  if (!match && wsGlobsRest.length) {
    log4(`${lctx}:try-wsGlobsRest`, wsGlobsRest);
    match = (
      await Promise.all(wsGlobsRest.map((p) => tryGlob(pkgName, p)))
    ).find(Boolean);
  }
  if (!match) throw Error(`${lctx}:no-match-found`);
  return match;
}
/** find a package in wsGlob with package.json:name=pkgName */
findPkgInWs.tryGlob = async (pkgName, wsGlob) => {
  const lctx = `findPkgInWsGlob:${pkgName}:${wsGlob}`;

  log4(`${lctx}:start`);

  const ws = await getWorkspace();
  ws.cd();

  let pkgJsonF = null;
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
      pkgJsonF = await getPkgJsonFile(`${tryPath}/package.json`);
      if (pkgJsonF?.name === pkgName) {
        log4(`${lctx}:match-on-wildcard-path-guess`);
        return { wsGlob, pkgJsonF };
      }
    }

    log4(`${lctx}:else loop all folders in the wildcard path`);
    for (const pkgDir2 of globDirs) {
      tryPath = `${globDirRoot}/${pkgDir2}`;
      log4(`${lctx}:try ${tryPath}`);
      pkgJsonF = await getPkgJsonFile(`${tryPath}/package.json`);
      if (pkgJsonF?.name === pkgName) {
        log4(`${lctx}:match-on-wildcard-brute-force`);
        return { wsGlob, pkgJsonF };
      }
    }
  } else {
    log4(
      `${lctx}:wsglob doesn't have wildcard, so is a path to a package. Try it out`
    );
    log4(`${lctx}:try ${wsGlob}`);
    pkgJsonF = await getPkgJsonFile(`${wsGlob}/package.json`);
    if (pkgJsonF?.name === pkgName) {
      log4(`${lctx}:match-on-path`);
      return { wsGlob, pkgJsonF };
    }
  }
  log4(`${lctx}:no-match`);
  return null;
};

/** clear pkgNames from yarn v1 cache if yarn v1 */
async function yarnBust(pkg) {
  const clNames = Object.keys(pkg.crosslinksAll);
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
    getWorkspace.cache?.path && process.chdir(getWorkspace.cache.path);
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
    const ws = await getWorkspace();
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
  log4(
    `${lctx}:${cached.files ? `found:${cached.files.length}` : "not found"}`
  );
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
    const ws = await getWorkspace();
    ws.cd();
  }
  const pathAbs = path.startsWith("/") ? path : `${process.cwd()}/${path}`;

  cached = getFile.cache[path] = {
    loading: true,
    path,
    pathAbs,
    reset: async () => {},
    set: async () => {},
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
          await backupToTmpDir(pathAbs);
          await fs.writeFile(pathAbs, text);
        }
      },
      set: async (newText) => {
        await backupToTmpDir(pathAbs);
        await fs.writeFile(pathAbs, newText);
        backupToTmpDir(pathAbs, { text: newText });
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
  } else if (getWorkspace.cache?.lockFile) {
    cached = findLockFile.cache[pkgPath] = getWorkspace.cache?.lockFile;
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
  while (cached?.state === 1) {
    await sleep(100);
    cached = getJsonFile.cache[path];
  }
  if (cached?.state === 2) {
    log4(`getJsonFile:cache-hit:${path}`);
    return cached;
  }

  const jsonF = (getJsonFile.cache[path] = {
    json: null,
    path,
    pathAbs: null,
    reset: async () => {},
    setJson: async () => {},
    state: 1,
    text: null,
  });

  const rfRes = await getFile(path, skipCd);
  if (rfRes.text) {
    Object.assign(jsonF, {
      ...cached,
      ...rfRes,
      setJson: async (json) => rfRes.set(JSON.stringify(json, null, 2)),
      state: 2,
      json: JSON.parse(rfRes.text),
    });
  } else {
    Object.assign(jsonF, {
      ...cached,
      state: 2,
    });
  }
  return jsonF;
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
    dependencies: jsonF?.json?.dependencies ?? {},
    devDependencies: jsonF?.json?.devDependencies ?? {},
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
      log3(`${lctx}:${l.replace(new RegExp(process.cwd(), "g"), "{ws}")}`);
      return l;
    })
    .join("\n");
  if (!stdout) {
    log3(`${lctx}:none`);
  }

  log3(`${lctx}:end`);
  return stdout;
}
execP.count = 0;

/** wrapper for execP that ws.cd()'s first. Is safer. */
async function execWs(...execArgs) {
  const ws = await getWorkspace();
  ws.cd();
  return execP(...execArgs);
}

/**
 * Backups files for debugging and troubleshooting purposes
 * to: `/tmp/lerna-fix-deps/${timestamp}`
 */
async function backupToTmpDir(path, options = {}) {
  const { text = null, moveInsteadOfCopy = false } = options;

  const tmpDir = await getTmpDir();

  let backupPath =
    `${tmpDir}/` +
    path
      .replace(getWorkspace.cache?.path ?? "", "")
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

const logLevel = parseInt(process.env.LOG || "1");
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
