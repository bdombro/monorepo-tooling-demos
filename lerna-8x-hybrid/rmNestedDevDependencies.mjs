/**
 * Motivation:
 *   monorepos install devDependencies for all workspaces, and use simple symlinks to connect them.
 *   This can lead to nested devDependencies, which can cause resolution conflicts in the a package.
 *   Example conflicts:
 *   - a React app may have deps that have a diff version of React in their devDependencies. This
 *     will cause bundlers to include multiple versions of React, which blows up the bundle size,
 *     causes runtime errors, and typescript errors.
 * Goal: De-conflict nested dependencies
 * Approach: Discover and delete nested devDependencies
 */

import { exec } from "child_process";
import { promises as fs } from "fs";
import util from "util";

export async function rmNestedDevDependencies(packagePath) {
  console.debug("rmNestedDevDependencies-start", packagePath);

  (await fsStatOrNull(
    (packagePath || throwError("packagePath is required")) + "/package.json"
  )) || throwError(`${packagePath}/package.json not found`);

  // discover all dependencies, which are any folder in the cwd that's parent = node_modules
  // Use a set to auto-dedup
  const depPaths = new Set(
    await execP(
      `find -L ${packagePath}/node_modules -type f -name package.json`
    ).then((r) =>
      r
        .split("\n")
        .map((path) => path.substring(0, path.lastIndexOf("/")))
        .filter(Boolean)
    )
  );

  const nestedDepPaths = [...depPaths].filter(
    (depPath) => depPath.split("/node_modules").length > 1
  );

  await Promise.all(
    nestedDepPaths.map(async (depPath) => {
      if (!(await fsStatOrNull(depPath + "/node_modules"))) return;
      const packageJson = JSON.parse(
        await fs.readFile(depPath + "/package.json", "utf-8")
      );
      const devDependencies = packageJson.devDependencies || {};
      await Promise.all(
        Object.keys(devDependencies).map(async (dep) => {
          const devDepPath = `${depPath}/node_modules/${dep}`;
          if (!(await fsStatOrNull(devDepPath))) return;
          const devDepBins = await fs
            .readdir(devDepPath + "/bin")
            .catch(() => []);
          console.debug("deleting", devDepPath);
          await fs.rm(devDepPath, { recursive: true, force: true });
          await Promise.all(
            devDepBins.map(async (bin) => {
              const binPath = `${depPath}/node_modules/.bin/${bin}`;
              console.debug("deleting", binPath);
              await fs.rm(binPath);
            })
          );
        })
      );
    })
  );
  console.debug("rmNestedDevDependencies-end");
}

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

function throwError(message, ...extra) {
  const e = new Error(message);
  e.extra = extra;
  Object.assign(e, extra);
  throw e;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  handleDebugEnvVar();
  rmNestedDevDependencies(process.argv.slice(2)[0]);
}
