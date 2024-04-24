import { exec } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import path from "path";

/** Aliases for tighter code */
const execP = promisify(exec);
const O = Object;
const P = Promise;
type Dict<T> = Record<string, T>;

/** Functions */

/**
 * Prepares a yarn js package for installation
 *
 * Usage: run this on a package to be bootstrapped so that crosslinks
 * are resolved correctly. Rememember to undo this after bootstrapping.
 *
 * - convert workspace:* to relative paths in dependencies, devDependencies.
 * - Also add nested crosslinks bc yarn doesn't traverse them.
 * - Also remove peerDependencies that are crosslinks so Yarn doesn't complain.
 */
async function preinstall(pkg: Pkg) {
  const pjs = pkg.json;

  if (pkg.baz.dirty.length) {
    console.error(
      `ERROR: You dependencies in your BUILD.bazel file are out of date in ${pkg.basename}.`
    );
    console.error("You need to update your BUILD.bazel file with:");
    console.error(pkg.baz.dirty.join("\n"));
    console.error(
      "We tried to correct it for you, and you'll need to re-start this build"
    );
    await pkg.fixBaz();
    process.exit(1);
  }

  // unpack dependencies
  P.all(
    O.keys(pkg.clTree).map(async (name) => {
      const p = `${pkgsDir}/${name}`;
      console.log(`unpacking ${p}/bundle.tgz`);
      if (!(await fs.stat(`${p}/bundle.tgz`).catch(() => null))) {
        console.error(
          `ERROR: ${p}/bundle.tgz not found and is a dependent of ${pkg.basename}`
        );
        process.exit(1);
      }
      await P.all([
        fs.unlink(`${p}/package.tgz`).catch(() => {}),
        fs.rmdir(`${p}/dist`, { recursive: true }),
        fs.rmdir(`${p}/build`, { recursive: true }),
      ]).catch(() => {});
      await execP(`tar -C ${p} -xzf ${p}/bundle.tgz`);
    })
  );

  // swap out the workspace:* (aka cls) with relative paths and add nested
  O.values(pkg.clTreeFlat).forEach((cl) => {
    const name = cl.json.name;
    if (pjs.dependencies?.[name]) {
      pjs.dependencies[name] = `../${cl.basename}/package.tgz`;
    } else {
      if (!pjs.devDependencies) pjs.devDependencies = {};
      pjs.devDependencies[name] = `../${cl.basename}/package.tgz`;
    }
  });

  // scrub out workspace:* (aka cls) from peerDependencies
  if (pjs.peerDependencies)
    pjs.peerDependencies = O.fromEntries(
      O.entries(pjs.peerDependencies).filter(([, v]) => v !== "workspace:*")
    );

  // commit to filesystem
  await pkg.save();
}

class Pkg {
  constructor(
    public basename: string,
    public baz: {
      text: string;
      depsStartsAt: number;
      depsEndsAt: number;
      deps: string[];
      dirty: string[];
    },
    public clTreeFlat: Dict<Pkg>,
    public clTree: Dict<Pkg>,
    public json: {
      name: string;
      dependencies: Dict<string>;
      devDependencies: Dict<string>;
      peerDependencies: Dict<string>;
    },
    public text: string
  ) {}

  /** Fixes a broken BUILD.bazel */
  fixBaz = async () => {
    const bazDeps = O.keys(this.clTreeFlat);
    this.baz.text = this.baz.text.replace(
      this.baz.text.slice(this.baz.depsStartsAt, this.baz.depsEndsAt),
      JSON.stringify(bazDeps.map((d) => `//packages/${d}:bundle.tgz`).sort())
    );
    fs.writeFile(
      `${pkgsDir}/${this.basename}/BUILD.bazel`,
      this.baz.text,
      "utf8"
    );
  };

  save = async () =>
    fs.writeFile(
      `${pkgsDir}/${this.basename}/package.json`,
      JSON.stringify(this.json, null, 2) + "\n",
      "utf8"
    );

  /** Gets a package obj relative to the current dir */
  static getPkg = cachify(async (pkgBasename: string) => {
    const { json, text } = await Pkg.getPkgJson(pkgBasename);

    const clTree: Pkg["clTree"] = {};
    const clTreeFlat: Pkg["clTreeFlat"] = {};

    const recurse = (deps: Dict<string> = {}) =>
      O.entries(deps ?? {})
        .filter(([, v]) => v === "workspace:*")
        .map(async ([depName]) => {
          const shortName = depName.split("/")[1];
          const cl = await Pkg.getPkg(shortName);
          clTree[shortName] = clTreeFlat[shortName] = cl;
          Object.assign(clTreeFlat, cl.clTreeFlat);
        });

    const _p: Promise<any>[] = [];

    _p.push(...recurse(json.dependencies));

    if (pkgBasename === startWithName)
      _p.push(...recurse(json.devDependencies));

    _p.push(fs.readFile(`${pkgsDir}/${pkgBasename}/BUILD.bazel`, "utf8"));
    const bazTxt = (await P.all(_p)).at(-1);

    // baz = bazel BUILD.bazel file
    // Find DEPS = ["//packages/lib1:bundle.tgz","//packages/lib3:bundle.tgz"]
    let bazDepsStartsAt = bazTxt.indexOf("DEPS = ");
    if (bazDepsStartsAt === -1) throw new Error("No DEPS found in BUILD.bazel");
    bazDepsStartsAt = bazDepsStartsAt + "DEPS = ".length;
    const bazDepsEndsAt = bazTxt.indexOf("]", bazDepsStartsAt) + 1;
    let bazDeps: string[] = JSON.parse(
      bazTxt
        .slice(bazDepsStartsAt, bazDepsEndsAt)
        .replace(new RegExp("//packages/", "g"), "")
        .replace(new RegExp(":bundle.tgz", "g"), "") || "[]"
    );
    const bazMissing = O.keys(clTreeFlat).filter(
      (name) => !bazDeps.includes(name)
    );
    const bazExtras = bazDeps.filter(
      (name) => !O.keys(clTreeFlat).includes(name)
    );
    const bazDirty = [
      ...bazExtras.map((b) => `-${b}`),
      ...bazMissing.map((b) => `+${b}`),
    ];
    const baz: PkgType["baz"] = {
      text: bazTxt,
      depsStartsAt: bazDepsStartsAt,
      depsEndsAt: bazDepsEndsAt,
      deps: bazDeps,
      dirty: bazDirty,
    };

    const pkg = new Pkg(pkgBasename, baz, clTreeFlat, clTree, json, text);
    return pkg;
  });

  static getPkgJson = cachify(async (shortName: string) => {
    const path = `${pkgsDir}/${shortName}/package.json`;
    const text = await fs.readFile(path, "utf8");
    const json: PkgType["json"] = JSON.parse(text);
    return { json, text };
  });
}
type PkgType = InstanceType<typeof Pkg>;

function cachify<T extends (...args: any) => Promise<any>>(fn: T) {
  const cache: Dict<any> = {};
  return async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    const key = JSON.stringify(args);
    if (key in cache) return cache[key];
    return (cache[key] = fn(...args));
  };
}

/** Main */
const startWithDir = process.argv[2] ?? process.cwd();
const startWithName = path.basename(startWithDir);
const pkgsDir = path.dirname(startWithDir);
try {
  const startWithPkg = await Pkg.getPkg(startWithName);
  await preinstall(startWithPkg);
} catch (e) {
  console.error("Unhandled error in preinstall.ts");
  console.error(e);
  process.exit(1);
}
