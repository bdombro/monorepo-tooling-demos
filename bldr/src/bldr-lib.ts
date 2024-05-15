import chokidar from "chokidar";
import {
  cachify,
  FileI,
  fs,
  LocalCache,
  Log,
  logDefault,
  O,
  P,
  sh,
  stepErr,
  stepErrCb,
  Time,
  Yarn,
  md5,
  A,
  strFileEscape,
  UTIL_ENV,
  SMM,
  Tree,
  Is,
  strCompare,
  throttle,
  str,
  strMatchMany,
} from "./util.js";

export type PkgArtifactAttrs = {
  pkg: string;
  combined: string;
  deps: Dict;
  files: Dict;
};

export type PkgMeta = {
  bldArtifactAttrsCreateLast: {
    val: PkgArtifactAttrs;
    ts: string;
  };
  stats: {
    buildTimes: number[];
    buildSizes: number[];
    bootstrapTimes: number[];
    cacheMissReason: string;
  };
};

export class Bldr {
  static logFile = Log.file.replace(fs.home, "~");
  static log = new Log({ prefix: "BLDR" });
  static l0 = Bldr.log.l0;
  static l1 = Bldr.log.l1;
  static l2 = Bldr.log.l2;
  static l3 = Bldr.log.l3;
  static l4 = Bldr.log.l4;
  static l5 = Bldr.log.l5;
  static l9 = Bldr.log.l9;
  static lerr = Bldr.log.lerr;
  static lwarn = Bldr.log.lwarn;
  static lFinish = Bldr.log.lFinish;

  static bootstrap = async (opts: { noCache: boolean; pkgs?: Pkg[] }) => {
    Bldr.l1(`->strap: ${opts.pkgs?.map((p) => p.basename).join(", ")}`);
    Bldr.l2(`->log: ${Bldr.logFile}`);
    const start = Date.now();
    const { noCache } = opts;
    const pkgs = opts.pkgs ?? (await Bldr.find());
    A.dedup(pkgs);
    pkgs.sort((a, b) => strCompare(a.name, b.name));
    for (const pkg of pkgs) {
      await pkg.bootstrapMain({ noCache });
    }
    Bldr.l1(`<-strap ${Time.diff(start)}`);
  };

  static build = async (opts: { noCache: boolean; pkgs?: Pkg[] }) => {
    Bldr.l1(`->build: ${opts.pkgs?.map((p) => p.basename).join(", ")}`);
    Bldr.l2(`->log: ${Bldr.logFile}`);
    const start = Date.now();
    const { noCache } = opts;
    const pkgs = opts.pkgs ?? (await Bldr.find());
    A.dedup(pkgs);
    pkgs.sort((a, b) => strCompare(a.name, b.name));
    await P.all(pkgs.map((pkg) => pkg.bldMain({ noCache })));
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
      /** clean pkg metastores where we store stats and misc info about packages */
      metaStore?: boolean;
      /** Exclude some packages from clean, by domain and/or name */
      nodeModulesAll?: boolean;
      /** Whether to rimraf the entire node_modules folders */
      nodeModuleCrosslinks?: boolean;
      /** Clean the workspace: bld artifacts, metastore, and nodeModuleCrosslinks */
      ws?: boolean;
      /** clean yarn caches: is slow fyi */
      yarnCache?: boolean;
    },
  ) => {
    const { excludes, includes, ...flags } = opts;
    try {
      if (!O.vals(flags).some(Boolean)) {
        throw stepErr(Error("clean->no opts provided, exiting"), "clean");
      }

      // Handle the all and allButNm flags
      if (opts.all) {
        if (Is.und(opts.buildCache)) opts.buildCache = true;
        if (Is.und(opts.ws)) opts.ws = true;
        if (Is.und(opts.yarnCache)) opts.yarnCache = true;
      }

      if (opts.ws) {
        if (Is.und(opts.builds)) opts.builds = true;
        if (Is.und(opts.metaStore)) opts.metaStore = true;
        if (Is.und(opts.nodeModuleCrosslinks)) opts.nodeModuleCrosslinks = true;
      }

      await fs.findNearestWsRoot(); // asserts we are in a ws and pumps cache

      const pkgs = await Bldr.find({
        includes,
        excludes,
        dependents: opts.includeDependents,
      });

      if (!pkgs.length) throw stepErr(Error("No packages found for filters"), "clean.find");

      if (opts.includeDependencies) {
        pkgs.map((p) => pkgs.push(...p.dcClsForInstall));
      }
      if (opts.includeDependents) {
        pkgs.map((p) => pkgs.push(...p.dtClsFlat));
      }

      A.dedup(pkgs);
      pkgs.sort((a, b) => strCompare(a.name, b.name));

      Bldr.l1(`->clean ${pkgs.length} packages`);

      for (const p of pkgs) {
        Bldr.l2(`:clean->${p.basename}`);
        const _p: Promise<anyOk>[] = [];
        if (opts.builds) _p.push(p.bldClean());
        if (opts.buildCache) _p.push(p.bldArtifactCachePurge());
        if (opts.metaStore) _p.push(p.pkgMetaFile.delP());
        if (opts.nodeModulesAll) _p.push(p.nodeModulesClean({ hard: true }));
        else if (opts.nodeModuleCrosslinks) _p.push(p.nodeModulesClean());
        if (opts.yarnCache) _p.push(p.yarnCacheClean());
        await P.allF(_p);
      }

      Bldr.l2(`<-clean`);
    } catch (e) {
      throw stepErr(e, "clean", { cwd: process.cwd() });
    }
  };

  /** Find packages */
  static find = async (
    opts: SMM & {
      /** build dependent tree */
      dependents?: boolean;
    } = {},
  ) => {
    const { excludes, includes, dependents } = opts;

    if (dependents) {
      const pkgBasenamesAll = await Bldr.findPkgPaths();
      const pkgsAll = await P.all(pkgBasenamesAll.map((n) => Bldr.get(n)));
      await P.all(pkgsAll.map((p) => p.treeBldDependents()));
    }

    const pkgBasenames = await Bldr.findPkgPaths({ excludes, includes });
    const pkgs = await P.all(pkgBasenames.map((n) => Bldr.get(n)));
    return pkgs;
  };

  static configGet = cachify(async () => {
    const wsRoot = await fs.findNearestWsRoot();
    interface ConfRaw {
      buildLogFilters: (string | RegExp)[];
      installLogFilters: (string | RegExp)[];
      postBuildSourceCheckIgnores: string[];
    }
    const confRaw: ConfRaw = await import(`${wsRoot}/.bldrrc.mjs`).then((m) => m.default).catch(() => ({}));

    const conf = {
      buildLogFilters: [...(confRaw.buildLogFilters ?? [])],
      installLogFilters: [...(confRaw.installLogFilters ?? [])],
      postBuildSourceCheckIgnores: ["__generated__", ...(confRaw.postBuildSourceCheckIgnores ?? [])],
    };

    return conf;
  });

  /**
   * Gets a Pkg instance from a pkg path, basename, or package name
   *
   * - uses custom cache
   */
  static get = async (pathOrName: string): Promise<Pkg> => {
    Bldr.l4(`:get->${pathOrName}`);
    pathOrName = pathOrName.replace(/\.\/$/, "").replace(/\.$/, "").replace(/\/$/, "");

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

    if (Bldr.getCache.has(pathRel)) {
      Bldr.l4(`:get->cache-hit`);
      return Bldr.getCache.get(pathRel)!;
    }

    const pkgPwr = P.wr<Pkg>();
    Bldr.getCache.set(pathRel, pkgPwr.promise);

    Bldr.l4(`:${basename.toUpperCase()}:get:path->match`);
    Bldr.l4(`:${basename.toUpperCase()}:get:path->${pathAbs}`);

    try {
      const jsonF = await fs.getPkgJsonFile(pathAbs);
      const pkg = new Pkg(jsonF, pathAbs, pathRel, pathWs);
      await pkg.configGet();
      await pkg.treeBldDependencies();
      Bldr.l3(`<-get for ${basename}`);
      pkgPwr.resolve(pkg);
      return pkg;
    } catch (e: anyOk) {
      // eslint-disable-next-line no-ex-assign
      e = stepErr(e, "getPkg", { pathOrName });
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
    } = {},
  ) => {
    const { maxConcurrent } = opts;
    const exec = throttle(
      (pkg: Pkg) =>
        sh.exec(cmd, {
          prefix: pkg.basename.toLocaleUpperCase() + ":SH:",
          printOutput: true,
          wd: pkg.pathAbs,
        }),
      {
        maxConcurrent,
      },
    );
    await P.all(pkgs.map(exec));
  };

  static findPkgPaths = async (options: SMM = {}): Promise<string[]> => {
    const { includes } = options;
    const { excludes } = options;
    const wsRoot = await fs.findNearestWsRoot();
    const pkgDir = `${wsRoot}/packages`;

    const paths: string[] = [];

    if (includes?.length) {
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
        ...(await fs.find(pkgDir, {
          excludes,
          includes,
          typeFilter: "dir",
        })),
      );
    }

    if (!paths.length)
      throw stepErr(Error('No packages found in "packages" directory'), "Pkgs.getPkgNames", { pkgDir });
    paths.sort(strCompare);
    return paths;
  };

  static treeViz = async (options: SMM & { embedded?: boolean; print?: boolean } = {}) => {
    const { includes, excludes, embedded, print = true } = options;

    let txt = "\n";

    const pkgs = await Bldr.find({ dependents: true, includes, excludes });

    for (const pkg of pkgs) {
      pkg.treeSort();

      if (!embedded) txt += `${Log.cyan(pkg.name.toLocaleUpperCase())} \n\n`;

      txt += `--dependencies--\n\n`;
      txt += Tree.viz(pkg, { childrenKey: "dcs", nameKey: "treeName" }) + "\n\n";
      txt += `--dependents--\n\n`;
      txt += Tree.viz(pkg, { childrenKey: "dts", nameKey: "treeName" }) + "\n\n\n";
    }

    txt += `-----------\n` + `Legend\n` + `↑: has crosslink dependencies\n` + `↓: has crosslink dependents\n` + "\n";

    if (print) console.log(txt);
    return txt;
  };
}

/**
 * Using a base classes makes a bit more organized, DRY and we can use the type
 * in Pkg without circular refs
 */

class PkgBase {
  constructor(
    public jsonF: ReturnTypeP<typeof fs.getPkgJsonFile>,
    public pathAbs: string,
    public pathRel: string,
    public pathWs: string,
  ) {}
}

/**
 * Adds custom logger with prefix = pkg.basename
 *
 * The implimentatation basically extends PkgBase with Log using O.ass, bc JS disallows extending
 * from two classes.
 */
class PkgWLogs extends PkgBase {
  public log!: Log;
  public l0!: Log["l0"];
  public l1!: Log["l1"];
  public l2!: Log["l2"];
  public l3!: Log["l3"];
  public l4!: Log["l4"];
  public l5!: Log["l5"];
  public l9!: Log["l9"];
  public ldbg!: Log["ldbg"];
  public lwarn!: Log["lwarn"];

  constructor(...args: ConstructorParameters<typeof PkgBase>) {
    super(...args);
    const basename = fs.basename(this.pathAbs).toUpperCase();
    this.log = new Log({ prefix: basename });
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
  get name() {
    return this.jsonF.json.name;
  }

  configGet = async () => {
    const wsConf = await Bldr.configGet();
    interface PkgConfRaw {
      buildLogFilters: (string | RegExp)[];
      installLogFilters: (string | RegExp)[];
      postBuildSourceCheckIgnores: string[];
    }
    const pkgConfRaw: PkgConfRaw = await import(`${this.pathAbs}/.pkg.bldrrc.mjs`)
      .then((m) => m.default)
      .catch(() => ({}));

    const pkgConf: PkgConfRaw = O.merge(wsConf, pkgConfRaw);
    this.conf = pkgConf;
  };
  conf!: {
    buildLogFilters: (string | RegExp)[];
    installLogFilters: (string | RegExp)[];
    postBuildSourceCheckIgnores: string[];
  };
}

class PkgWTree extends PkgWGetSets {
  /** dependencies: pkgs in pkgJson.dependencies or pkgJson.devDependencies */
  public dcs: Pkg[] = [];
  /** dependency crosslinks: dependencies which are linked via crosslinks in pkgJson.dependencies or pkgJson.devDs */
  public dcCls: Pkg[] = [];
  /** dependency crosslinks, flattened so all the cls are at top level of array */
  public dcClsFlat: Pkg[] = [];
  /**
   * dependencyClsFlat + devDeps (non-recursively)
   * - Are the pkgs needed to be installed in this pkg's node_modules.
   */
  public dcClsForInstall: Pkg[] = [];

  /** dependents: pkgs which have this pkg in their pkgJson.dependencies or pkgJson.devDs */
  public dts: Pkg[] = [];
  /** dependent crosslinks: crosslink pkgs which have this pkg in their pkgJson.dependencies or pkgJson.devDs */
  public dtCls: Pkg[] = [];
  /** dependent crosslinks, flattened so all the cls are at top level of array */
  public dtClsFlat: Pkg[] = [];

  get treeName() {
    let name = this.basename + " ";
    const hasDownCls = this.dtCls.length > 0;
    const hasUpCls = this.dcCls.length > 0;
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

          const pkg = await Bldr.get(pkgName);

          this.dcs.push(pkg);

          if (isCl) {
            if (this.json.dependencies && pkgName in this.json.dependencies) {
              this.dcClsFlat.push(pkg);
              this.dcClsFlat.push(...pkg.dcClsFlat);
            } else {
              childrenDDeps.push(pkg);
            }
            this.dcCls.push(pkg);
          }
        }),
      );
      this.dcClsForInstall.push(...this.dcClsFlat, ...childrenDDeps);
      A.dedup(this.dcs);
      A.dedup(this.dcCls);
      A.dedup(this.dcClsFlat);
      A.dedup(this.dcClsForInstall);
    } catch (e: anyOk) {
      throw stepErr(e, "treeBldDependencies", { pkg: this.basename });
    }
  };

  treeBldDependents = cachify(async () => {
    try {
      this.l4(`->treeBldDependents`);
      const pkgs = await Bldr.find();
      for (const pkg of pkgs) {
        const deps = { ...pkg.json.dependencies, ...pkg.json.devDependencies };
        if (this.name in deps) {
          this.dts.push(pkg);
          if (deps[this.name] === "workspace:*") {
            this.dtCls.push(pkg);
            this.dtClsFlat.push(pkg);
            this.dtClsFlat.push(...pkg.dtClsFlat);
          }
        }
      }
      await P.all(this.dts.map((cl) => cl.treeBldDependents()));
      A.dedup(this.dts);
      A.dedup(this.dtCls);
      A.dedup(this.dtClsFlat);
    } catch (e: anyOk) {
      throw stepErr(e, "treeBldDependents", { pkg: this.basename });
    }
  });

  treeSort = () => {
    this.dcs.sort((a, b) => strCompare(a.name, b.name));
    this.dts.sort((a, b) => strCompare(a.name, b.name));
  };
}

class PkgWithBuild extends PkgWTree {
  public bldArtifactAttrsCreate = async (opts: { bustCache?: boolean } = {}): Promise<PkgArtifactAttrs> => {
    const { bustCache } = opts;
    if (this._bldArtifactAttrsCreateVal && !bustCache) return this._bldArtifactAttrsCreateVal;
    try {
      this.l3(`->bldArtifactAttrsCreate`);

      const srcCsums = await this.bldArtifactAttrsGetSrcCsums();
      const depCsums = await this.bldArtifactAttrsGetDepCsums();
      const srcAndDepCsums = O.sort({ ...srcCsums, ...depCsums });
      const combinedMd5 = md5(O.vals(srcAndDepCsums), { errStep: "combine" });

      const attrs: PkgArtifactAttrs = {
        pkg: this.name,
        combined: combinedMd5,
        deps: depCsums,
        files: srcCsums,
      };

      return (this._bldArtifactAttrsCreateVal = attrs);
    } catch (e) {
      throw stepErr(e, "bldArtifactAttrsCreate");
    }
  };
  private _bldArtifactAttrsCreateVal?: PkgArtifactAttrs;

  /**
   * uses a heuristic to discover source files in a package and csum them, while trying
   * to avoid csuming files that are not critical source files.
   */
  private bldArtifactAttrsGetSrcCsums = async (): Promise<Dict> => {
    try {
      this.l4(`->bldArtifactAttrsGetSrcCsums`);

      const srcDirIsPresent = await fs.stat(`${this.pathAbs}/src`).catch(() => {});

      // A list of abs paths to include in the csum, which could be a file or dir.
      const includePaths: string[] = [];

      // A list of regexes to exclude from the csum
      const excludes: (string | RegExp)[] = [
        "/.", // hidden files/dirs
        ".test.",
        ".spec.",
        ".stories.",
      ];
      const excludeStrsIfEndsWith: string[] = ["/spec", "/test", "/__test__", "/__tests__", "/stories", "/__stories__"];

      // 1. If there is a src dir, we md5 the src dir, package.json and yarn.lock
      if (srcDirIsPresent) {
        this.l4(`:srcDirIsPresent`);
        includePaths.push(...["package.json", "src", "yarn.lock"]);
      }
      // 2. Else, we md5 the entire package dir with exclusions
      else {
        this.l4(`:srcDirIsNotPresent`);
        includePaths.push(this.pathAbs);
        try {
          excludeStrsIfEndsWith.push(
            ...[
              "/build",
              "/CONTRIBUTING.md",
              "/cortex.yaml",
              "/coverage",
              "/dist",
              "/LICENSE.md",
              "/jest",
              "/lint",
              "/node_modules",
              "/package.tgz",
              "/public",
              "/README.md",
              "/story",
              "/styleguide",
              "/tsconfig.json",
            ],
          );

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
          const pkgExportPaths = this.json.exports ? O.valsRecursive(this.json.exports) : [];
          const pkgExportDirs = pkgExportPaths.map((p) => {
            let dir = p;
            dir = dir.replace(/^\.?\//, ""); // kill ^./ || ^/
            dir = dir.split("/")[0]; // kill everything after the first dir
            dir = this.pathRel + "/" + dir;
            return dir;
          });
          excludes.push(...pkgExportDirs);
        } catch (e) {
          throw stepErr(e, "srcDirIsNotPresent");
        }
      }

      if (excludeStrsIfEndsWith.length) {
        excludes.push(RegExp("(" + A.toDedup(excludeStrsIfEndsWith).join("|") + ")$"));
      }

      // Convert a relative path to an absolute path
      const relToAbs = (p: string) => (p.startsWith("/") ? p : `${this.pathAbs}/${p}`);

      A.mapInPlace(includePaths, relToAbs);

      const srcCsums = await fs.md5(includePaths as [string], { excludes });

      if (O.empty(srcCsums)) throw Error("No src files found to pkg");

      // make the paths relative to the package root
      const srcCsumsRel = O.ents(srcCsums).reduce<Dict>((acc, [k, v]) => {
        acc[k.replace(this.pathAbs + "/", "")] = v;
        return acc;
      }, {});

      return srcCsumsRel;
    } catch (e) {
      throw stepErr(e, "bldArtifactAttrsGetSrcCsums");
    }
  };

  private bldArtifactAttrsGetDepCsums = async (): Promise<Dict> => {
    const depCsums: Dict = O.fromEnts<string>(
      await P.all(
        O.vals(this.dcCls).map(async (cl): Promise<[string, string]> => {
          const clAttrs = await cl.bldArtifactFile.gattrsP();
          return [cl.name, clAttrs.combined];
        }),
      ),
    );
    return depCsums;
  };

  /** Gets this's build artifact from the cache if exists. return null if not. */
  // TODO: bring bldArtifactCachePut back, but maybe reduce to make cleaner
  private bldArtifactCacheGet = async () => {
    try {
      if (await this.bldArtifactIsUpToDate()) {
        this.l3(`->no-change`);
      }
      const bldAttrsExpected = await this.bldArtifactAttrsCreate();
      const cacheKey = this.bldArtifactCacheKey(bldAttrsExpected);
      this.l4(`:cacheGet->${cacheKey}`);
      const cached = await Pkg.bldLocalCache.get(cacheKey);
      this.l3(`:cacheGet->hit`);

      await this.bldArtifactFile.set({
        buffer: cached.buffer,
        gattrs: cached.attrs,
      });

      // end cacheGet main
    } catch (e) {
      throw stepErr(e, "cacheGet");
    }
  };

  /** Note if you change this, you also need to change bldArtifactCachePurge filter */
  get bldArtifactCachePrefix() {
    return strFileEscape(`${this.name.slice(1)}-`);
  }
  /** Note if you change this, you also need to change bldArtifactCachePurge filter */
  private bldArtifactCacheKey = (attrs: PkgArtifactAttrs) => {
    const cacheKey = `${this.bldArtifactCachePrefix}-${attrs.combined}.tgz`;
    return cacheKey;
  };

  public bldArtifactCacheList = async () => {
    return Pkg.bldLocalCache.find({ includes: [this.bldArtifactCachePrefix] });
  };

  public bldArtifactCachePurge = async () => {
    try {
      await Pkg.bldLocalCache.purge({
        includes: [this.bldArtifactCachePrefix],
      });
    } catch (e) {
      throw stepErr(e, "cachePurge");
    }
  };

  /** Gets the class instance of the artifact file */
  public get bldArtifactFile() {
    if (this._bldArtifactFile) return this._bldArtifactFile;
    this._bldArtifactFile =
      this._bldArtifactFile ??
      fs.get<never, PkgArtifactAttrs>(this.bldArtifactPath, {
        gattrsDefault: {
          pkg: this.name,
          combined: "",
          deps: {},
          files: {},
        },
      });
    return this._bldArtifactFile;
  }
  /** Don't use this directly */
  private _bldArtifactFile?: ReturnTypeP<typeof fs.get<never, PkgArtifactAttrs>>;

  /** check if build artifact already in workspace is up to date **/
  public bldArtifactIsUpToDate = async (): Promise<boolean> => {
    this.l4(`->bldArtifactIsUpToDate`);
    let existing: PkgArtifactAttrs;
    try {
      existing = await this.bldArtifactFile.gattrsP();
    } catch (e) {
      this.l3(`->existing build is stale`);
      return false;
    }
    const expected = await this.bldArtifactAttrsCreate();
    if (existing.combined === expected.combined) {
      this.l3(`->existing build is up to date`);
      await this.pkgMetaFile.setCacheMissReason("");
      return true;
    }

    // if we get here, the bld artifact is not up to date
    // so we log the differences
    const cmp = O.cmp({ ...existing.deps, ...existing.files }, { ...expected.deps, ...expected.files });
    if (cmp.equals) {
      throw stepErr(Error("combined csum changed but files didn't"), "bldArtifactIsUpToDate");
    }
    cmp.added.forEach((pathRel) => this.l2(`:added->${pathRel}`));
    cmp.modified.forEach((pathRel) => this.l2(`:changed->${pathRel}`));
    cmp.removed.forEach((pathRel) => this.l2(`:removed->${pathRel}`));

    await this.pkgMetaFile.setCacheMissReason(cmp.changed.join(", "));
    return false;
  };

  public bldClean = async () => {
    try {
      await P.all([
        fs.rm(`${this.pathAbs}/build`).catch(() => {}),
        fs.rm(`${this.pathAbs}/dist`).catch(() => {}),
        this.bldArtifactFile.delP().catch(() => {}),
      ]);
    } catch (e) {
      throw stepErr(e, "pkg.cleanBld");
    }
  };

  private static bldLocalCache = new LocalCache<PkgArtifactAttrs>(`${fs.home}/.bldr/cache`);

  private bldDependencies = async (opts: { noCache: boolean }) => {
    try {
      if (this._bldDependencies || A.empty(this.dcClsForInstall)) return;

      this.l3(`->building deps: ${this.dcClsForInstall.map((cl) => cl.basename).join(", ") || "no-deps"}`);
      const { noCache } = opts;
      await P.all(
        this.dcClsForInstall.map(async (cl) => {
          await cl.bldMain({ noCache, recursed: true });
        }),
      );
      this._bldDependencies = true;
      this.l4(`<-building deps`);
      return;
    } catch (e) {
      throw stepErr(e, "bldDependencies", { parent: this.basename });
    }
  };
  private _bldDependencies = false;

  public bldMain = async (opts: { noCache: boolean; recursed?: boolean }) => {
    if (this._bldMainLast) return this._bldMainLast;

    if (!this.json?.scripts?.build) {
      this.l1(`->build skipped (no build script)`);
      return;
    }

    const pwv = P.wr<void>();
    this._bldMainLast = pwv.promise;

    try {
      const start = Date.now();
      const { noCache, recursed } = opts;

      if (!recursed && this.dcClsForInstall.length) {
        this.l2(`->building w/ deps: ${this.dcClsForInstall.map((cl) => cl.basename).join(", ") || "no-deps"}`);
      }

      await this.bldDependencies({ noCache });

      const cached = await this.bldArtifactCacheGet()
        .then(() => true)
        .catch(() => false);

      let bootTime = 0;
      let bldStart = Date.now();

      if (cached) {
        if (!recursed) this.l2(`->cache-hit`);
      } else {
        this.l3(`->building`);
        const bootStart = Date.now();
        await this.bootstrapMain({ noCache });
        bootTime = Date.now() - bootStart;
        bldStart = Date.now();
        await this.pkgJsonPrebuild();
        await this.pkgJsonBuild();
        await this.pkgJsonPostbuild();
        // update build stats
        await this.pkgMetaFile.setStats(bootTime, Date.now() - bldStart);
      }

      this.l3(`<-bldMain ${Time.diff(start)}`);
      pwv.resolve();
    } catch (e: anyOk) {
      const e2 = stepErr(e, "bldMain");
      pwv.reject(e2);
      throw e2;
    }
  };
  private _bldMainLast?: Promise<void>;

  public bootstrapMain = async (opts: { noCache: boolean }) => {
    try {
      const { noCache } = opts;
      this.l3(`:bootstrapMain`);
      const start = Date.now();
      await this.pkgJsonPreinstall({ noCache });
      await this.pkgJsonInstall();
      await this.pkgJsonPostinstall();

      this.l3(`<-bootstrapMain ${Time.diff(start)}`);
    } catch (e: anyOk) {
      throw stepErr(e, "bootstrapMain");
    }
  };

  /**
   * The npm/yarn/pnpm lockfiles should never include crosslinks so that yarn always fresh installs them
   * - this mainly needs to be done in the preinstall and postinstall steps bc that's when yarn.lock is used.
   */
  private lockfileClean = async () => {
    const file = await fs.get(`${this.pathAbs}/yarn.lock`).cacheClear().read();

    // remove blocks like these:
    // ...
    //
    // "@app/lib1@../lib1/package.tgz":
    //   version "1.0.4"
    //    resolved "../lib1/package.tgz#bcd32b108f210537b31b6b1754ea7e8c0ddf742a"
    //    dependencies:
    //      lodash "4.10.0"
    //
    // ...
    const lines = file.text.split("\n");
    const newLines = [];
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("@../")) {
        changed = true;
        while (lines[i] !== "") {
          i++;
        }
      } else {
        newLines.push(lines[i]);
      }
    }
    if (changed) {
      await file.set({ text: newLines.join("\n") });
    }
  };

  public nodeModulesClean = async (opts: { hard?: boolean } = {}) => {
    try {
      const { hard } = opts;
      if (hard) {
        await fs.rm(`${this.pathAbs}/node_modules`).catch(() => {});
      } else {
        await P.all(
          this.dcClsForInstall.map(async (cl) => {
            await P.all([
              fs.rm(`${this.pathAbs}/node_modules/${cl.json.name}`, { force: true, recursive: true }),
              ...O.keys(cl.json?.bin ?? {}).map((k) =>
                fs.rm(`${this.pathAbs}/node_modules/.bin/${k}`, { force: true }),
              ),
            ]);
          }),
        );
      }
    } catch (e) {
      throw stepErr(e, "bootstrapClean");
    }
  };

  /**
   * Preps the package for install by:
   * 1. removing cls from yarn.lock
   * 2. upserting cls as ../[pkg]/package.tgz to package.json
   */
  public pkgJsonPreinstall = async (opts: { noCache: boolean }) => {
    try {
      this.l4(`->pkgJsonPreinstall`);
      const { noCache = false } = opts;

      const _p: Promise<anyOk>[] = [];

      // Ensure deps are ready
      _p.push(this.bldDependencies({ noCache }));

      // Clean node_modules
      _p.push(this.nodeModulesClean());

      // create backup of package.json to be restored in pkgJsonPostinstall
      _p.push(this.jsonF.snapshot("pkgJsonPreinstall"));

      // remove cls from yarn.lock so yarn fresh installs
      _p.push(this.lockfileClean());

      // upsert cls (incl nested) as ../[pkg]/package.tgz to package.json

      // assert that the package.json isn't currupt
      for (const [k, v] of O.ents({
        ...this.json.dependencies,
        ...this.json.devDependencies,
      })) {
        if (v.startsWith("../"))
          throw stepErr(
            Error(`package.json has relative dep and is likely currupt from a prior bootstrap failure: ${k} -> ${v}`),
            "preinstall",
          );
      }

      // swap out the workspace:* (aka cls) with relative paths and add nested
      /** jsonN = package.json next */
      const jsonN = O.cp(this.json);
      this.dcClsForInstall.forEach((cl) => {
        const name = cl.json.name;
        if (jsonN.dependencies?.[name]) {
          jsonN.dependencies[name] = `../${cl.basename}/package.tgz`;
        } else {
          if (!jsonN.devDependencies) jsonN.devDependencies = {};
          jsonN.devDependencies[name] = `../${cl.basename}/package.tgz`;
        }
      });
      // scrub out workspace:* (aka cls) from peerDependencies
      if (jsonN.peerDependencies)
        jsonN.peerDependencies = O.fromEnts(O.ents(jsonN.peerDependencies).filter(([, v]) => v !== "workspace:*"));

      await P.all(_p); // don't proceed to make changes until discovery phase is done.

      // commit package.json changes to filesystem
      await this.jsonF.set({ json: jsonN });

      this.l4(`<-pkgJsonPreinstall`);
    } catch (e: anyOk) {
      throw stepErr(e, "preinstall", { pkg: this.basename });
    }
  };

  private pkgJsonInstall = async () => {
    try {
      const start = new Date();
      const lastDuration = await this.pkgMetaFile.jsonP().then((m) => m.stats.bootstrapTimes[0] ?? 0);
      const lastDurationPretty = lastDuration ? Time.diff(0, lastDuration) : "";

      this.l1(`->install ${lastDurationPretty ? `(took ${lastDurationPretty} last time)` : ""}`);

      await this.jsonF.disableHooks().save();

      const i = setInterval(() => {
        this.l2(`:install->working...${Time.diff(start)}`);
      }, 30000);

      let tries = 0;

      const yi = () =>
        sh
          .exec(`yarn install` + (UTIL_ENV.logLevel >= 5 ? " --verbose" : ""), {
            logFilter: (l) => {
              if (l.includes("peer dependency")) return false;
              const match = this.conf.installLogFilters.some((f) => {
                if (Is.str(f)) return l.includes(f);
                if (Is.regex(f)) return !!l.match(f);
                return false;
              });
              return !match;
            },
            prefix: this.basename.toLocaleUpperCase() + ":INS:",
            verbose: UTIL_ENV.logLevel > 1,
            wd: this.pathAbs,
          })
          .catch(async (e) => {
            // Retry bc yarn install is flaky due to cache and registry failures.
            // Error=`
            //   error Extracting tar content of undefined failed, the file appears to be corrupt:
            //   "ENOENT: no such file or directory, open '/Users/brian.dombrowski/Library/Caches/\
            //   Yarn/v6/.tmp/c552cbe84befea3187841faab0c30e00/package.json'"`
            // Error2=`
            //   error Error: ENOENT: no such file or directory, copyfile '/Users/brian.dombrowski/\
            //   Library/Caches/Yarn/v6/.tmp/c552cbe84befea3187841faab0c30e00/src/index.ts' -> '/Users\
            //   /brian.dombrowski/Library/Caches/Yarn/v6/npm-@app-lib1-1.0.4-7bd590437db3a3403bdd38aa1993fe899aa7a941\
            //   /node_modules/@app/lib1/src/index.ts'
            if (tries++ < 4) {
              let reason = "unk";
              if (e.message.includes("Extracting tar content of undefined failed, the file appears to be corrupt"))
                reason = "cc1";
              if (e.message.includes("ENOENT: no such file or directory, copyfile")) reason = "cc2";
              this.lwarn(`:retrying->yarn-install (${reason}) - try ${tries}/4`);
              await sh.sleep(1000 * tries);
              await yi();
            } else {
              throw e;
            }
          });

      await yi();

      clearInterval(i);

      await this.jsonF.enableHooks().save();
      this.l2(`<-install ${Time.diff(start)}`);
    } catch (e: anyOk) {
      throw stepErr(e, "pkgJsonInstall", { pkg: this.basename });
    }
  };

  public pkgJsonPostinstall = async () => {
    this.l4(`->reset`);
    try {
      await P.all([
        this.lockfileClean(),
        // restore the dependencies in package.json
        this.jsonF.snapshotRestore("pkgJsonPreinstall"),
      ]);
    } catch (e: anyOk) {
      throw stepErr(e, "pkgJsonPostinstall", { pkg: this.basename });
    }
    this.l3(`<-reset`);
  };

  /** Basically just cleans previous builds */
  public pkgJsonPrebuild = async () => {
    try {
      this.l4(`->pkgJsonPrebuild`);

      await this.bldClean();

      // save the attrs so we can retrieve it in pkgJsonPostbuild
      await this.pkgMetaFile.setBldArtifactAttrsCreateLast();

      this.l4(`<-pkgJsonPrebuild`);
    } catch (e) {
      throw stepErr(e, "pkgJsonPrebuild", { pkg: this.basename });
    }
  };

  private pkgJsonBuild = throttle(async () => {
    try {
      const start = new Date();
      const lastDuration = await this.pkgMetaFile.jsonP().then((m) => m.stats.buildTimes[0] ?? 0);
      const lastDurationPretty = lastDuration ? Time.diff(0, lastDuration) : "";

      if (!this.json?.scripts?.build) {
        this.l1(`->build skipped (no build script)`);
        return;
      }

      this.l1(`->build ${lastDurationPretty ? `(took ${lastDurationPretty} last time)` : ""}`);

      // THis is the old method, which calls yarn build directly. This is not ideal bc it's
      // more indirect and requires disabling hooks prior to build.
      // await this.jsonF.disableHooks().save();
      // await sh.exec(`yarn build`, {...
      // await this.jsonF.enableHooks().save();

      const i = setInterval(() => {
        if (UTIL_ENV.logLevel == 1) this.l1(`:build->working...${Time.diff(start)}`);
      }, 30000);
      await sh
        .exec(`export PATH=$PATH:./node_modules/.bin; ${this.json.scripts.build}`, {
          logFilter: (l) => {
            const match = this.conf.buildLogFilters.some((f) => {
              if (Is.str(f)) return l.includes(f);
              if (Is.regex(f)) return !!l.match(f);
              return false;
            });
            return !match;
          },
          prefix: this.basename.toLocaleUpperCase() + ":BLD:",
          verbose: UTIL_ENV.logLevel > 1,
          wd: this.pathAbs,
        })
        .catch((e) => {
          throw stepErr(e, "pkgJsonBuild");
        });
      clearInterval(i);

      this.l2(`<-build ${Time.diff(start)}`);
    } catch (e: anyOk) {
      throw stepErr(e, "pkgJsonBuild", { pkg: this.basename });
    }
  });

  public pkgJsonPostbuild = async () => {
    try {
      this.l4(`->pkgJsonPostBuild`);
      const start = new Date();
      await this.pkgJsonPostBuildAssertIntegrity();
      await this.pkgJsonPostBuildPack();
      await P.all([this.pkgJsonPostBuildCacheAdd(), this.yarnCacheClean()]);
      this.l4(`<-pkgJsonPostBuild ${Time.diff(start)}`);
    } catch (e: anyOk) {
      throw stepErr(e, "pkgJsonPostbuild", { pkg: this.basename });
    }
  };

  private pkgJsonPostBuildAssertIntegrity = async () => {
    //
    // assert src csum has not changed from before build. If it has, it means that
    // csum is including build artifacts which is bad which means that cache will always miss.
    //
    // The fix is to fix the build, or add the troubled files to ignore in .pkg.bldrrc.mjs
    //

    if (!this.pkgMetaFile.exists) {
      throw stepErr(
        Error("pkgMetaFile doesn't exist. Maybe pkgJson-preinstall was missed or failed."),
        "pkgJsonPostBuildAssertIntegrity",
      );
    }
    const attrsBefore = (await this.pkgMetaFile.jsonP()).bldArtifactAttrsCreateLast.val;
    const attrsAfter = await this.bldArtifactAttrsCreate({ bustCache: true });
    const cmpAttrsBefore = O.fromEnts([...O.ents(attrsBefore.deps), ...O.ents(attrsBefore.files)]);
    const cmpAttrsAfter = O.fromEnts([...O.ents(attrsAfter.deps), ...O.ents(attrsAfter.files)]);
    for (const i of this.conf.postBuildSourceCheckIgnores) {
      O.ents(cmpAttrsBefore)
        .filter(([k, v]) => (Is.regex(i) ? k.match(i) : k.includes(i)))
        .forEach(([k, v]) => delete cmpAttrsBefore[k]);
      O.ents(cmpAttrsAfter)
        .filter(([k, v]) => (Is.regex(i) ? k.match(i) : k.includes(i)))
        .forEach(([k, v]) => delete cmpAttrsAfter[k]);
    }
    const cmp = O.cmp(cmpAttrsBefore, cmpAttrsAfter);
    if (!cmp.equals) {
      throw stepErr(
        Error("attrs changed after build. This means that bldr is csuming build artifacts (bad!)"),
        "csumChangedCheck",
        { cmp: O.omit(cmp, ["changed"]) },
      );
    }
  };

  /** Pack the package into a tgz file and add it to caches. */
  private pkgJsonPostBuildPack = async () => {
    //
    // We need to do this for libs AND apps, bc we need to cache the build artifacts for apps.
    //
    // Pro for caching apps:
    // - building the entore ws is possible and reasonably quick. May be helpful for ws wide analysis
    //   such as app size analysis
    // - Much much faster E2E testing
    // - may be useful for bundle size analysis
    // Con:
    // - costs ~7s per app.
    //

    this.l3(`:pkgJsonPostBuild->pack`);

    // a snapshot of package.json to restore post-pack
    const jsonPrePack = O.cp(this.json);

    // Disable hooks, to avoid hooks being fired on install, yarn stupidly tries to do even if the
    // hook is in a dependency package.json. I think this is probably a bug in yarn.
    this.jsonF.disableHooks();

    // Remove script hooks and crosslinks from package.json
    const rmCls = (deps: Record<string, string> = {}) =>
      Object.entries(deps)
        .filter(([, v]) => v.startsWith("../") || v === "workspace:*")
        .forEach(([d]) => delete deps[d]);
    rmCls(this.jsonF.json.dependencies);
    rmCls(this.jsonF.json.devDependencies);
    rmCls(this.jsonF.json.peerDependencies);

    // Finally, commit the changes.
    await this.jsonF.save();

    await sh
      .exec(`yarn pack -f package.tgz`, { prefix: this.basename.toLocaleUpperCase() + ":PACK:", wd: this.pathAbs })
      .catch(stepErrCb("pkgJsonPack"));

    // Assert the packing succeeded
    await this.bldArtifactFile.existsP().then((e) => {
      if (!e) throw stepErr(Error("build artifact is missing"), "artifact-exists", { artPath: this.bldArtifactPath });
    });
    await this.bldArtifactFile.sizeP().then((s) => {
      if (s === 0)
        throw stepErr(Error("build artifact is empty"), "artifact-nonempty", { artPath: this.bldArtifactPath });
    });

    await this.jsonF.jsonSet(jsonPrePack).save();
  };

  /** adds (1) build meta to ws and(2) the build artifact (package.tgz) to caches (just local atm) */
  private pkgJsonPostBuildCacheAdd = async () => {
    try {
      this.l4(`->bldArtifactCacheAdd`);

      const _p: Promise<anyOk>[] = [];

      this.bldArtifactFile.cacheClear();
      const bldAttrsExpected = await this.bldArtifactAttrsCreate();

      // Set to workspace so we can validate if the ws build is up to date without hitting the cache.
      _p.push(this.bldArtifactFile.set({ gattrs: bldAttrsExpected }));

      const cacheKey = this.bldArtifactCacheKey(bldAttrsExpected);

      // stat cache before get to check if copy/download be skipped, bc we can skip if
      // the cache already has the package.tgz
      let stat = await Pkg.bldLocalCache.stat(cacheKey).catch(() => {});
      if (stat) {
        this.l1(`:cacheAdd->skip bc cache already has it`);
      } else {
        stat = await Pkg.bldLocalCache.add(cacheKey, await this.bldArtifactFile.bufferP(), { attrs: bldAttrsExpected });
      }

      await P.all(_p);

      this.l4(`<-bldArtifactCacheAdd`);
      return stat;
    } catch (e) {
      throw stepErr(e, "bldArtifactCacheAdd");
    }
  };

  public get pkgMetaFile() {
    // FIXME: We should break the pkgMetaFile into a separate class and extend from File, and not access the file
    // object directly from Pkg class. Bc Pkg class should be unaware of how pkgMeta is stored and this adds
    // complexity to Pkg.
    if (!this._pkgMetaFile) {
      this._pkgMetaFile = fs.get<PkgMeta, never>(`${this.tmpFolder}/meta.json`, {
        jsonDefault: {
          bldArtifactAttrsCreateLast: undefined as unknown as PkgMeta["bldArtifactAttrsCreateLast"],
          stats: {
            buildTimes: [],
            buildSizes: [],
            bootstrapTimes: [],
            cacheMissReason: "",
          },
        },
      });
    }
    return O.ass(this._pkgMetaFile, {
      /** save the attrs so we can retrieve it in pkgJsonPostbuild */
      setBldArtifactAttrsCreateLast: async () => {
        // first, enable hooks just in case a prior build failed to restore them.
        // await this.jsonF.enableHooks().save();
        await this._pkgMetaFile
          .pjson({
            bldArtifactAttrsCreateLast: {
              val: await this.bldArtifactAttrsCreate(),
              ts: Time.iso(),
            },
          })
          .save()
          .catch(stepErrCb("setBldArtifactAttrsCreateLast"));
      },
      setCacheMissReason: (cacheMissReason: string) =>
        this._pkgMetaFile.pdjson({ stats: { cacheMissReason } }).save().catch(stepErrCb("setCacheMissReason")),
      setStats: async (bootTime: number, bldTime: number) =>
        this._pkgMetaFile
          .pdjson({
            stats: {
              bootstrapTimes: [bootTime],
              buildTimes: [bldTime],
              buildSizes: [await this.bldArtifactFile.sizeP()],
            },
          })
          .save()
          .catch(stepErrCb("setStats")),
    });
  }
  // private _pkgMetaFile!: ReturnTypeP<typeof fs.get<PkgMeta, never>> & {
  private _pkgMetaFile!: FileI<PkgMeta, never>;

  /**
   * a tmp folder for this pkg to store cli metadata
   */
  private get tmpFolder() {
    const path = `${this.pathAbs}/node_modules/.cache/bldr`;
    if (!this._tmpFolderCreated) {
      fs.mkdirS(path);
      this._tmpFolderCreated = true;
    }
    return path;
  }
  private _tmpFolderCreated = false;

  public yarnCacheClean = async () => {
    await Yarn.cachePurge({ pkgNames: [this.name] });
  };
}

class PkgWSync extends PkgWithBuild {
  /** syncs the build artifacts of workspace deps with a package's node_modules */
  syncCrosslinks = async (
    opts: {
      verbose?: boolean;
      watch?: boolean;
    } = {},
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
      "test",
      "yarn.lock",
    ];

    const pkgsToWatch = this.dcClsForInstall;

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
              { prefix: this.basename.toLocaleUpperCase() + ":", wd: this.pathWs, silent: !verbose },
            );
            await fs.rm(`${nestedNodeModules}/.cache`).catch(() => {});
            return res;
          }
          return "";
        }),
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
      return () => watcher.close().then(() => this.l1(`->done`));
    }
    log4(`->done`);
  };
}

/** The final class to be exported */
export class Pkg extends PkgWSync {}
