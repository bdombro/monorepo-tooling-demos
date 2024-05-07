import chokidar from "chokidar";
import osNode from "node:os";
import {
  cachify,
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
} from "./util.js";

const pkgLocalCache = new LocalCache({ path: `${fs.home}/.bldr/cache` });

export type PkgArtifactAttrs = {
  pkg: string;
  combined: string;
  [k: string]: string;
};

export class Bldr {
  static log = new Log({ prefix: "BLDR" });
  static l0 = Bldr.log.l0;
  static l1 = Bldr.log.l1;
  static l2 = Bldr.log.l2;
  static l3 = Bldr.log.l3;
  static l4 = Bldr.log.l4;
  static l5 = Bldr.log.l5;
  static l9 = Bldr.log.l9;

  static build = async (opts: { noCache: boolean; pkgs?: Pkg[] }) => {
    Bldr.l1(":build->start");
    const start = Date.now();
    const { noCache } = opts;
    const pkgs = opts.pkgs ?? (await Bldr.find());
    A.dedup(pkgs);
    pkgs.sort((a, b) => -1 * strCompare(a.name, b.name));
    await P.all(pkgs.map((pkg) => pkg.build({ noCache })));
    Bldr.l1(`:build->end ${Time.diff(start)}`);
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
        Bldr.l1(":clean->no opts provided, exiting");
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

      const pkgs = await Bldr.find({
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

      Bldr.l1(`:clean->start ${pkgs.length} packages`);

      const _p: Promise<anyOk>[] = [];

      for (const p of pkgs) {
        Bldr.l2(`:clean:${p.basename}->start`);
        _p.push(
          fs.rm(`${p.pathAbs}/.yarn-single-instance.lock`, {
            force: true,
            skipBackup: true,
          })
        );
        if (opts.builds) _p.push(p.cleanBld());
        if (opts.buildCache) _p.push(p.cleanBldCache());
        if (opts.yarnCache) _p.push(p.cleanYarnCache());
        if (opts.nodeModulesAll) _p.push(p.cleanNodeModules({ hard: true }));
        else if (opts.nodeModuleCrosslinks) _p.push(p.cleanNodeModules());
      }

      await P.all(_p);

      Bldr.l2(`:clean->done`);
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
        const pkgBasenamesAll = await Bldr.findPkgPaths();
        const pkgsAll = await P.all(pkgBasenamesAll.map((n) => Bldr.get(n)));
        await P.all(pkgsAll.map((p) => p.treeBldDependents()));
      }

      const pkgBasenames = await Bldr.findPkgPaths({ excludes, includes });
      const pkgs = await P.all(pkgBasenames.map((n) => Bldr.get(n)));
      return pkgs;
    }
  );

  static getConfig = cachify(async () => {
    const wsRoot = await fs.findNearestWsRoot();
    interface ConfRaw {
      postBuildSourceCheckIgnores: string[];
    }
    const confRaw: ConfRaw = await import(`${wsRoot}/.bldrrc.mjs`)
      .then((m) => m.default)
      .catch(() => ({}));

    const conf = {
      postBuildSourceCheckIgnores: [
        "__generated__",
        ...(confRaw.postBuildSourceCheckIgnores ?? []),
      ],
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

    if (Bldr.getCache.has(pathRel)) {
      Bldr.l4(`:get->cache-hit`);
      return Bldr.getCache.get(pathRel)!;
    }

    const pkgPwr = P.wr<Pkg>();
    Bldr.getCache.set(pathRel, pkgPwr.promise);

    Bldr.l4(`:get:path->match`);
    Bldr.l4(`:get:path->${pathAbs}`);

    try {
      const jsonF = await fs.getPkgJsonFile(pathAbs);
      const pkg = new Pkg(jsonF, pathAbs, pathRel, pathWs);
      await pkg.treeBldDependencies();
      Bldr.l3(`:get->done for ${basename}`);
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

    const pkgs = await Bldr.find({ dependents: true, includes, excludes });

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
    public jsonF: ReturnTypeP<typeof fs.getPkgJsonFile>,
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
  set json(json: ReturnTypeP<typeof fs.getPkgJsonFile>["json"]) {
    this.jsonF.json = json;
  }
  get name() {
    return this.jsonF.json.name;
  }
  get text() {
    return this.jsonF.text;
  }
  set text(text: ReturnTypeP<typeof fs.getPkgJsonFile>["text"]) {
    this.jsonF.text = text;
  }

  bldrConfigGet = cachify(async () => {
    const wsConf = await Bldr.getConfig();
    interface PkgConfRaw {
      postBuildSourceCheckIgnores: string[];
    }
    const pkgConfRaw: PkgConfRaw = await import(
      `${this.pathAbs}/.pkg.bldrrc.mjs`
    )
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

          const pkg = await Bldr.get(pkgName).catch((e) => {
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
      const pkgs = await Bldr.find();
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
  //==============================================================================//
  //
  // Public methods
  //
  //
  //==============================================================================//

  public bootstrap = async (opts: { noCache: boolean }) => {
    try {
      const { noCache } = opts;
      this.l3(`:bootstrap`);
      const start = Date.now();
      await this.pkgJsonPreinstall({ noCache });
      await this.pkgJsonInstall();
      await this.pkgJsonPostinstall();
      this.l3(`:bootstrap->end ${Time.diff(start)}`);
    } catch (e: anyOk) {
      throw stepErr(e, "bootstrap");
    }
  };

  public build = cachify(async (opts: { noCache: boolean }) => {
    try {
      this.l3(`:build->start`);
      const start = Date.now();
      const { noCache } = opts;

      await this.buildDependencies({ noCache });

      let canSkip = false;
      if (!noCache) {
        if (await this.bldArtifactIsUpToDate()) {
          this.l1(`:build->skip-bc-existing-is-up-to-date`);
          canSkip = true;
        } else {
          try {
            // why isn't build skipping on success?
            await this.bldArtifactCacheGet();
            this.l1(`:build->skip-bc-cache-hit`);
            canSkip = true;
          } catch (e) {}
        }
      }

      if (canSkip) return;

      await this.bootstrap({ noCache });
      await this.pkgJsonPrebuild();
      await this.pkgJsonBuild();
      await this.pkgJsonPostbuild();

      this.l3(`:build->end ${Time.diff(start)}`);
    } catch (e: anyOk) {
      throw stepErr(e, "build");
    }
  });

  public cleanBld = async () => {
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

  public cleanBldCache = async (opts: SMM = {}) => {
    try {
      await pkgLocalCache.purge({
        includes: [strFileEscape(this.name.slice(1))],
      });
    } catch (e) {
      throw stepErr(e, "cachePurge");
    }
  };

  public cleanCaches = async () => {
    try {
      await P.all([this.cleanBldCache(), this.cleanYarnCache()]);
    } catch (e) {
      throw stepErr(e, "pkg.cleanCaches");
    }
  };

  public cleanNodeModules = async (opts: { hard?: boolean } = {}) => {
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

  public cleanYarnCache = async () => {
    await Yarn.cachePurge({ pkgNames: [this.name] });
  };

  public pkgJsonPostbuildHook = async () => {
    await this.pkgJsonPostbuild();
  };

  public pkgJsonPrebuildHook = async (opts: { noCache: boolean }) => {
    await this.pkgJsonPrebuild();
  };

  public pkgJsonPostinstallHook = async () => {
    await this.pkgJsonPostinstall();
  };

  public pkgJsonPreinstallHook = async (opts: { noCache: boolean }) => {
    await this.pkgJsonPreinstall(opts);
  };

  //==============================================================================//
  //
  // Private methods
  //
  //
  //==============================================================================//

  private buildDependencies = cachify(async (opts: { noCache: boolean }) => {
    try {
      // TODO: fix no-cache not working on bldDeps
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
  private bldArtifactIsUpToDate = cachify(async (): Promise<boolean> => {
    try {
      this.l4(`->bldArtifactIsUpToDate`);
      let existing: Dict;
      try {
        existing = await this.bldArtifactAttrsGet();
      } catch (e) {
        this.l4(`bldArtifactIsUpToDate->no`);
        return false;
      }
      const expected = await this.bldArtifactAttrsCreate();
      if (existing["combined"] === expected.combined) {
        this.l2(`:bldArtifactIsUpToDate->yes`);
        return true;
      }

      // if we get here, the bld artifact is not up to date
      // so we log the differences
      const cmp = O.compare(
        O.omit(existing, ["combined"]),
        O.omit(expected, ["combined"])
      );
      if (!cmp.equals) {
        this.l2(`:bldArtifactIsUpToDate->no`);
        cmp.added.forEach((pathRel) =>
          this.l1(`:bldArtifactIsUpToDate:added-> ${pathRel}`)
        );
        O.ents(cmp.changed).forEach(([pathRel]) =>
          this.l1(`:bldArtifactIsUpToDate:changed-> ${pathRel}`)
        );
        cmp.removed.forEach((pathRel) =>
          this.l1(`:bldArtifactIsUpToDate:removed-> ${pathRel}`)
        );
      } else {
        this.l4(`:bldArtifactIsUpToDate->yes`);
        return true;
      }
    } catch (e) {} // exception means no qualified build artifact
    return false;
  });

  private bldArtifactAttrsCreate = cachify(
    async (): Promise<PkgArtifactAttrs> => {
      this.l4(`->bldArtifactAttrsCreate`);

      //
      // Two strategies for srcCsums:
      //
      // 1. If there is a src dir, we md5 the src dir, package.json and yarn.lock
      // 2. Else, we md5 the entire package dir with exclusions
      //

      let srcCsums: ReturnTypeP<typeof fs.md5>;

      const srcDirIsPresent = await fs
        .stat(`${this.pathAbs}/src`)
        .catch(() => {});

      // 1. If there is a src dir, we md5 the src dir, package.json and yarn.lock
      if (srcDirIsPresent) {
        const includePaths = ["src", "package.json", "yarn.lock"].map(
          (p) => `${this.pathAbs}/${p}`
        ) as [string];
        srcCsums = await fs.md5(includePaths);
      }
      // 2. Else, we md5 the entire package dir with exclusions
      else {
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
        const pkgExportPaths = this.json.exports
          ? O.valsRecursive(this.json.exports)
          : [];
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

        srcCsums = await fs.md5(this.pathAbs, {
          excludes: excludesRegExps,
        });
      }

      // make the paths relative to the package root
      srcCsums = O.ents(srcCsums).reduce((acc, [k, v]) => {
        acc[k.replace(this.pathAbs + "/", "")] = v;
        return acc;
      }, {} as typeof srcCsums);

      const depCsums: Dict = O.fromEnts<string>(
        await P.all(
          O.vals(this.dependencyCls).map(
            async (cl): Promise<[string, string]> => {
              const clAttrs = await cl.bldArtifactAttrsGet();
              return [cl.pathRel, clAttrs.combined];
            }
          )
        )
      );

      const srcAndDepCsums = O.sort({ ...srcCsums, ...depCsums });

      const attrs: PkgArtifactAttrs = {
        pkg: this.pathRel,
        combined: md5(O.vals(srcAndDepCsums)),
        ...srcAndDepCsums,
      };
      this.bldArtifactAttrsCreateLast = attrs;

      // save the attrs to a tmp file so we can retrieve it in pkgJsonPostbuild
      const tmpFolder = await this.tmpFolderGet();
      await fs.set(
        `${tmpFolder}/bldArtifactAttrsCreateLast.json`,
        JSON.stringify(attrs),
        { skipBackup: true }
      );

      return attrs;
    }
  );
  private bldArtifactAttrsCreateLast: PkgArtifactAttrs | null = null;

  private bldArtifactAttrsGet = async (): Promise<PkgArtifactAttrs> => {
    try {
      const attrs = await fs.getXattrs(this.bldArtifactPath);
      return attrs as anyOk;
    } catch (e) {
      throw stepErr(e, "bldArtifactAttrsGet");
    }
  };

  private bldArtifactAttrsSet = async () => {
    const bldAttrsExpected = await this.bldArtifactAttrsCreate();
    await fs.setXattrs(this.bldArtifactPath, bldAttrsExpected);
  };

  /**
   * adds this pkg's build artifact (package.tgz) to the caches (just local atm)
   *
   * even though we could get the attrs from the file, we pass them in to avoid
   * the extra fs call.
   */
  private bldArtifactCacheAdd = async () => {
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
  private bldArtifactCacheGet = async () => {
    try {
      const bldAttrsExpected = await this.bldArtifactAttrsCreate();
      const cacheKey = this.bldArtifactCacheKey(bldAttrsExpected);
      this.l2(`:cacheGet->${cacheKey}`);
      const cached = await pkgLocalCache.get(cacheKey);
      await fs.setBin(this.bldArtifactPath, cached.buffer, {
        xattrs: cached.attrs,
      });

      this.l3(`:cacheGet->hit`);

      // we can pump the cache for this.bldArtifactIsUpToDate since hit
      await this.bldArtifactIsUpToDate({ setCache: true });

      // end cacheGet main
    } catch (e) {
      throw stepErr(e, "cacheGet");
    }
  };

  /** Note if you change this, you also need to change bldArtifactCachePurge filter */
  private bldArtifactCacheKey = (attrs: PkgArtifactAttrs) => {
    const cacheKey = strFileEscape(
      `${this.name.slice(1)}-${attrs.combined}.tgz`
    );
    return cacheKey;
  };

  /**
   * The npm/yarn/pnpm lockfiles should never include crosslinks so that yarn always fresh installs them
   * - this mainly needs to be done in the preinstall and postinstall steps bc that's when yarn.lock is used.
   */
  private lockfileClean = async () => {
    // FIXME: using fs would be faster than sh.exec
    await sh.exec(
      '[ -f yarn.lock ] && sed -i "" -n "/@..\\//,/^$/!p" yarn.lock',
      { wd: this.pathAbs }
    );
  };

  private pkgJsonPostinstall = async () => {
    this.l4(`->reset`);
    try {
      const tmpFolder = await this.tmpFolderGet();
      await P.all([
        this.lockfileClean(),
        fs
          .getPkgJsonFile(`${tmpFolder}/pkgJsonPreinstall.package.json`)
          .then((pj) => {
            if (pj.json.dependencies)
              this.json.dependencies = pj.json.dependencies;
            if (pj.json.devDependencies)
              this.json.devDependencies = pj.json.devDependencies;
            return this.jsonF.save();
          }),
        // this.pkgJsonGenerate(), // TODO: decide whether to re-enable
      ]);
      // bust the cache on attrs bc yarn install may have changed yarn.lock
      await this.bldArtifactAttrsCreate({ bustCache: true });
    } catch (e: anyOk) {
      throw stepErr(e, "pkgJsonPostinstall", { pkg: this.basename });
    }
    this.l3(`:reset->end`);
  };

  /**
   * Preps the package for install by:
   * 1. removing cls from yarn.lock
   * 2. upserting cls as ../[pkg]/package.tgz to package.json
   */
  private pkgJsonPreinstall = async (opts: { noCache: boolean }) => {
    try {
      this.l4(`->pkgJsonPreinstall`);
      const { noCache = false } = opts;

      await this.buildDependencies({ noCache });

      const _p: Promise<anyOk>[] = [];

      // create backup of package.json to be restored in pkgJsonPostinstall
      const tmpFolder = await this.tmpFolderGet();
      _p.push(
        fs.cp(
          `${this.pathAbs}/package.json`,
          `${tmpFolder}/pkgJsonPreinstall.package.json`,
          { skipBackup: true }
        )
      );

      // 1. remove cls from yarn.lock so yarn fresh installs
      _p.push(this.lockfileClean());

      // 2. upsert cls (incl nested) as ../[pkg]/package.tgz to package.json
      const pjs = this.json;

      // assert that the package.json isn't currupt
      for (const [k, v] of O.ents({
        ...pjs.dependencies,
        ...pjs.devDependencies,
      })) {
        if (v.startsWith("../"))
          throw stepErr(
            Error(
              `package.json has relative dep and is likely currupt: ${k} -> ${v}`
            ),
            "preinstall"
          );
      }

      // swap out the workspace:* (aka cls) with relative paths and add nested
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
      _p.push(this.jsonF.save());

      await P.all(_p);

      this.l4(`:pkgJsonPreinstall->end`);
    } catch (e: anyOk) {
      throw stepErr(e, "preinstall", { pkg: this.basename });
    }
  };

  private pkgJsonInstall = async () => {
    try {
      this.l1(`->pkgJsonInstall`);
      const start = new Date();
      await this.jsonF.disableHooks();

      const i = setInterval(() => {
        this.l1(`:pkgJsonInstall->working ${Time.diff(start)}`);
      }, 20000);
      await sh.exec(
        `yarn install --mutex file:${Yarn.mutex}` +
          (UTIL_ENV.logLevel >= 5 ? " --verbose" : ""),
        {
          prefix: this.log.prefix,
          verbose: UTIL_ENV.logLevel > 1,
          wd: this.pathAbs,
        }
      );
      clearInterval(i);

      await this.jsonF.enableHooks();
      this.l1(`:pkgJsonInstall->end ${Time.diff(start)}`);
    } catch (e: anyOk) {
      throw stepErr(e, "pkgJsonInstall", { pkg: this.basename });
    }
  };

  /** Runs `yarn generate` if the task exists in package.json */
  private pkgJsonGenerate = async () => {
    if (!this.json.scripts?.["generate"]) return;
    this.l1(`->pkgJsonGenerate`);
    const start = new Date();
    await sh
      .exec(`yarn generate`, {
        prefix: this.log.prefix,
        verbose: UTIL_ENV.logLevel > 1,
        wd: this.pathAbs,
      })
      .catch(stepErrCb("pkgJsonGenerate"));
    this.l3(`:pkgJsonGenerate->end ${Time.diff(start)}`);
  };

  /** Basically just cleans previous builds */
  private pkgJsonPrebuild = async () => {
    try {
      this.l4(`->pkgJsonPrebuild`);

      // mv src folder to prevent yarn clean from deleting generated src files
      // by backing up and restoring the src dir after running yarn clean
      // TODO: Do we need this?
      let srcMoved = false;
      const srcDir = `${this.pathAbs}/src`;
      const srcDirBak = `${srcDir}.bak`;
      try {
        await fs.mv(srcDir, srcDirBak, { skipBackup: true });
        await fs.mkdir(srcDir);
        srcMoved = true;
      } catch (e) {}

      await P.all([
        this.bldArtifactAttrsCreate(), // call this to capture before build attrs
        fs.rm(`${this.pathAbs}/package.tgz`).catch(() => {}),
        fs.rm(`${this.pathAbs}/dist`).catch(() => {}),
        fs.rm(`${this.pathAbs}/build`).catch(() => {}),
        sh.exec(`yarn clean`, { wd: this.pathAbs }),
      ]);

      if (srcMoved) {
        await fs.rm(srcDir, { skipBackup: true });
        await fs.mv(srcDirBak, srcDir, { skipBackup: true });
      }

      this.l4(`:pkgJsonPrebuild->end`);
    } catch (e) {
      throw stepErr(e, "pkgJsonPrebuild", { pkg: this.basename });
    }
  };

  private pkgJsonBuild = throttle(async () => {
    try {
      let start = new Date();
      this.l1(`->pkgJsonBuild`);
      await this.jsonF.disableHooks();

      const i = setInterval(() => {
        this.l1(`:pkgJsonBuild->working ${Time.diff(start)}`);
      }, 20000);
      await sh
        .exec(`LOG=${UTIL_ENV.logLevel} yarn build`, {
          prefix: this.log.prefix,
          verbose: UTIL_ENV.logLevel > 1,
          wd: this.pathAbs,
        })
        .catch(stepErrCb("pkgJsonBuild"));
      clearInterval(i);

      await this.jsonF.enableHooks();
      this.l1(`:pkgJsonBuild->end ${Time.diff(start)}`);
    } catch (e: anyOk) {
      throw stepErr(e, "pkgJsonBuild", { pkg: this.basename });
    }
  });

  private pkgJsonPostbuild = async () => {
    try {
      this.l4(`->pkgJsonPostBuild`);
      const start = new Date();

      //
      // 1. assert src csum has not changed from before build
      //
      //
      const attrsBefore = O.omit(
        this.bldArtifactAttrsCreateLast ||
          ((await fs
            .getJsonFile(
              `${await this.tmpFolderGet}/bldArtifactAttrsCreateLast.json`
            )
            .catch((e) => {
              throw stepErr(e, "csumChangedCheck.getBefore");
            })) as unknown as PkgArtifactAttrs),
        ["combined", "pkg"]
      );
      const attrsAfter = O.omit(
        await this.bldArtifactAttrsCreate({
          bustCache: true,
        }),
        ["combined", "pkg"]
      );

      const ignores = (await this.bldrConfigGet()).postBuildSourceCheckIgnores;
      for (const i of ignores) {
        O.ents(attrsBefore)
          .filter(([k, v]) => (Is.regex(i) ? k.match(i) : k.includes(i)))
          .forEach(([k, v]) => delete attrsBefore[k]);
        O.ents(attrsAfter)
          .filter(([k, v]) => (Is.regex(i) ? k.match(i) : k.includes(i)))
          .forEach(([k, v]) => delete attrsAfter[k]);
      }

      const cmp = O.compare(attrsBefore, attrsAfter);
      if (!cmp.equals) {
        throw stepErr(
          Error(
            "attrs changed after build. This means that bldr is csuming build artifacts (bad!)"
          ),
          "csumChangedCheck",
          { cmp }
        );
      }

      //
      // 2. now pack it up
      //
      //

      this.l1(`:pkgJsonPostBuild->pack`);

      /** Remove all crosslinks from package.json */
      const pjs = this.json;
      const rm = (deps: Record<string, string> = {}) =>
        Object.entries(deps)
          .filter(([, v]) => v.startsWith("../") || v === "workspace:*")
          .forEach(([d]) => delete deps[d]);
      rm(pjs.dependencies);
      rm(pjs.devDependencies);
      rm(pjs.peerDependencies);
      // Disable hooks too, bc yarn will stupidly run them despite being a dependency.
      delete pjs.scripts;
      await this.jsonF.save();

      await sh
        .exec(`yarn pack -f package.tgz`, { wd: this.pathAbs })
        .catch(stepErrCb("pkgJsonPack"));

      await P.all([this.cleanYarnCache(), this.jsonF.reset()]);
      await this.bldArtifactAttrsSet();
      await this.bldArtifactCacheAdd();

      this.l4(`:pkgJsonPostBuild->end`);

      // end pkgJsonPostbuild
    } catch (e: anyOk) {
      throw stepErr(e, "pkgJsonPostbuild", { pkg: this.basename });
    }
  };

  /**
   * a tmp folder for this pkg to store cli metadata
   */
  private tmpFolderGet = async () => {
    const path = `${this.pathAbs}/node_modules/.cache/bldr`;
    await fs.mkdir(path);
    return path;
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