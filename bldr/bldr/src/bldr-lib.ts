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
  // FIXME: extend Log instead of doing the manual extend like Pkg bc not dynamic.
  static logFile = Log.file.replace(fs.home, "~");
  // FIXME: logging to file should be optional
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
    Bldr.l1(`<-build ${Time.diff(start)}`);
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
        throw stepErr(":clean->no opts provided, exiting", "clean");
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
        if (opts.nodeModulesAll) _p.push(p.bootstrapClean({ hard: true }));
        else if (opts.nodeModuleCrosslinks) _p.push(p.bootstrapClean());
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

  static getConfig = cachify(async () => {
    const wsRoot = await fs.findNearestWsRoot();
    interface ConfRaw {
      postBuildSourceCheckIgnores: string[];
    }
    const confRaw: ConfRaw = await import(`${wsRoot}/.bldrrc.mjs`).then((m) => m.default).catch(() => ({}));

    const conf = {
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
          prefix: pkg.logShellPrefix,
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
      txt += Tree.viz(pkg, { childrenKey: "dependencies", nameKey: "treeName" }) + "\n\n";
      txt += `--dependents--\n\n`;
      txt += Tree.viz(pkg, { childrenKey: "dependents", nameKey: "treeName" }) + "\n\n\n";
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
  public logShellPrefix: string;

  constructor(...args: ConstructorParameters<typeof PkgBase>) {
    super(...args);
    const basename = fs.basename(this.pathAbs).toUpperCase();
    this.log = new Log({ prefix: basename });
    O.ass(this, this.log);
    this.logShellPrefix = basename + ":SH:";
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

  bldrConfigGet = cachify(async () => {
    const wsConf = await Bldr.getConfig();
    interface PkgConfRaw {
      postBuildSourceCheckIgnores: string[];
    }
    const pkgConfRaw: PkgConfRaw = await import(`${this.pathAbs}/.pkg.bldrrc.mjs`)
      .then((m) => m.default)
      .catch(() => ({}));

    const pkgConf: PkgConfRaw = {
      postBuildSourceCheckIgnores: [
        ...wsConf.postBuildSourceCheckIgnores,
        ...(pkgConfRaw.postBuildSourceCheckIgnores ?? []),
      ],
    };
    return pkgConf;
  });
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
  private bldDependencies = async (opts: { noCache: boolean }) => {
    if (this._bldDependenciesDone) return;
    try {
      // FIXME: fix no-cache not working on bldDeps
      // this.l1(`->building w/ deps: ${this.dependencyClsForInstall.map((cl) => cl.basename).join(", ") || "none"}`);
      const { noCache } = opts;
      await P.all(
        this.dcClsForInstall.map(async (cl) => {
          await cl.bldMain({ noCache });
        }),
      );
      this._bldDependenciesDone = true;
      return;
    } catch (e) {
      throw stepErr(e, "bldDependencies", { parent: this.basename });
    }
  };
  private _bldDependenciesDone = false;

  public bldArtifactAttrsGet = async (opts: { bustCache?: boolean } = {}): Promise<PkgArtifactAttrs> => {
    const { bustCache } = opts;
    if (this._bldArtifactAttrsGetVal && !bustCache) return this._bldArtifactAttrsGetVal;
    try {
      this.l3(`->bldArtifactAttrsGet`);

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

      return (this._bldArtifactAttrsGetVal = attrs);
    } catch (e) {
      throw stepErr(e, "bldArtifactAttrsGet");
    }
  };
  private _bldArtifactAttrsGetVal?: PkgArtifactAttrs;

  private bldArtifactAttrsGetSrcCsums = async (): Promise<Dict> => {
    try {
      this.l4(`->bldArtifactAttrsGetSrcCsums`);

      const srcDirIsPresent = await fs.stat(`${this.pathAbs}/src`).catch(() => {});

      const files: string[] = [];
      let excludes: RegExp[] = [];
      let includePaths: string[] = [];

      const relToAbs = (p: string) => `${this.pathAbs}/${p}`;

      // 1. If there is a src dir, we md5 the src dir, package.json and yarn.lock
      if (srcDirIsPresent) {
        this.l4(`:srcDirIsPresent`);
        files.push(...["package.json", "yarn.lock"].map(relToAbs));
        includePaths = ["src"].map(relToAbs) as [string];
      }
      // 2. Else, we md5 the entire package dir with exclusions
      else {
        this.l4(`:srcDirIsNotPresent`);
        includePaths = [this.pathAbs];
        try {
          excludes = [
            /^\.[a-zA-Z]/, // paths starting with a dot ie (.b)ar
            /\/\./, // paths with a dot path in the middle ie /foo(/.)bar
          ];

          const excludeStrsIfAnywhereInPath = [
            "coverage",
            "dist",
            "build",
            "jest",
            "/lint", // prefix with a slash to avoid matching eslint package crosslink false pos
            "node_modules",
            "public",
            "test",
            "stories",
            "story",
            "styleguide",
          ];

          const excludeStrsIfEndsWith: string[] = [
            "CONTRIBUTING.md",
            "cortex.yaml",
            "LICENSE.md",
            "package.tgz",
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
          const pkgExportPaths = this.json.exports ? O.valsRecursive(this.json.exports) : [];
          const pkgExportDirs = pkgExportPaths.map((p) => {
            let dir = p;
            dir = dir.replace(/^\.?\//, ""); // kill ^./ || ^/
            dir = dir.split("/")[0]; // kill everything after the first dir
            dir = this.pathRel + "/" + dir;
            return dir;
          });
          excludeStrsIfAnywhereInPath.push(...pkgExportDirs);

          excludes.push(RegExp("(" + A.toDedup(excludeStrsIfEndsWith).join("|") + ")$"));
          excludes.push(RegExp("(" + A.toDedup(excludeStrsIfAnywhereInPath).join("|") + ")"));
        } catch (e) {
          throw stepErr(e, "srcDirIsNotPresent");
        }
      }

      await P.all(
        includePaths.map(async (p) => {
          const pFiles = await fs.find(p, { excludes, recursive: true });
          files.push(...pFiles);
        }),
      );

      if (!files.length) throw Error("No src files found to pkg");

      const srcCsums = await fs.md5(files as [string]);

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

  private bldArtifactAttrsUpdate = async () => {
    this.bldArtifactFile.cacheClear();
    // 1. assert the build is made
    await this.bldArtifactFile.existsP().then((e) => {
      if (!e) throw stepErr(Error("build artifact is missing"), "artifact-exists", { artPath: this.bldArtifactPath });
    });
    // 2. assert the build is non-empty
    await this.bldArtifactFile.sizeP().then((s) => {
      if (s === 0)
        throw stepErr(Error("build artifact is empty"), "artifact-nonempty", { artPath: this.bldArtifactPath });
    });
    // 3. create the attrs and set them
    const bldAttrsExpected = await this.bldArtifactAttrsGet();
    await this.bldArtifactFile.set({ gattrs: bldAttrsExpected });
  };

  /**
   * adds this pkg's build artifact (package.tgz) to the caches (just local atm)
   *
   * even though we could get the attrs from the file, we pass them in to avoid
   * the extra fs call.
   */
  private bldArtifactCacheAdd = async () => {
    try {
      this.l4(`->bldArtifactCacheAdd`);
      const attrs = await this.bldArtifactFile.gattrsP();
      const cacheKey = this.bldArtifactCacheKey(attrs);
      this.l2(`:cacheAdd->${cacheKey}`);

      // stat before get to check if copy/download be skipped, bc we can skip if
      // the cache already has the package.tgz
      let stat = await Pkg.bldLocalCache.stat(cacheKey).catch(() => {});
      if (stat) {
        this.l1(`:cacheAdd->skip bc cache already has it`);
      } else {
        stat = await Pkg.bldLocalCache.add(cacheKey, await this.bldArtifactFile.bufferP(), { attrs });
      }

      this.l4(`<-bldArtifactCacheAdd`);
      return stat;
    } catch (e) {
      throw stepErr(e, "bldArtifactCacheAdd");
    }
  };

  /**
   * Gets this's build artifact from the cache if exists. return null if not.
   *
   * Returns the result.
   */
  private bldArtifactCacheGet = async () => {
    try {
      const bldAttrsExpected = await this.bldArtifactAttrsGet();
      const cacheKey = this.bldArtifactCacheKey(bldAttrsExpected);
      this.l2(`:cacheGet->${cacheKey}`);
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
  get bldArtifactFile() {
    return (this._bldArtifactFile =
      this._bldArtifactFile ??
      fs.get<never, PkgArtifactAttrs>(this.bldArtifactPath, {
        gattrsDefault: {
          pkg: this.name,
          combined: "",
          deps: {},
          files: {},
        },
      }));
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
    const expected = await this.bldArtifactAttrsGet();
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

  public bldMain = async (opts: { noCache: boolean }) => {
    if (this._bldMainLast) return this._bldMainLast;
    const pwv = P.wr<void>();
    this._bldMainLast = pwv.promise;

    try {
      this.l1(`->building w/ ${this.dcClsForInstall.map((cl) => cl.basename).join(", ") || "no-deps"}`);
      const start = Date.now();
      const { noCache } = opts;

      await this.bldDependencies({ noCache });

      let cached = false;
      if (!noCache) {
        if (await this.bldArtifactIsUpToDate()) {
          this.l2(`->building cache-hit-ws`);
          cached = true;
        } else {
          try {
            await this.bldArtifactCacheGet();
            this.l2(`->building cache-hit-lc`);
            cached = true;
          } catch (e) {}
        }
      }

      let bootTime = 0;
      let bldStart = Date.now();
      if (!cached) {
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

      this.l3(`<-building ${Time.diff(start)}`);
      pwv.resolve();
    } catch (e: anyOk) {
      const e2 = stepErr(e, "build");
      pwv.reject(e2);
      throw e2;
    }
  };
  private _bldMainLast?: Promise<void>;

  public bootstrapClean = async (opts: { hard?: boolean } = {}) => {
    try {
      const { hard } = opts;
      if (hard) {
        await fs.rm(`${this.pathAbs}/node_modules`).catch(() => {});
      } else {
        await P.all(
          this.dcClsForInstall.map((cl) => {
            return fs.rm(`${this.pathAbs}/node_modules/${cl.json.name}`, { force: true, recursive: true });
          }),
        );
      }
    } catch (e) {
      throw stepErr(e, "bootstrapClean");
    }
  };

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
    await sh.exec('[ -f yarn.lock ] && sed -i "" -n "/@..\\//,/^$/!p" yarn.lock', {
      prefix: this.logShellPrefix,
      wd: this.pathAbs,
    });
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

      _p.push(this.bldDependencies({ noCache }));
      // create backup of package.json to be restored in pkgJsonPostinstall
      _p.push(this.jsonF.snapshot("pkgJsonPreinstall"));

      // 1. remove cls from yarn.lock so yarn fresh installs
      _p.push(this.lockfileClean());

      // 2. upsert cls (incl nested) as ../[pkg]/package.tgz to package.json

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
      const lastDuration = Time.diff(0, await this.pkgMetaFile.jsonP().then((m) => m.stats.bootstrapTimes[0] ?? 0));

      this.l1(`->install ${lastDuration ? `(took ${lastDuration} last time)` : ""}`);

      await this.jsonF.disableHooks().save();

      const i = setInterval(() => {
        this.l2(`:install->working...${Time.diff(start)}`);
      }, 30000);
      await sh.exec(`yarn install --mutex file:${Yarn.mutex}` + (UTIL_ENV.logLevel >= 5 ? " --verbose" : ""), {
        prefix: this.logShellPrefix,
        verbose: UTIL_ENV.logLevel > 1,
        wd: this.pathAbs,
      });
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
        // this.pkgJsonGenerate(), // TODO: decide whether to re-enable
      ]);
    } catch (e: anyOk) {
      throw stepErr(e, "pkgJsonPostinstall", { pkg: this.basename });
    }
    this.l3(`<-reset`);
  };

  /** Runs `yarn generate` if the task exists in package.json */
  private pkgJsonGenerate = async () => {
    if (!this.json.scripts?.["generate"]) return;
    this.l1(`->pkgJsonGenerate`);
    const start = new Date();
    await sh
      .exec(`yarn generate`, {
        prefix: this.logShellPrefix,
        verbose: UTIL_ENV.logLevel > 1,
        wd: this.pathAbs,
      })
      .catch(stepErrCb("pkgJsonGenerate"));
    this.l3(`<-pkgJsonGenerate ${Time.diff(start)}`);
  };

  /** Basically just cleans previous builds */
  public pkgJsonPrebuild = async () => {
    try {
      this.l4(`->pkgJsonPrebuild`);

      // mv src folder to prevent yarn clean from deleting generated src files
      // by backing up and restoring the src dir after running yarn clean
      // FIXME: Do we need this?
      let srcMoved = false;
      const srcDir = `${this.pathAbs}/src`;
      const srcDirBak = `${srcDir}.bak`;
      try {
        await fs.mv(srcDir, srcDirBak);
        await fs.mkdir(srcDir);
        srcMoved = true;
      } catch (e) {}

      await P.all([this.bldClean(), sh.exec(`yarn clean`, { prefix: this.logShellPrefix, wd: this.pathAbs })]);

      if (srcMoved) {
        await fs.rm(srcDir);
        await fs.mv(srcDirBak, srcDir);
      }

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
      const lastDuration = Time.diff(0, await this.pkgMetaFile.jsonP().then((m) => m.stats.buildTimes[0] ?? 0));

      this.l1(`->build ${lastDuration ? `(took ${lastDuration} last time)` : ""}`);

      await this.jsonF.disableHooks().save();

      const i = setInterval(() => {
        this.l2(`:build->working...${Time.diff(start)}`);
      }, 30000);
      await sh
        .exec(`LOG=${UTIL_ENV.logLevel} yarn build`, {
          prefix: this.logShellPrefix,
          verbose: UTIL_ENV.logLevel > 1,
          wd: this.pathAbs,
        })
        .catch(stepErrCb("pkgJsonBuild"));
      clearInterval(i);

      await this.jsonF.enableHooks().save();
      this.l2(`<-build ${Time.diff(start)}`);
    } catch (e: anyOk) {
      throw stepErr(e, "pkgJsonBuild", { pkg: this.basename });
    }
  });

  public pkgJsonPostbuild = async () => {
    try {
      this.l4(`->pkgJsonPostBuild`);
      const start = new Date();

      //
      // 1. assert src csum has not changed from before build
      //
      //

      const attrsBefore = (await this.pkgMetaFile.jsonP()).bldArtifactAttrsCreateLast.val;
      const attrsAfter = await this.bldArtifactAttrsGet({ bustCache: true });
      const cmpAttrsBefore = O.fromEnts([...O.ents(attrsBefore.deps), ...O.ents(attrsBefore.files)]);
      const cmpAttrsAfter = O.fromEnts([...O.ents(attrsAfter.deps), ...O.ents(attrsAfter.files)]);
      const ignores = (await this.bldrConfigGet()).postBuildSourceCheckIgnores;
      for (const i of ignores) {
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

      //
      // 2. now pack it up
      //
      //

      this.l2(`:pkgJsonPostBuild->pack`);

      // Save snapshot to restore post-pack
      const jsonPrePack = O.cp(this.json);

      // Remove script hooks and crosslinks from package.json
      const jsonPack = O.cp(this.json);
      const rmCls = (deps: Record<string, string> = {}) =>
        Object.entries(deps)
          .filter(([, v]) => v.startsWith("../") || v === "workspace:*")
          .forEach(([d]) => delete deps[d]);
      rmCls(jsonPack.dependencies);
      rmCls(jsonPack.devDependencies);
      rmCls(jsonPack.peerDependencies);
      this.jsonF.json = jsonPack;

      // Disable hooks, to avoid hooks being fired on install, yarn stupidly tries to do even if the
      // hook is in a dependency package.json.
      this.jsonF.disableHooks();

      await this.jsonF.save();

      await sh
        .exec(`yarn pack -f package.tgz`, { prefix: this.logShellPrefix, wd: this.pathAbs })
        .catch(stepErrCb("pkgJsonPack"));

      await P.all([this.yarnCacheClean(), this.jsonF.set({ json: jsonPrePack })]);

      await this.bldArtifactAttrsUpdate();
      await this.bldArtifactCacheAdd();

      this.l4(`<-pkgJsonPostBuild ${Time.diff(start)}`);

      // end pkgJsonPostbuild
    } catch (e: anyOk) {
      throw stepErr(e, "pkgJsonPostbuild", { pkg: this.basename });
    }
  };

  public get pkgMetaFile() {
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
              val: await this.bldArtifactAttrsGet(),
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
              { prefix: this.logShellPrefix, wd: this.pathWs, silent: !verbose },
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
