import chokidar from "chokidar";
import osNode from "node:os";
import {
  cachify,
  Dict,
  fs,
  LocalCache,
  Log,
  logDefault,
  O,
  P,
  PReturnType,
  sh,
  stepErr,
  stepErrCb,
  Time,
  Yarn,
  md5,
  anyOk,
  A,
  strFileEscape,
  UTIL_ENV,
  SMM,
  Tree,
  Is,
  strCompare,
  Fnc,
  FncP,
  throttle,
} from "./util.js";

const pkgLocalCache = new LocalCache({ path: `${fs.home}/.mono/cache` });

export class Pkgs {
  static log = new Log({ prefix: "PKGS" });
  static l0 = Pkgs.log.l0;
  static l1 = Pkgs.log.l1;
  static l2 = Pkgs.log.l2;
  static l3 = Pkgs.log.l3;
  static l4 = Pkgs.log.l4;
  static l5 = Pkgs.log.l5;
  static l9 = Pkgs.log.l9;

  static buildMany = async (opts: { noCache: boolean; pkgs?: Pkg[] }) => {
    Pkgs.l1(":buildMany->start");
    const start = Date.now();
    const { noCache } = opts;
    const pkgs = opts.pkgs ?? (await Pkgs.find());
    A.dedup(pkgs);
    pkgs.sort((a, b) => -1 * strCompare(a.name, b.name));
    await P.all(pkgs.map((pkg) => pkg.build({ noCache })));
    Pkgs.l1(`:buildMany->end ${Time.diff(start)}`);
  };

  /** cleans up stuff in current workspace as determined by cwd */
  static clean = async (
    opts: SMM & {
      /** ws flag + yarn caches. NOT nma bc that is extreme */
      all?: boolean;
      /** Whether to clean the build artifacts */
      builds?: boolean;
      /** Whether to clean the build local cache */
      buildCache?: boolean;
      includeDependencies?: boolean;
      includeDependents?: boolean;
      /** Exclude some packages from clean, by domain and/or name */
      nodeModulesAll?: boolean;
      /** Whether to rimraf the entire node_modules folders */
      nodeModuleCrosslinks?: boolean;
      /** Clean the workspace: bld artifacts and nodeModuleCrosslinks */
      ws?: boolean;
      /** clean yarn caches: is slow fyi */
      yarnCache?: boolean;
    }
  ) => {
    const { excludes, includes, ...flags } = opts;
    try {
      if (!O.vals(flags).some(Boolean)) {
        Pkgs.l1(":clean->no opts provided, exiting");
        return;
      }

      // Handle the all and allButNm flags
      if (opts.all) {
        if (Is.undef(opts.buildCache)) opts.buildCache = true;
        if (Is.undef(opts.ws)) opts.ws = true;
        if (Is.undef(opts.yarnCache)) opts.yarnCache = true;
      }

      if (opts.ws) {
        if (Is.undef(opts.builds)) opts.builds = true;
        if (Is.undef(opts.nodeModuleCrosslinks))
          opts.nodeModuleCrosslinks = true;
      }

      await fs.findNearestWsRoot(); // asserts we are in a ws and pumps cache

      const pkgs = await Pkgs.find({
        includes,
        excludes,
        dependents: opts.includeDependents,
      });
      const pkgNames = pkgs.map((p) => p.name) as [string]; // cast bc we do length check below

      if (!pkgNames.length)
        throw stepErr(Error("No packages found for filters"), "clean.find");

      if (opts.includeDependencies) {
        pkgs.map((p) => pkgs.push(...p.dependencyClsForInstall));
      }
      if (opts.includeDependents) {
        pkgs.map((p) => pkgs.push(...p.dependentClsFlat));
      }

      A.dedup(pkgs);
      pkgs.sort((a, b) => strCompare(a.name, b.name));

      Pkgs.l1(`:clean->start ${pkgs.length} packages`);

      const _p: Promise<anyOk>[] = [];

      for (const p of pkgs) {
        Pkgs.l2(`:clean:${p.basename}->start`);
        if (opts.builds) _p.push(p.cleanBld());
        if (opts.buildCache) _p.push(p.bldArtifactCachePurge());
        if (opts.yarnCache) _p.push(p.yarnCleanCache());
        if (opts.nodeModulesAll) _p.push(p.cleanNodeModules({ hard: true }));
        else if (opts.nodeModuleCrosslinks) _p.push(p.cleanNodeModules());
      }

      await P.all(_p);

      Pkgs.l2(`:clean->done`);
    } catch (e) {
      throw stepErr(e, "clean", { cwd: process.cwd() });
    }
  };

  /** Find packages */
  static find = cachify(
    async (
      opts: SMM & {
        /** build dependent tree */
        dependents?: boolean;
      } = {}
    ) => {
      const { excludes, includes, dependents } = opts;

      if (dependents) {
        const pkgBasenamesAll = await Pkgs.findPkgPaths();
        const pkgsAll = await P.all(pkgBasenamesAll.map((n) => Pkgs.get(n)));
        await P.all(pkgsAll.map((p) => p.treeBldDependents()));
      }

      const pkgBasenames = await Pkgs.findPkgPaths({ excludes, includes });
      const pkgs = await P.all(pkgBasenames.map((n) => Pkgs.get(n)));
      return pkgs;
    }
  );

  /**
   * Gets a Pkg instance from a pkg path, basename, or package name
   *
   * - uses custom cache
   */
  static get = async (pathOrName: string): Promise<Pkg> => {
    Pkgs.l4(`:get->${pathOrName}`);
    pathOrName = pathOrName
      .replace(/\.\/$/, "")
      .replace(/\.$/, "")
      .replace(/\/$/, "");

    if (!pathOrName) pathOrName = process.cwd();
    if (pathOrName.startsWith("@")) pathOrName = pathOrName.split("/")[1];

    let [basename, pathWs, pathRel, pathAbs] = Array(4).fill("");
    if (pathOrName.split("/").length === 2) {
      basename = fs.basename(pathOrName);
      pathWs = await fs.findNearestWsRoot();
      pathRel = `packages/${basename}`;
      pathAbs = `${pathWs}/${pathRel}`;
    } else if (pathOrName.includes("/")) {
      pathAbs = pathOrName;
      basename = fs.basename(pathAbs);
      pathWs = fs.dirname(fs.dirname(pathAbs));
      pathRel = fs.pathRel(pathWs, pathAbs);
    } else {
      basename = pathOrName;
      pathWs = await fs.findNearestWsRoot();
      pathRel = `packages/${basename}`;
      pathAbs = `${pathWs}/${pathRel}`;
    }

    if (Pkgs.getCache.has(pathRel)) {
      Pkgs.l4(`:get->cache-hit`);
      return Pkgs.getCache.get(pathRel)!;
    }

    const pkgPwr = P.wr<Pkg>();
    Pkgs.getCache.set(pathRel, pkgPwr.promise);

    Pkgs.l4(`:get:path->match`);
    Pkgs.l4(`:get:path->${pathAbs}`);

    try {
      const jsonF = await fs.getPkgJsonFileC(pathAbs);
      const pkg = new Pkg(jsonF, pathAbs, pathRel, pathWs);
      await pkg.treeBldDependencies();
      Pkgs.l3(`:get->done for ${basename}`);
      pkgPwr.resolve(pkg);
      return pkg;
    } catch (e: anyOk) {
      e = stepErr(e, "getPkg", { pathOrName: pathOrName });
      pkgPwr.reject(e);
      throw e;
    }
    // end getPkg
  };
  static getCache = new Map<string, Promise<Pkg>>();

  static exec = async (
    pkgs: Pkg[],
    cmd: string,
    opts: {
      maxConcurrent?: number;
    } = {}
  ) => {
    const { maxConcurrent } = opts;
    const exec = throttle(
      (pkg: Pkg) =>
        sh.exec(cmd, {
          prefix: pkg.basename,
          printOutput: true,
          wd: pkg.pathAbs,
        }),
      {
        maxConcurrent,
      }
    );
    await P.all(pkgs.map(exec));
  };

  static findPkgPaths = async (options: SMM = {}): Promise<string[]> => {
    let { includes } = options;
    const { excludes } = options;
    const wsRoot = await fs.findNearestWsRoot();
    const pkgDir = `${wsRoot}/packages`;

    let paths: string[] = [];

    if (Is.arrF(includes)) {
      for (let i = 0; i < includes.length; i++) {
        const inc = includes[i];
        if (Is.str(inc)) {
          // if inc has an abs path, just take it.
          if (inc.startsWith("/")) {
            paths.push(inc);
          } else {
            includes[i] = new RegExp(`${inc}$`);
          }
        }
      }
    }

    if (!paths.length) {
      paths.push(
        ...(await fs.findC(pkgDir, {
          excludes,
          includes,
          typeFilter: "dir",
        }))
      );
    }

    if (!paths.length)
      throw stepErr(
        Error('No packages found in "packages" directory'),
        "Pkgs.getPkgNames",
        { pkgDir }
      );
    paths.sort(strCompare);
    return paths;
  };

  static treeViz = async (options: SMM & { print?: boolean } = {}) => {
    const { includes, excludes, print = true } = options;

    let txt = "\n";

    const pkgs = await Pkgs.find({ dependents: true, includes, excludes });

    for (const pkg of pkgs) {
      pkg.treeSort();

      txt += `${Log.cyan(pkg.name.toLocaleUpperCase())} \n\n`;
      txt += `--dependencies--\n\n`;
      txt +=
        Tree.viz(pkg, { childrenKey: "dependencies", nameKey: "treeName" }) +
        "\n\n";
      txt += `--dependents--\n\n`;
      txt +=
        Tree.viz(pkg, { childrenKey: "dependents", nameKey: "treeName" }) +
        "\n\n\n";
    }

    txt +=
      `-----------\n` +
      `Legend\n` +
      `↑: has crosslink dependencies\n` +
      `↓: has crosslink dependents\n` +
      "\n";

    if (print) console.log(txt);
  };
}

/**
 * Using a base classes makes a bit more organized, DRY and we can use the type
 * in Pkg without circular refs
 */

class PkgBase {
  constructor(
    public jsonF: PReturnType<typeof fs.getPkgJsonFile>,
    public pathAbs: string,
    public pathRel: string,
    public pathWs: string
  ) {}
}
class PkgWLogs extends PkgBase {
  public log!: Log;
  public l0!: Log["l0"];
  public l1!: Log["l1"];
  public l2!: Log["l2"];
  public l3!: Log["l3"];
  public l4!: Log["l4"];
  public l5!: Log["l5"];
  public l9!: Log["l9"];

  constructor(...args: ConstructorParameters<typeof PkgBase>) {
    super(...args);
    this.log = new Log({ prefix: `PKG:${fs.basename(this.pathAbs)}` });
    O.ass(this, this.log);
  }
}
class PkgWGetSets extends PkgWLogs {
  get basename() {
    return fs.basename(this.pathAbs);
  }
  get bldArtifactPath() {
    return `${this.pathAbs}/package.tgz`;
  }
  get domain() {
    return this.jsonF.json.name.split("/")[0];
  }
  get json() {
    return this.jsonF.json;
  }
  set json(json: PReturnType<typeof fs.getPkgJsonFile>["json"]) {
    this.jsonF.json = json;
  }
  get name() {
    return this.jsonF.json.name;
  }
  get text() {
    return this.jsonF.text;
  }
  set text(text: PReturnType<typeof fs.getPkgJsonFile>["text"]) {
    this.jsonF.text = text;
  }
}

class PkgWTree extends PkgWGetSets {
  /** pkgs in pkgJson.dependencies or pkgJson.devDependencies */
  public dependencies: Pkg[] = [];
  /** crosslink pkgs in pkgJson.dependencies or pkgJson.devDs */
  public dependencyCls: Pkg[] = [];
  /** dependencyCls, but flattened so all the cls are at top level of array */
  public dependencyClsFlat: Pkg[] = [];
  /**
   * dependencyClsFlat + devDeps (non-recursively)
   * - Are the pkgs needed to be installed in this pkg's node_modules.
   */
  public dependencyClsForInstall: Pkg[] = [];

  /** pkgs which have this pkg in their pkgJson.dependencies or pkgJson.devDs */
  public dependents: Pkg[] = [];
  /** crosslink pkgs which have this pkg in their pkgJson.dependencies or pkgJson.devDs */
  public dependentCls: Pkg[] = [];
  /** dependentCls, but flattened so all the cls are at top level of array */
  public dependentClsFlat: Pkg[] = [];

  get treeName() {
    let name = this.basename + " ";
    const hasDownCls = this.dependentCls.length > 0;
    const hasUpCls = this.dependencyCls.length > 0;
    if (hasDownCls) name += "↓";
    if (hasUpCls) name += "↑";
    return name;
  }

  /** Builds the dep tree fields of the pkg */
  treeBldDependencies = async () => {
    try {
      this.l4(`->treeBldDependencies`);
      const childrenDDeps: Pkg[] = [];
      await P.all(
        O.ents({
          ...this.json.dependencies,
          ...this.json.devDependencies,
        }).map(async ([pkgName, pkgVersion]) => {
          const isCl = pkgVersion === "workspace:*";
          const isInWs = isCl || pkgVersion.startsWith("0.0.0-local");
          if (!isInWs) return;

          const pkg = await Pkgs.get(pkgName).catch((e) => {
            throw stepErr(e, "getPkg->failed", {
              parent: this.basename,
              depName: pkgName,
            });
          });

          this.dependencies.push(pkg);

          if (isCl) {
            if (this.json.dependencies && pkgName in this.json.dependencies) {
              this.dependencyClsFlat.push(pkg);
              this.dependencyClsFlat.push(...pkg.dependencyClsFlat);
            } else {
              childrenDDeps.push(pkg);
            }
            this.dependencyCls.push(pkg);
          }
        })
      );
      this.dependencyClsForInstall.push(
        ...this.dependencyClsFlat,
        ...childrenDDeps
      );
      A.dedup(this.dependencies);
      A.dedup(this.dependencyCls);
      A.dedup(this.dependencyClsFlat);
      A.dedup(this.dependencyClsForInstall);
    } catch (e: anyOk) {
      throw stepErr(e, "treeBldDependencies", { pkg: this.basename });
    }
  };

  treeBldDependents = cachify(async () => {
    try {
      this.l4(`->treeBldDependents`);
      const pkgs = await Pkgs.find();
      for (const pkg of pkgs) {
        const deps = { ...pkg.json.dependencies, ...pkg.json.devDependencies };
        if (this.name in deps) {
          this.dependents.push(pkg);
          if (deps[this.name] === "workspace:*") {
            this.dependentCls.push(pkg);
            this.dependentClsFlat.push(pkg);
            this.dependentClsFlat.push(...pkg.dependentClsFlat);
          }
        }
      }
      await P.all(this.dependents.map((cl) => cl.treeBldDependents()));
      A.dedup(this.dependents);
      A.dedup(this.dependentCls);
      A.dedup(this.dependentClsFlat);
    } catch (e: anyOk) {
      throw stepErr(e, "treeBldDependents", { pkg: this.basename });
    }
  });

  treeSort = () => {
    this.dependencies.sort((a, b) => strCompare(a.name, b.name));
    this.dependents.sort((a, b) => strCompare(a.name, b.name));
  };
}

class PkgWithBuild extends PkgWTree {
  bootstrap = async (opts: { noCache: boolean }) => {
    try {
      const { noCache } = opts;
      this.l3(`:bootstrap`);
      const start = Date.now();
      await this.yarnPreinstall({ noCache });
      await this.jsonF.disableHooks();
      await this.yarnInstall();
      await this.yarnPostinstall();
      this.l3(`:bootstrap->end ${Time.diff(start)}`);
    } catch (e: anyOk) {
      await this.yarnPostinstall();
      throw stepErr(e, "bootstrap");
    }
  };

  build = cachify(async (opts: { noCache: boolean }) => {
    try {
      this.l3(`:build->start`);
      const start = Date.now();
      const { noCache } = opts;

      await this.buildDependencies({ noCache });

      const canSkip = await this.buildCheckIfCanSkip(noCache);
      if (canSkip) return;

      await this.bootstrap({ noCache });
      await this.yarnPrebuild();
      await this.jsonF.disableHooks();
      await this.yarnBuild();
      await this.yarnPostbuild();

      await this.bldArtifactAttrsSet();
      await this.bldArtifactCacheAdd();

      this.l3(`:build->end ${Time.diff(start)}`);
    } catch (e: anyOk) {
      throw stepErr(e, "build");
    }
  });

  buildCheckIfCanSkip = async (noCache: boolean) => {
    if (!noCache) {
      if (await this.bldArtifactIsUpToDate()) {
        this.l1(`:build->skip-bc-existing-is-ok`);
        return true;
      }
      try {
        // why isn't build skipping on success?
        await this.bldArtifactCacheGet();
        this.l1(`:build->skip-bc-cache-hit`);
        return true;
      } catch (e) {}
    }
    return false;
  };

  buildDependencies = cachify(async (opts: { noCache: boolean }) => {
    try {
      this.l4(`->buildDependencies`);
      const { noCache } = opts;
      await P.all(
        this.dependencyClsForInstall.map(async (cl) => {
          await cl.build({ noCache });
        })
      );
      return;
    } catch (e) {
      throw stepErr(e, "buildDependencies", { parent: this.basename });
    }
  });

  /**
   * Our cache strategy is to key on the checksum of the src files
   * that go in the package.tgz, so that we can check for cache hits
   * without actually having a build yet.
   */

  /** check if build artifact already in workspace is up to date **/
  bldArtifactIsUpToDate = async (): Promise<boolean> => {
    try {
      this.l4(`->bldArtifactIsUpToDate`);
      const expected = await this.bldArtifactAttrsCreate();
      const existing = await this.bldArtifactAttrsGet().catch(() => {});
      if (!existing) {
        this.l4(`bldArtifactIsUpToDate->no`);
        return false;
      }
      const delta = new Set<string>();
      Object.entries(existing).map(
        ([k, v]) => expected[k] !== v && delta.add(k)
      );
      Object.entries(expected).map(
        ([k, v]) => existing[k] !== v && delta.add(k)
      );
      if (delta.size) {
        this.l2(`:bldArtifactIsUpToDate->no`);
        this.l1(`:bldArtifactIsUpToDate:changes->[${[...delta].join(",")}]`);
      } else {
        this.l4(`:bldArtifactIsUpToDate->yes`);
        return true;
      }
    } catch (e) {} // exception means no qualified build artifact
    return false;
  };

  bldArtifactAttrsCreate = cachify(async (): Promise<Dict> => {
    const [depCsums, selfCsum] = await P.all([
      this.bldArtifactCsumGet(),
      this.bldArtifactCsumCreate(),
    ]);
    const attrs = O.sort({ [this.name]: selfCsum, ...depCsums });
    return attrs;
  });

  bldArtifactAttrsGet = async () => {
    try {
      const attrs = await fs.getXattrs(this.bldArtifactPath);
      return attrs;
    } catch (e) {
      throw stepErr(e, "bldArtifactAttrsGet");
    }
  };

  bldArtifactAttrsSet = async () => {
    const bldAttrsExpected = await this.bldArtifactAttrsCreate();
    await fs.setXattrs(this.bldArtifactPath, bldAttrsExpected);
  };

  /**
   * adds this pkg's build artifact (package.tgz) to the caches (just local atm)
   *
   * even though we could get the attrs from the file, we pass them in to avoid
   * the extra fs call.
   */
  bldArtifactCacheAdd = async () => {
    try {
      const attrs = await this.bldArtifactAttrsGet();
      const cacheKey = this.bldArtifactCacheKey(attrs);
      this.l1(`:cacheAdd->${cacheKey}`);

      // stat before get to check if copy/download be skipped, bc we can skip if
      // the cache already has the package.tgz
      let stat = await pkgLocalCache
        .stat(cacheKey, { attrs: true })
        .catch(() => {});
      if (stat) {
        this.l1(`:cacheAdd->skip bc cache already has it`);
      } else {
        const bin = await fs.getBin(this.bldArtifactPath);
        stat = await pkgLocalCache.add(cacheKey, bin.buffer, { attrs });
      }

      this.l4(`:cacheAdd->end`);
      return stat;
    } catch (e) {
      throw stepErr(e, "addToCache");
    }
  };

  /**
   * Gets this's build artifact from the cache if exists. return null if not.
   *
   * Returns the result.
   */
  bldArtifactCacheGet = async () => {
    try {
      const bldAttrsExpected = await this.bldArtifactAttrsCreate();
      const cacheKey = this.bldArtifactCacheKey(bldAttrsExpected);
      this.l2(`:cacheGet->${cacheKey}`);
      const cached = await pkgLocalCache.get(cacheKey);
      await fs.setBin(this.bldArtifactPath, cached.buffer, {
        xattrs: cached.attrs,
      });

      this.l3(`:cacheGet->hit`);
      // end cacheGet main
    } catch (e) {
      throw stepErr(e, "cacheGet");
    }
  };

  /** Note if you change this, you also need to change bldArtifactCachePurge filter */
  bldArtifactCacheKey = (
    attrs: PReturnType<
      InstanceType<typeof PkgWithBuild>["bldArtifactAttrsCreate"]
    >
  ) => {
    const cacheKey = strFileEscape(`${this.name.slice(1)}-${md5(attrs)}.tgz`);
    return cacheKey;
  };

  bldArtifactCachePurge = async (opts: SMM = {}) => {
    try {
      await pkgLocalCache.purge({
        includes: [strFileEscape(this.name.slice(1))],
      });
    } catch (e) {
      throw stepErr(e, "cachePurge");
    }
  };

  bldArtifactCsumGet = async () => {
    const depArtifactCsums = O.fromEnts(
      await P.all(
        this.dependencyClsForInstall.map(async (cl) => {
          try {
            const xattrs = await fs.getXattrs(`${cl.pathAbs}/package.tgz`);
            const csum = xattrs[cl.json.name];
            return [cl.json.name, csum];
          } catch (e) {
            throw stepErr(e, "csumDepsGet", { cl: cl.json.name });
          }
        })
      )
    );
    return depArtifactCsums;
  };

  /** Makes an md5 checksum of the source files of a javascript package  */
  bldArtifactCsumCreate = async () => {
    try {
      this.l5(`->checksumSelf`);

      const srcDirIsPresent = await fs
        .stat(`${this.pathAbs}/src`)
        .catch(() => {});

      const excludesRegExps = [
        /^\.[a-zA-Z]/, // paths starting with a dot ie (.b)ar
        /\/\./, // paths with a dot path in the middle ie /foo(/.)bar
      ];

      const excludeStrsIfAnywhereInPath = [
        "dist",
        "build",
        "jest",
        "lint",
        "node_modules",
        "public",
        "stories",
        "story",
        "styleguide",
      ];

      const excludeStrsIfEndsWith: string[] = [
        "cortex.yaml",
        "package.tgz",
        "package-lock.json",
        "pnpm-lock.yaml",
        "README.md",
        "tsconfig.json",
      ];

      excludeStrsIfEndsWith.push(...(this.json.files ?? []));

      // Exclude dirs that are marked as exports in package.json.exports
      // Example:
      // "exports": {
      //   "./complex/*": {
      //     "import": {
      //       "types": "./types/src/complex/*.d.ts",
      //       "default": "./es/complex/*.mjs"
      //     }
      //   }
      // }
      const pkgExportPaths = O.valsRecursive<string>(this.json.exports ?? {});
      const pkgExportDirs = pkgExportPaths.map((p) => {
        let dir = p;
        dir = dir.replace(/^\.?\//, ""); // kill ^./ || ^/
        dir = dir.split("/")[0]; // kill everything after the first dir
        dir = this.pathRel + "/" + dir;
        return dir;
      });
      excludeStrsIfAnywhereInPath.push(...pkgExportDirs);

      excludesRegExps.push(
        RegExp("(" + A.toDedup(excludeStrsIfEndsWith).join("|") + ")$")
      );
      excludesRegExps.push(
        RegExp("(" + A.toDedup(excludeStrsIfAnywhereInPath).join("|") + ")")
      );

      const srcCsum = await fs.md5(this.pathAbs, {
        excludes: excludesRegExps,
        includes: srcDirIsPresent
          ? ["src", "package.json", "yarn.lock"]
          : undefined,
      });

      this.l5(`->checksumSelf: ${srcCsum}`);
      return srcCsum;
    } catch (e) {
      throw stepErr(e, "checksumSelf");
    }
  };

  cleanAll = async (opts: { rmAllNodeModules?: boolean } = {}) => {
    const { rmAllNodeModules } = opts;
    await P.all([
      this.cleanBld(),
      this.cleanCaches(),
      this.cleanNodeModules({ hard: rmAllNodeModules }),
    ]);
  };

  cleanBld = async () => {
    try {
      await P.all([
        fs.rm(`${this.pathAbs}/build`).catch(() => {}),
        fs.rm(`${this.pathAbs}/dist`).catch(() => {}),
        fs.rm(`${this.pathAbs}/package.json.bak`).catch(() => {}),
        fs.rm(`${this.pathAbs}/package.tgz`).catch(() => {}),
      ]);
    } catch (e) {
      throw stepErr(e, "pkg.cleanBld");
    }
  };

  cleanCaches = async () => {
    try {
      await P.all([this.bldArtifactCachePurge(), this.yarnCleanCache()]);
    } catch (e) {
      throw stepErr(e, "pkg.cleanCaches");
    }
  };

  cleanNodeModules = async (opts: { hard?: boolean } = {}) => {
    try {
      const { hard } = opts;
      if (hard) {
        await fs.rm(`${this.pathAbs}/node_modules`).catch(() => {});
      } else {
        await P.all(
          this.dependencyClsForInstall.map((cl) =>
            fs.purgeDir(`${this.pathAbs}/node_modules/${cl.json.name}`)
          )
        );
      }
    } catch (e) {
      throw stepErr(e, "pkg.cleanNodeModules");
    }
  };

  yarnPostinstall = async () => {
    this.l4(`->reset`);
    try {
      await P.all([
        // FIXME: using fs would be faster than sh.exec
        sh.exec(`sed -i '' -n '/@..\\//,/^$/!p' yarn.lock`, {
          wd: this.pathAbs,
        }),
        this.jsonF.reset(),
        this.yarnGenerate(),
      ]);
    } catch (e: anyOk) {
      throw stepErr(e, "reset");
    }
    this.l3(`:reset->end`);
  };

  yarnCleanCache = async () => {
    await Yarn.cachePurge({ pkgNames: [this.name] });
  };

  /**
   * Preps the package for install by:
   * 1. removing cls from yarn.lock
   * 2. upserting cls as ../[pkg]/package.tgz to package.json
   */
  yarnPreinstall = async (opts: { noCache: boolean }) => {
    try {
      this.l4(`->yarnPreinstall`);
      const { noCache = false } = opts;

      await this.buildDependencies({ noCache });

      // 1. remove cls from yarn.lock so yarn fresh installs
      // FIXME: using fs would be faster than sh.exec
      await sh.exec(
        '[ -f yarn.lock ] && sed -i "" -n "/@..\\//,/^$/!p" yarn.lock',
        { wd: this.pathAbs }
      );

      // 2. upsert cls (incl nested) as ../[pkg]/package.tgz to package.json

      // swap out the workspace:* (aka cls) with relative paths and add nested
      const pjs = this.json;
      this.dependencyClsForInstall.forEach((cl) => {
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
        pjs.peerDependencies = O.fromEnts(
          O.ents(pjs.peerDependencies).filter(([, v]) => v !== "workspace:*")
        );

      // commit to filesystem
      await this.jsonF.save();
      this.l4(`:yarnPreinstall->end`);
    } catch (e: anyOk) {
      throw stepErr(e, "preinstall");
    }
  };
  yarnInstall = async () => {
    this.l1(`->yarnInstall`);
    const start = new Date();
    await sh
      .exec(`yarn install --mutex file --verbose`, {
        prefix: this.log.prefix,
        verbose: UTIL_ENV.logLevel > 1,
        wd: this.pathAbs,
      })
      .catch(stepErrCb("install"));
    this.l1(`:yarnInstall->end ${Time.diff(start)}`);
  };

  yarnGenerate = async () => {
    if (!this.json.scripts?.["generate"]) return;
    this.l1(`->yarnGenerate`);
    const start = new Date();
    await sh
      .exec(`yarn generate`, {
        prefix: this.log.prefix,
        verbose: UTIL_ENV.logLevel > 1,
        wd: this.pathAbs,
      })
      .catch(stepErrCb("yarnGenerate"));
    this.l3(`:yarnGenerate->end ${Time.diff(start)}`);
  };

  /** Remove all crosslinks from package.json */
  yarnPrepack = async () => {
    this.l2(`->yarnPrepack`);
    try {
      const pjs = this.json;
      await this.jsonF.reset();
      const rm = (deps: Record<string, string> = {}) =>
        Object.entries(deps)
          .filter(([, v]) => v.startsWith("../") || v === "workspace:*")
          .forEach(([d]) => delete deps[d]);
      rm(pjs.dependencies);
      rm(pjs.devDependencies);
      rm(pjs.peerDependencies);
      await this.jsonF.save();
    } catch (e: anyOk) {
      throw stepErr(e, "prepack");
    }
    this.l4(`:yarnPrepack->end`);
  };
  yarnPack = async () => {
    this.l2(`->yarnPack`);
    await sh
      .exec(`yarn pack -f package.tgz`, { wd: this.pathAbs })
      .catch(stepErrCb("pack"));
    this.l4(`:yarnPack->end`);
  };
  yarnPostpack = async () => {
    this.l4(`->yarnPostpack`);
    await P.all([this.yarnCleanCache(), this.jsonF.reset()]).catch(
      stepErrCb("postpack")
    );
    this.l4(`:yarnPostpack->end`);
  };

  /** Basically just cleans previous builds */
  yarnPrebuild = async () => {
    try {
      this.l4(`->yarnPrebuild`);

      // mv src folder to ensure build doesn't yarn clean the yarn generated files
      // by backing up and restoring the src dir after running yarn clean
      let srcMoved = false;
      const srcDir = `${this.pathAbs}/src`;
      const srcDirBak = `${srcDir}.bak`;
      try {
        await fs.mv(srcDir, srcDirBak, { skipBackup: true });
        await fs.mkdir(srcDir);
        srcMoved = true;
      } catch (e) {}

      await P.all([
        fs.rm(`${this.pathAbs}/package.tgz`).catch(() => {}),
        fs.rm(`${this.pathAbs}/dist`).catch(() => {}),
        fs.rm(`${this.pathAbs}/build`).catch(() => {}),
        sh.exec(`yarn clean`, { wd: this.pathAbs }),
      ]);

      if (srcMoved) {
        await fs.rm(srcDir, { skipBackup: true });
        await fs.mv(srcDirBak, srcDir, { skipBackup: true });
      }

      this.l4(`:yarnPrebuild->end`);
    } catch (e) {
      throw stepErr(e, "prebuild");
    }
  };

  // static yarnBuildsActive = 0;
  // static yarnBuildsMax = osNode.cpus().length;
  yarnBuild = throttle(async () => {
    let start = new Date();
    // while (Pkg.yarnBuildsActive >= Pkg.yarnBuildsMax) {
    //   if (Date.now() - start.getTime() > 4000) {
    //     this.l1(`:yarnBuild->waiting ${Pkg.yarnBuildsActive}`);
    //     start = new Date();
    //   }
    //   await sh.sleep(200);
    // }
    // Pkg.yarnBuildsActive++;

    this.l1(`->yarnBuild`);
    // start = new Date();
    await sh
      .exec(`yarn build`, {
        prefix: this.log.prefix,
        verbose: UTIL_ENV.logLevel > 1,
        wd: this.pathAbs,
      })
      .catch(stepErrCb("build"));
    // Pkg.yarnBuildsActive--;
    this.l1(`:yarnBuild->end ${Time.diff(start)}`);
  });

  yarnPostbuild = async () => {
    try {
      // TODO: fix no-cache
      this.l4(`->yarnPostBuild`);
      await this.yarnPrepack();
      await this.yarnPack();
      await this.yarnPostpack();
      this.l4(`:yarnPostBuild->end`);
    } catch (e: anyOk) {
      throw stepErr(e, "postbuild");
    }
  };
}

class PkgWSync extends PkgWithBuild {
  /** syncs the build artifacts of workspace deps with a package's node_modules */
  syncCrosslinks = async (
    opts: {
      verbose?: boolean;
      watch?: boolean;
    } = {}
  ) => {
    const { verbose = true, watch = false } = opts;

    let log1 = this.l1;
    let log2 = this.l2;
    let log3 = this.l3;
    let log4 = this.l4;
    if (verbose) {
      log1 = log2 = log3 = log4 = this.l1;
    }

    if (watch) {
      this.log.showTimestamps = logDefault.showTimestamps = true;
      log1(`->watch`);
    } else log1(`->sync`);

    const nestedNodeModules = `${this.pathAbs}/node_modules`;

    // bail if there are no workspace deps
    if (!(await fs.stat(nestedNodeModules).catch(() => {}))) {
      log3(`->no ws packages to sync`);
      return;
    }

    const excludes = [
      ".envrc",
      ".envrc.local",
      "cortex",
      "jest",
      "node_modules",
      "package.tgz",
      "src",
      "README.md",
      "stories",
      ".storybook",
      "storybook",
      "styleguide",
      "yarn.lock",
    ];

    const pkgsToWatch = this.dependencyClsForInstall;

    const doSync = async () => {
      log3(`->syncing`);
      const delta = await P.all(
        pkgsToWatch.map(async (cl) => {
          if (await fs.stat(`${cl.pathAbs}`).catch(() => {})) {
            const res = await sh.exec(
              `rsync ${cl.pathRel}/ ` +
                `${nestedNodeModules}/${cl.json.name} ` +
                `-av --delete ` +
                excludes.map((e) => `--exclude=${e}`).join(" "),
              { wd: this.pathWs, silent: !verbose }
            );
            await fs.rm(`${nestedNodeModules}/.cache`).catch(() => {});
            return res;
          }
          return "";
        })
      );

      const trimmed = delta
        // join and split bc is an array of multiline strings
        .join("\n")
        .split("\n")
        .filter((l) => l.trim())
        .filter((r) => !r.includes("..."))
        .filter((r) => !r.includes("created"))
        .filter((r) => !r.includes("done"))
        .filter((r) => !r.includes("./"))
        .filter((r) => !r.includes("sent"))
        .filter((r) => !r.includes("total"));
      trimmed.forEach((l) => {
        if (verbose) log1(`: ${l} upserted`);
      });

      log2(`->synced ${trimmed.length} packages`);
      return trimmed;
    };

    await doSync();

    if (watch) {
      const watcher = chokidar.watch([], {
        // FIXME: maybe don't sync whole folder
        ignored: new RegExp(`(${excludes.join("|")})`),
        persistent: true,
      });
      watcher.on("change", () => doSync());
      for (const cl of pkgsToWatch) {
        log1(`->watching: ${cl.pathRel}`);
        await watcher.add(`${cl.pathAbs}`);
      }
      return () => watcher.close().then(() => this.l1(`->end`));
    }
    log4(`->end`);
  };
}

/** The final class to be exported */
export class Pkg extends PkgWSync {}
