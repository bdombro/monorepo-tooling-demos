#!/usr/bin/env bun

import childProcessNode from "node:child_process";
import cryptoNode from "node:crypto";
import { promises as fsNode } from "node:fs";
import osNode from "node:os";
import pathNode from "node:path";
import urlNode from "node:url";
import utilNode from "node:util";

export const UTIL_ENV = {
  ci: process.env["CI"] === "1" ? true : false,
  logLevel: Number(process.env["LOG"] ?? 1),
  installDeps: cachify(async () => {
    log4("installEnvDeps->start");
    await P.all([
      sh.assertCmdExists("yarn"),
      sh.assertCmdExists("git"),
      fs
        .stat(`${fs.home}/.bun`)
        .catch(() => sh.exec(`curl -fsSL https://bun.sh/install | bash`)),
    ]);
  }),
};

/** Aliases and misc */

/** Alias for any that passes eslint. Use this sparingly! */
export type anyOk =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any;

/** Makes a function cached (forever atm) */
export function cachify<T extends Fnc>(fn: T) {
  const cache: Map<anyOk, anyOk> = new Map();
  return (...args: Parameters<T>): ReturnType<T> => {
    const key = JSON.stringify(args?.length ? args : "none");
    if (cache.has(key)) return cache.get(key);
    const res = fn(...args);
    cache.set(key, res);
    return res;
  };
}

/** any function */
export type Fnc = (...args: anyOk) => anyOk;

/** alias for Record<string, string> */
export type Dict = Record<string, string>;

/** alias for Record<string, any> */
export type HashM<T> = Record<string, T>;

/** methods to check if a var is a type */
export const Is = {
  /** alias for Array.isArray */
  arr: Array.isArray,
  /** checks if a var is a bigint */
  bigint: (a: unknown): a is bigint => typeof a === "bigint",
  /** checks if a var is a boolean */
  bool: (a: unknown): a is boolean => typeof a === "boolean",
  /** Checks if a var is a buffer */
  buffer: Buffer.isBuffer,
  /** checks if a var is a date */
  date: (a: unknown): a is Date => a instanceof Date,
  /** checks if object, ie basically unknown */
  obj: (a: unknown): a is unknown => typeof a === "object" && !Is.arr(a),
  /** checks if a var is a number */
  num: (a: unknown): a is number => typeof a === "number",
  /** checks if a var is a string */
  str: (a: unknown): a is string => typeof a === "string",
  /** checks if a var is a symbol */
  sym: (a: unknown): a is symbol => typeof a === "symbol",
  /** checks if a var is undefined */
  undef: (a: unknown): a is undefined => typeof a === "undefined",
};

/** makes a Dict from an array of objects, keyed by `key` */
export const keyBy = <T>(arr: T[], key: string) =>
  arr.reduce((acc, item: anyOk) => {
    acc[item[key]] = item;
    return acc;
  }, {} as HashM<T>);
export const keyByC = cachify(keyBy);

export const md5 = (srcOrSrcs: anyOk) => {
  const hash = cryptoNode.createHash("md5");
  let srcs = srcOrSrcs as (string | Buffer)[];
  if (!Is.arr(srcOrSrcs)) srcs = [srcOrSrcs];
  srcs.forEach((b) => {
    if (Is.obj(b)) b = str(b);
    if (!Is.buffer(b)) b = `${b}`;
    hash.update(b);
  });
  return hash.digest("base64url");
};

/** aliases for Object */
export const O = {
  /** An alias for Object.assign */
  ass: ((...args: [anyOk]) =>
    Object.assign(...args)) as ObjectConstructor["assign"],
  /** An alias for Object.entries */
  ents: ((...args: [anyOk]) =>
    Object.entries(...args)) as ObjectConstructor["entries"],
  /** An alias for Object.fromEntries */
  fromEnts: ((...args: [anyOk]) =>
    Object.fromEntries(...args)) as ObjectConstructor["fromEntries"],
  /** An alias for Object.keys */
  keys: ((...args: [anyOk]) =>
    Object.keys(...args)) as ObjectConstructor["keys"],
  /** returns a copy of an obj sorted by key */
  sort: <T extends HashM<anyOk>>(obj: T): T =>
    O.keys(obj)
      .toSorted()
      .reduce((result: anyOk, key: string) => {
        result[key] = obj[key];
        return result;
      }, {}),
  /** An alias for Object.values */
  vals: ((...args: [anyOk]) =>
    Object.values(...args)) as ObjectConstructor["values"],
};

/** omit kets from an object */
export const omit = <T extends Record<string, anyOk>, K extends keyof T>(
  obj: T,
  keys: readonly K[] | K[]
): Omit<T, K> => {
  const res = O.ass({}, obj);
  keys?.forEach((k) => {
    if (k in obj) delete res[k];
  });
  return res;
};

/** alias for Promise */
export const P = O.ass(Promise, {
  wr: Promise.withResolvers,
});

export interface PkgJson {
  name: string;
  version: string;
  description?: string;
  main?: string;
  scripts?: Dict;
  dependencies?: Dict;
  devDependencies?: Dict;
  peerDependencies?: Dict;
  optionalDependencies?: Dict;
  private?: boolean;
}

/** A return type of a promise */
export type PReturnType<T extends (...args: anyOk) => Promise<anyOk>> =
  ReturnType<T> extends Promise<infer U> ? U : never;

/**
 * similar to Promise.all, but also flushes the list, which is convenient if
 * using re-useable promise arrays.
 */
export const pAll: typeof Promise.all = async (
  // @ts-expect-error - it's fine
  ps
) => {
  // splice bc it gets cranky otherwise
  return Promise.all(ps.splice(0, ps.length));
};

/**
 * Stack traces are the best if you throw this function
 * always pass a real Error, otherwise the stack trace will have throwError
 */
export const stepErr = (e: anyOk, step: string, extra: HashM<anyOk> = {}) => {
  return O.ass(e, {
    step: `${step}${e?.step ? `:${e?.step}` : ""}`,
    ...extra,
  });
};
/** Convenient to .catch */
export const stepErrCb =
  (step: string, extra: HashM<anyOk> = {}) =>
  (e: anyOk) => {
    O.ass(e, { step: `${step}${e?.step ? `:${e?.step}` : ""}`, ...extra });
    throw e;
  };

// Regular expression to match ANSI escape codes
export const strAnsiEscapeExp =
  // eslint-disable-next-line no-control-regex
  /(?:\x1B[@-Z\\-_]|\x9B|\x1B\[)[0-?]*[ -/]*[@-~]/g;

export const str = (o: anyOk, spaces?: number): string =>
  JSON.stringify(
    o,
    (k, v) => {
      if (v instanceof Error) return { ...v, stack: v.stack };
      if (v instanceof Map) return Object.fromEntries(v.entries());
      if (v instanceof Set) return Array.from(v);
      return v;
    },
    spaces ? 2 : 0
  );

export const str2 = (o: anyOk): string => {
  if (!o) return "";
  let s = str(o);
  if (s === "{}") return s;
  if (s === "[]") return s;
  s = s
    // remove first and last brackets
    .replace(/^[{[]/, "")
    .replace(/[}\]]$/, "")
    // remove quotes
    .replace(/["]/g, "")
    // add a space after commas
    .replace(/,/g, ", ");
  return s;
};

export const strCondense = (
  s: string,
  options: { removeStyle?: boolean } = {}
): string => {
  const { removeStyle = true } = options;
  s = s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
  if (removeStyle) s = s.replace(strAnsiEscapeExp, "");
  return s;
};

/** Match a string against multiple regexs */
export const strMatchMany = (
  strToTestAgainst: string,
  options: {
    excludes?: RegExp[];
    includes?: RegExp[];
  }
) => {
  const { excludes, includes } = options;
  if (excludes) {
    for (const e of excludes) {
      if (strToTestAgainst.match(e)) return;
    }
  }
  if (includes) {
    let includeMatch = false;
    for (const i of includes) {
      if (strToTestAgainst.match(i)) includeMatch = true;
    }
    if (includes.length && !includeMatch) return;
  }
  return true;
};

export const strTrim = (s: string, len: number) => {
  if (s.length <= len) return s;
  return s.slice(0, len) + "...";
};

/**
 * convenience method for throwing errors inline.
 * always pass a real Error, otherwise the stack trace will have throwError
 */
export const throwErr = (e: anyOk, ...extra: anyOk): never => {
  throw O.ass(e, extra);
};

// const cache: Dict<{
//   bin: string;
//   ts: number;
// }> = {};

// const cacheService = {
//   get: async (csum: string) => {
//     if (csum in cache) return cache[csum];
//     return null;
//   },
//   put: async (csum: string, bin: string) => {
//     cache[csum] = { bin, ts: Date.now() };
//   },
// };

export class AbstractCache {
  static csumType: string;
  add!: (
    key: string,
    buffer: Buffer,
    options?: { attrs?: Dict }
  ) => Promise<AbstractCacheStat>;
  get!: (
    key: string,
    options?: { attrs?: boolean }
  ) => Promise<AbstractCacheStat & { buffer: Buffer }>;
  stat!: (
    key: string,
    options?: { attrs?: boolean }
  ) => Promise<AbstractCacheStat>;
}
export interface AbstractCacheStat {
  attrs: Dict;
  key: string;
  size: BigInt;
  ts: Date;
}
export class LocalCache extends AbstractCache {
  static csumType = "md5";
  public path: string;

  constructor(options: { path: string }) {
    super();
    this.path = options.path;
  }
  add = async (key: string, buffer: Buffer, options: { attrs?: Dict } = {}) => {
    try {
      log5(`LCACHE:put->${key}`);
      const { attrs } = options;
      await this.init();
      const toPath = this.cPath(key);
      await fs.setBin(toPath, buffer, { xattrs: attrs });
      // get stat without attrs bc we already have attrs to save a fs call
      const stat = this.stat(key);
      Object.assign(stat, { attrs });
      return stat;
    } catch (e: anyOk) {
      throw stepErr(e, "LCACHE:add", { key });
    }
  };
  get = async (key: string) => {
    try {
      log5(`LCACHE:get->${key}`);
      await this.init();
      const stat = await this.stat(key, { attrs: true });
      const buffer = (await fs.getBin(this.cPath(key))).buffer;
      return {
        ...stat,
        buffer,
      };
    } catch (e: anyOk) {
      throw stepErr(e, "LCACHE.get", { key });
    }
  };
  init = cachify(async () => {
    try {
      log5("LCACHE:init");
      const stat = await fs.stat(this.path).catch(() => {});
      if (stat) return;
      await fsNode.mkdir(this.path, { recursive: true });
    } catch (e: anyOk) {
      throw stepErr(e, "LCACHE.init");
    }
  });
  purge = async (
    options: { excludes?: RegExp[]; includes?: RegExp[] } = {}
  ) => {
    try {
      log3("LCACHE:purge");
      await this.init();
      const { excludes, includes } = options;
      const count = await fs.purgeDir(this.path, { excludes, includes });
      return count;
    } catch (e: anyOk) {
      throw stepErr(e, "LocalCache:purge");
    }
  };
  stat = async (key: string, options: { attrs?: boolean } = {}) => {
    log5(`LCACHE:stat->${key}`);
    const { attrs } = options;
    await this.init();
    const path = this.cPath(key);
    const stat = await fs.stat(path, { xattrs: attrs }).catch(() => {
      throw stepErr(Error(`key not found: ${key}`), "LCACHE:stat");
    });
    return {
      attrs: stat.xattrs,
      key,
      size: BigInt(stat.size),
      ts: new Date(stat.mtime),
    };
  };
  cPath = (key: string) => `${this.path}/${key}`;
}

/** Filesystem (aka fs) - helpers */
export class fs {
  static basename = pathNode.basename;

  /**
   * Backups files for debugging and troubleshooting purposes
   * to: `/tmp/lerna-crosslink-build/${timestamp}`
   */
  static backup = async (
    path: string,
    options: {
      text?: string;
      moveInsteadOfCopy?: boolean;
    } = {}
  ) => {
    try {
      const { text = null, moveInsteadOfCopy = false } = options;

      await fs.tmpDirCreate();
      const wsRoot = await fs.findNearestWsRoot();

      if (!path.startsWith(wsRoot)) {
        throw stepErr(Error(`path not in workspace`), `wsroot`, {
          backupPath: path,
        });
      }

      path = fs.relative(wsRoot, path);

      let backupPath = "";
      for (let i = 0; i < Infinity; i++) {
        backupPath =
          `${fs.tmpDir}/${path.replace(/\//g, ".")}-` +
          String(i).padStart(2, "0");
        if (!(await fs.stat(backupPath).catch(() => {}))) break;
      }

      if (text) {
        await fs.set(backupPath, text, { skipBackup: true });
      } else if (moveInsteadOfCopy) {
        await fs.rename(path, backupPath, { skipBackup: true });
      } else {
        await fs.copyFile(path, backupPath, { skipBackup: true });
      }
    } catch (e: anyOk) {
      throw stepErr(e, `fs.backup:${e?.step}`);
    }
  };

  static copyFile = async (
    from: string,
    to: string,
    options: {
      skipBackup?: boolean;
    } = {}
  ) => {
    try {
      const toStat = await fs.stat(to).catch(() => {});

      try {
        const { skipBackup = false } = options;
        if (!skipBackup) {
          if (toStat) {
            await fs.backup(to);
            if (!(to in fs.dirtyFiles)) {
              fs.dirtyFiles[to] = { path: to, orig: (await fs.get(to)).text };
            }
          } else {
            await fs.createdFiles.push(to);
          }
        }
      } catch (e: anyOk) {
        throw stepErr(e, `backup`);
      }

      if (toStat?.isDirectory()) {
        to = `${to}/${fs.basename(from)}`;
      }

      await fsNode.copyFile(from, to).catch((e) => {
        throw stepErr(e, "copyFile");
      });
    } catch (e: anyOk) {
      throw stepErr(e, `fs.copyFile`, { from, to });
    }
  };

  static createdFiles: string[] = [];

  static dirname = pathNode.dirname;

  static dirtyFiles: HashM<{
    orig: string;
    path: string;
  }> = {};

  /**
   * traverse the directory tree from __dirname to find the nearest package.json
   * with name=root or .monorc.ts. If none found, throw an error.
   */
  static findNearestWsRoot = cachify(async (startFrom = process.cwd()) => {
    log4("findNearestWsRoot->start");
    let root = startFrom;
    while (true) {
      const ws = await fs.getPkgJsonFileC(root).catch(() => {});
      if (ws?.json.name === "root") break;
      const configF = await import(`${root}/.monorc.ts`).catch(() => {});
      if (configF?.config) break;
      const next = fs.resolve(root, "..");
      if (next === root) {
        throw stepErr(
          Error(
            "No package.json:name=root or .monorc.ts found in the directory tree"
          ),
          "findNearestWsRoot"
        );
      }
      root = next;
    }
    log4(`findNearestWsRoot->${root}`);
    return root;
  });

  /** get's a file object */
  static get = async (
    path: string,
    options: {
      xattrs?: boolean;
    } = {}
  ) => {
    try {
      const { xattrs } = options;
      const text = await fsNode.readFile(path, "utf-8").catch(() => {
        throw stepErr(Error(`fg:file not found`), `readfile`);
      });
      const file = {
        /** resets the file to the original state when first read */
        reset: async () => {
          log5(`fs.get->reset ${path}`);
          await fs.set(path, text).catch((e) => {
            throw stepErr(e, `fs.get.reset`, { rstPath: path });
          });
          log5(`fs.get->reset-success ${path}`);
        },
        save: async () => fs.set(path, file.text),
        set: (newText: string) => fs.set(path, newText),
        xattrs: xattrs ? await fs.getXattrs(path) : {},
        text,
      };
      return file;
    } catch (e: anyOk) {
      throw stepErr(e, `fs.get`, { getPath: path });
    }
  };
  /** get's a file object from cache or fs */
  static getC = cachify(fs.get);

  static getBin = async (
    path: string,
    options: {
      xattrs?: boolean;
    } = {}
  ) => {
    try {
      const { xattrs } = options;
      const buffer = await fsNode.readFile(path).catch(() => {
        throw stepErr(Error(`fgb:file not found`), `fs.getBin`, {
          binPath: path,
        });
      });
      return {
        buffer,
        xattrs: xattrs ? await fs.getXattrs(path) : {},
      };
    } catch (e: anyOk) {
      throw stepErr(e, `fs.getBin`, { getBinPath: path });
    }
  };

  /** get json file */
  static getJsonFile = async <T>(path: string) => {
    const file = await fs.get(path);
    const json = JSON.parse(file.text) as T;
    const jsonF = {
      ...file,
      json,
      jsonOrig: json,
      path,
      /** will reset to the original values when first read */
      reset: async () => {
        await file.reset();
        jsonF.json = jsonF.jsonOrig;
      },
      /** will save to fs whatever the current values in json are */
      save: async () => jsonF.setJson(jsonF?.json),
      /** will set the json and write it to disk */
      setJson: async (json: anyOk) => file.set(str(json, 2) + "\n"),
    };
    return jsonF;
  };
  /** get json file from cache or fs */
  static getJsonFileC = cachify(fs.getJsonFile);

  /** get package.json file */
  static getPkgJsonFile = (pathToPkgOrPkgJson: string) => {
    let path = pathToPkgOrPkgJson;
    if (!path.endsWith("package.json")) path = `${path}/package.json`;
    return fs.getJsonFile<PkgJson>(path);
  };
  /** get package.json file from cache or fs */
  static getPkgJsonFileC = cachify(fs.getPkgJsonFile);

  /** Gets xattrs (extended attributes) from a file, sorted by key */
  static getXattrs = async (path: string): Promise<Dict> => {
    try {
      const xattrs = await sh
        .exec(`xattr -l ${path}`, { silent: true })
        .then((res) => {
          return res.split("\n").reduce<Dict>((acc, line) => {
            const [name, value] = line.split(":");
            if (name && value) {
              acc[name.trim()] = value.trim();
            }
            return acc;
          }, {});
        });
      return O.sort(xattrs);
    } catch (e) {
      throw stepErr(e, `fs.getXattrs`, { getXattrsPath: path });
    }
  };

  static home = osNode.homedir();

  /** get file list from cache or fs */
  // FIXME: replace usages of sh.find with this
  static ls = async (
    /** this should be an abs path */
    pathToLs: string,
    options: {
      currentDepth?: number;
      excludes?: RegExp[];
      includes?: RegExp[];
      maxDepth?: number;
      recursive?: boolean;
      /** Should the paths returned be relative to pathToLs */
      relative?: boolean;
      typeFilter?: "file" | "dir";
    } = {}
  ): Promise<string[]> => {
    try {
      log5(`fs:ls:start->${pathToLs}`);

      if (pathToLs[0] !== "/")
        pathToLs = pathNode.resolve(process.cwd(), pathToLs);

      const {
        currentDepth = 0,
        excludes = [],
        includes,
        maxDepth = Infinity,
        recursive = false,
        relative = false,
        typeFilter,
      } = options;

      excludes.push(...[/.DS_Store/]);

      let paths: string[] = [];
      await fsNode
        .readdir(pathToLs, { withFileTypes: true })
        .then(async (rdResults) =>
          P.all(
            rdResults.map(async (rdResult) => {
              const shouldInclude = strMatchMany(rdResult.name, {
                excludes,
                includes,
              });
              if (!shouldInclude) return;

              const rdResAbsPath = `${pathToLs}/${rdResult.name}`;
              const isDir = rdResult.isDirectory();
              const isFile = rdResult.isFile();

              if (isDir && recursive && currentDepth < maxDepth) {
                const lsPaths = await fs.ls(rdResAbsPath, {
                  currentDepth: currentDepth + 1,
                  excludes,
                  maxDepth,
                  recursive,
                  typeFilter,
                });
                paths.push(...lsPaths);
              }
              if (typeFilter) {
                if (typeFilter === "dir" && !isDir) return false;
                if (typeFilter === "file" && !isFile) return false;
              }
              paths.push(rdResAbsPath);
            })
          )
        )
        .catch(() => {
          throw stepErr(Error("Path not found"), `readdir`);
        });

      if (relative && currentDepth === 0) {
        paths = paths.map((p) => fs.pathRel(pathToLs, p));
      }
      if (currentDepth === 0) paths.sort();
      return paths;
    } catch (e) {
      throw stepErr(e, `fs.ls`, { pathToLs });
    }
  };
  static lsC = cachify(fs.ls);

  /** md5s the recursive contents of files and paths */
  static md5 = async (
    filePathOrPaths: string | string[],
    options: { excludes?: RegExp[]; includes?: RegExp[]; salts?: string[] } = {}
  ) => {
    try {
      if (!Is.arr(filePathOrPaths)) filePathOrPaths = [filePathOrPaths];
      const { excludes, includes, salts = [] } = options;
      const buffers: Buffer[] = [];
      await P.all(
        filePathOrPaths.map(async (path) => {
          const shouldInclude = strMatchMany(path, {
            excludes,
            includes,
          });
          if (!shouldInclude) return;

          const stat = await fs.stat(path).catch(() => {
            throw stepErr(Error(`fsm:File not found`), "stat", {
              md5Path: path,
            });
          });
          if (stat.isFile()) {
            buffers.push((await fs.getBin(path)).buffer);
          } else {
            const pathsRecursive = await fs.ls(path, {
              ...options,
              recursive: true,
              typeFilter: "file",
            });
            buffers.push(
              ...(await P.all(
                pathsRecursive.map((p) => fs.getBin(p).then((r) => r.buffer))
              ))
            );
          }
        })
      );
      return md5([...buffers, ...salts]);
    } catch (e: anyOk) {
      throw stepErr(e, `fs.md5`);
    }
  };

  static pathRel = pathNode.relative;

  static purgeDir = async (
    path: string,
    options: { excludes?: RegExp[]; includes?: RegExp[] } = {}
  ) => {
    try {
      const { excludes, includes } = options;
      const todo = await fs
        .ls(path, { includes, excludes, recursive: false })
        .catch(() => []);
      if (!todo?.length) return 0;
      await P.all(todo.map((f) => fs.rm(f, { skipBackup: true })));
      return todo.length;
    } catch (e: anyOk) {
      throw stepErr(e, `fs.purgeDir`, { path });
    }
  };

  static read = fs.get;
  static relative = pathNode.relative;

  static rename = async (
    from: string,
    to: string,
    options: {
      skipBackup?: boolean;
    } = {}
  ) => {
    try {
      const { skipBackup = false } = options;
      if (!skipBackup) {
        await fs.backup(from);
        if (!(from in fs.dirtyFiles)) {
          fs.dirtyFiles[from] = { path: from, orig: (await fs.get(from)).text };
        }
        if (await fs.stat(to).catch(() => {})) {
          await fs.backup(to);
          if (!(to in fs.dirtyFiles)) {
            fs.dirtyFiles[to] = { path: to, orig: (await fs.get(to)).text };
          }
        } else {
          fs.createdFiles.push(to);
        }
      }
    } catch (e: anyOk) {
      throw O.ass(Error(e), { step: `fs.rename:backup->failed` });
    }
    await fsNode.rename(from, to).catch((e) => {
      throw stepErr(
        Error(`${e.message};\nfrom:${from}\nto:${to}`),
        `fs.rename`
      );
    });
  };

  static resetChangedFiles = async () => {
    try {
      const lctx = `fs.resetChangedFiles`;
      log4(`${lctx}->start!`);
      await P.all(
        O.vals(fs.dirtyFiles).map((df) =>
          fs.set(df.path, df.orig, { skipBackup: true })
        )
      );
      await P.all(
        fs.createdFiles.map((cf) =>
          fs.rm(cf, { skipBackup: true }).catch(() => {})
        )
      );
    } catch (e: anyOk) {
      throw stepErr(e, "fs.resetChangedFiles");
    }
  };

  static resolve = pathNode.resolve;

  static fileURLToPath = urlNode.fileURLToPath;

  /** wrapper for fs.rm with defaults and filters */
  static rm = async (
    path: string,
    options: Parameters<(typeof fsNode)["rm"]>[1] & {
      skipBackup?: boolean;
    } = {}
  ) => {
    try {
      const { force, recursive = true, skipBackup = true } = options;
      const stat = await fs.stat(path).catch(() => {});
      if (!stat) {
        if (force) return;
        throw stepErr(Error(`frm:path not found`), "stat", { rmPath: path });
      }
      const isFile = stat.isFile();
      if (!skipBackup && !(path in fs.dirtyFiles) && isFile) {
        fs.dirtyFiles[path] = { path, orig: (await fs.get(path)).text };
      }
      if (isFile) {
        return fsNode.unlink(path);
      } else {
        return fsNode.rm(path, { force, recursive });
      }
    } catch (e: anyOk) {
      throw stepErr(e, "fs.rm", { rmPath: `path` });
    }
  };

  static set = async (
    toPath: string,
    text: string,
    options: {
      skipBackup?: boolean;
      xattrs?: Dict;
    } = {}
  ) => {
    const { skipBackup = false, xattrs } = options;
    try {
      if (!skipBackup) {
        if (await fs.stat(toPath).catch(() => {})) {
          await fs.backup(toPath);
          if (!(toPath in fs.dirtyFiles)) {
            fs.dirtyFiles[toPath] = {
              path: toPath,
              orig: (await fs.get(toPath)).text,
            };
          }
        } else {
          fs.createdFiles.push(toPath);
        }
      }
    } catch (e: anyOk) {
      throw stepErr(e, `fs.set:backup->failed`);
    }
    await fsNode.writeFile(toPath, text, "utf8").catch((e) => {
      throw stepErr(Error(e.message), `fs.set:write`, { setPath: toPath });
    });
    if (xattrs) {
      await fs.setXattrs(toPath, xattrs);
    }
  };

  static setBin = async (
    toPath: string,
    bin: Buffer,
    options: {
      xattrs?: Dict;
    } = {}
  ) => {
    const { xattrs } = options;
    await fsNode.writeFile(toPath, bin).catch((e) => {
      throw stepErr(Error(`${e.message}; to:${toPath}`), `fs.setBin`);
    });
    if (xattrs) {
      await fs.setXattrs(toPath, xattrs);
    }
  };

  /** sets xattrs (extended attributes) to a file */
  static setXattrs = async (toPath: string, xattrs: Dict) => {
    try {
      const ents = O.ents(xattrs);
      if (!ents.length) {
        throw stepErr(Error(`Empty xattrs`), `check`);
      }
      const cmds = ents.map(([k, v]) => {
        if (["", null, undefined].includes(k) || !Is.str(k)) {
          throw stepErr(Error(`Bad key value`), `check-key`, { key: k });
        }
        if (["", null, undefined].includes(v) || !Is.str(k)) {
          throw stepErr(Error(`Bad value`), `check-val`, { val: v });
        }
        return `xattr -w ${k} "${v}" ${toPath}`;
      });
      await sh.exec(cmds.join("; ")).catch((e) => {
        throw stepErr(e, `set`);
      });
    } catch (e) {
      throw stepErr(e, `fs.setXattrs`, { setXattrsPath: toPath, xattrs });
    }
  };

  /** gets fs.stat + xattr */
  static stat = async (
    path: string,
    options: {
      xattrs?: boolean;
    } = {}
  ) => {
    try {
      const { xattrs: incXattrs } = options;
      const stat = await fsNode.stat(path);
      let xattrs = {};
      if (incXattrs) {
        xattrs = await fs.getXattrs(path);
      }
      O.ass(stat, { xattrs });
      return stat as PReturnType<typeof fsNode.stat> & { xattrs: Dict };
    } catch (e) {
      throw stepErr(Error("fsc:File not found"), "fs.stat", {
        statPath: path,
      });
    }
  };

  static tmpDir =
    `${fs.home}/.mono/runs/` +
    new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/(-|T|:)/g, ".");
  static tmpDirCreate = cachify(async () => {
    return (
      utilNode
        // FIXME: use fs instead of exec
        .promisify(childProcessNode.exec)(`mkdir -p ${fs.tmpDir}`)
        .catch((e) => {
          throw stepErr(e, `fs.tmpDirCreate`);
        })
    );
  });
  static tmpDirPurge = async () => {
    log2("purgeTmpDir");
    await fs.rm(fs.tmpDir);
  };
}

/** Shell / Process helpers aka sh */
export class sh {
  static _exec = utilNode.promisify(childProcessNode.exec);

  static cmdExists = async (
    cmd: string,
    options: {
      /** Working directory. This may be important if you use .tool-versions */
      wd?: string;
    } = {}
  ) => {
    const { wd } = options;
    const res = !!(await sh
      .exec(`command -v ${cmd}`, { silent: true, wd })
      .catch(() => {}));
    return res;
  };
  static assertCmdExists = cachify(
    async (
      cmd: string,
      options: {
        /** Working directory. This may be important if you use .tool-versions */
        wd?: string;
      } = {}
    ) => {
      const { wd } = options;
      const res = await sh
        .exec(`command -v ${cmd}`, { silent: true, wd })
        .catch(() => {
          throw stepErr(
            Error(`Command not found: ${cmd}`),
            `sh.assertCmdExists`
          );
        });
      return res;
    }
  );

  /** Node exec wrapper with lots of special sauce */
  static exec = async (
    cmd: string,
    options: {
      /** cb for logs on a lineArray.filter */
      logFilter?: (text: string) => boolean;
      prefix?: string;
      rawOutput?: boolean;
      silent?: boolean;
      throws?: boolean;
      verbose?: boolean;
      /** working directory */
      wd?: string;
    } = {}
  ): Promise<string> => {
    const id = (sh.execCount = (sh.execCount ?? 0) + 1);
    const {
      logFilter = () => true,
      prefix = `sh:${id}:`,
      rawOutput = false,
      silent = false,
      throws = true,
      verbose = false,
      wd = process.cwd(),
    } = options;

    let _log1 = log1;
    let _log4 = log4;
    if (verbose) {
      _log1 = _log4 = log1;
    }
    if (silent) {
      _log1 = _log4 = log9;
    }

    /** Special handle the logging of the stdout/err */
    /** Track if out was logged bc we need to log it on error if !silent regardless  */
    let outWasLoggedToConsole = false;
    let _logOut = _log4;
    if (rawOutput) {
      _logOut = log0;
      outWasLoggedToConsole = true;
    } else if (silent) {
      _logOut = log9;
    } else if (verbose) {
      _logOut = log1;
      outWasLoggedToConsole = true;
    } else {
      _logOut = log4;
      outWasLoggedToConsole = logDefault.logLevel >= 4;
    }
    let allout = "";
    const logOut = (text: string) => {
      if (rawOutput) {
        _logOut(text);
        return;
      }

      const lines = text
        .split("\n")
        .filter(logFilter)
        .map((l) => {
          l = l.trim();
          l = l.replace(process.cwd(), "wd:");
          return l;
        })
        .filter(Boolean);
      allout += lines.join("\n") + "\n";
      _logOut(lines.map((l) => `${prefix} ${l}`).join("\n"));
    };

    _log4(`${prefix} cmd='${strTrim(cmd, 300)}'`);
    log9(`${prefix}:${id} cmdFull='${cmd}'`);
    _log4(`${prefix} cwd=${wd}`);

    const cmdFinal = options.wd ? `cd ${wd} && ${cmd} 2>&1` : cmd;
    const execP = P.wr<string>();
    const cp = childProcessNode.spawn(cmdFinal, { shell: true });
    cp.stdout.on("data", (data) => logOut(data.toString()));
    cp.stderr.on("data", (data) => logOut(data.toString()));
    cp.on("close", (code) => {
      if (!allout) {
        allout = "(empty stdout/stderr)";
        logOut(`${prefix} ${allout}`);
      }
      if (code) {
        if (!outWasLoggedToConsole) {
          console.log(`${prefix} cmd='${strTrim(cmd, 200)}'`);
          console.log(`${prefix} wd=${wd}`);
          console.log(
            allout
              .split("\n")
              .map((l) => `${prefix} ${l}`)
              .join("\n") + "\n"
          );
        }
        _log1(`${prefix} ERROR!`);
        _log1(`${prefix} cmd='${strTrim(cmd, 200)}'`);
        _log1(`${prefix} wd=${wd}`);
        _log1(`${prefix} code=${code}`);

        const err = O.ass(Error(`sh:${id}->nonzero-return`), {
          cmd: strTrim(cmd, 200),
          execId: id,
          step: "exec",
          workingDir: wd,
        });
        if (throws) {
          execP.reject(err);
        }
      }
      execP.resolve(allout);
    });
    return execP.promise;
  };
  static execCount = 0;

  static sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
}

export class Log {
  static appendLogFilePromises: Promise<void>[] = [];
  static file = `${fs.tmpDir}/run.log`;
  public logLevel = UTIL_ENV.logLevel;
  public prefix: string;
  public showLogLevels: boolean;
  public showTimestamps: boolean;

  constructor(
    options: {
      prefix?: string;
    } = {}
  ) {
    const { prefix = "" } = options;
    this.prefix = prefix ?? "";
    this.showLogLevels = false;
    this.showTimestamps = false;
  }

  /**
   * reserved numbers:
   * 0: don't decorate at all, like if were calling another library that has its
   *    own logging decorations
   * 9: don't print to console, only to log file
   */
  logn(n: number) {
    const logFnc = (...args: anyOk) => {
      /** determines how much logging is printed to the console. Higher is more. */
      this.logLevel = UTIL_ENV.logLevel;
      const isErr = args[0] instanceof Error;

      // This debug line helps find empty log calls
      // if ([...args].join("").trim() === "") console.trace();

      if (n === 0) {
        console.log(...args);
        void fs
          .tmpDirCreate()
          .then(() => fsNode.appendFile(Log.file, args.join(" ") + "\n"));
        return args;
      }

      // if first arg is an array, log each item in the array
      if (Is.arr(args[0])) {
        args[0].forEach((a) => logFnc(a));
        return;
      }

      if (this.prefix && !isErr) {
        if (Is.str(args[0])) args[0] = this.prefix + args[0];
        else args.unshift(this.prefix);
      }

      // ts = yyyy:hh:mm:ss:msms -> ie 2024:15:12:41.03
      const ts = new Date().toISOString().slice(0, -2);

      // skip logging to console if the log message level is higher than the log level
      if (this.logLevel >= n) {
        const argsExtra = args;
        if (Is.str(args[0])) {
          if (args[0].match(/INFO/)) args[0] = Log.colors.cyan(args[0]);
          if (args[0].match(/ERROR/)) args[0] = Log.colors.red(args[0]);
        }
        const tsNoYear = ts.slice(11);
        if (this.showLogLevels) {
          argsExtra.unshift(`L${n}`);
        }
        if (this.showTimestamps) {
          argsExtra.unshift(tsNoYear);
        }
        console.log(...argsExtra);
      }

      // lazily log to file
      void fs.tmpDirCreate().then(() => {
        let txt = "";
        if (isErr) {
          const lines = [];
          // dump of the error in a the way that mimics console
          lines.push(args[0].stack + " {");
          lines.push(...O.ents(args[0]).map(([k, v]) => `  ${k}: ${v}`));
          lines.push("}");
          txt = lines.join("\n") + "\n";
        } else {
          const lines = [];
          lines.push(`${ts} L${n}`);
          const hasObjs = args.some((a: anyOk[]) => Is.obj(a));
          if (!hasObjs) lines[0] += ` ${args.join(" ")}`;
          else lines.push(...args.map(str));
          txt = lines.join(" ") + "\n";
        }
        Log.appendLogFilePromises.push(fsNode.appendFile(Log.file, txt)); // be lazy about it
      });

      return args;

      // end of logFnc
    };
    return logFnc;
    // end of logn
  }
  /**
   * a special level that means don't decorate at all, like if were
   * calling another library that has its own logging decorations
   */
  l0 = (...args: anyOk) => {
    return this.logn(0)(...args);
  };
  l1 = (...args: anyOk) => {
    return this.logn(1)(...args);
  };
  l2 = (...args: anyOk) => {
    return this.logn(2)(...args);
  };
  l3 = (...args: anyOk) => {
    return this.logn(3)(...args);
  };
  l4 = (...args: anyOk) => {
    return this.logn(4)(...args);
  };
  l5 = (...args: anyOk) => {
    return this.logn(5)(...args);
  };
  /** High number that's used mainly to print to log file without console  */
  l9 = (...args: anyOk) => {
    return this.logn(9)(...args);
  };

  lErrCtx = (e: anyOk) => {
    log1(`Error: ${e.message}`);
    this.l1(e);
    this.l1(
      `ERROR:CTX->${str(
        {
          step: `${e?.step ?? "unknown"}`,
          ...omit(e, ["message", "originalColumn", "originalLine", "stack"]),
        },
        2
      ).replace(/"/g, "")}`
    );
  };

  lFinish = async (maybeErr?: anyOk) => {
    if (maybeErr) this.lErrCtx(maybeErr);
    this.l1(`LOG->${Log.file}`);
    await Log.waitForlogFileSettled();
  };

  static waitForlogFileSettled = async () => {
    await pAll(Log.appendLogFilePromises);
  };

  static colors = {
    cyan: (text: string) => `\x1b[36m${text}\x1b[0m`,
    yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
    blue: (text: string) => `\x1b[34m${text}\x1b[0m`,
    magenta: (text: string) => `\x1b[35m${text}\x1b[0m`,
    red: (text: string) => `\x1b[31m${text}\x1b[0m`,
    green: (text: string) => `\x1b[32m${text}\x1b[0m`,
    white: (text: string) => `\x1b[37m${text}\x1b[0m`,
    black: (text: string) => `\x1b[30m${text}\x1b[0m`,
    brightCyan: (text: string) => `\x1b[96m${text}\x1b[0m`,
    brightYellow: (text: string) => `\x1b[93m${text}\x1b[0m`,
  };
}
export const logDefault = new Log();
export const log0 = logDefault.l0;
export const log1 = logDefault.l1;
export const log2 = logDefault.l2;
export const log3 = logDefault.l3;
export const log4 = logDefault.l4;
export const log5 = logDefault.l5;
export const log9 = logDefault.l9;
export const logErrCtx = logDefault.lErrCtx;
export const logFinish = logDefault.lFinish;

export class Time {
  static diff = (start: number | Date, end?: number | Date) => {
    const startMs = start instanceof Date ? start.getTime() : start;
    const endMs = end instanceof Date ? end.getTime() : end ? end : Date.now();
    const ms = Math.abs(endMs - startMs);

    const d = Math.floor(ms / (1000 * 60 * 60 * 24));
    const h = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const m = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
    const s = Math.floor((ms % (1000 * 60)) / 1000);

    let str = "";
    if (d > 0) str += `${d}d`;
    if (h > 0) str += `${h}h`;
    if (m > 0) str += `${m}m`;
    if (s > 0) str += `${s}s`;

    // Remove the trailing comma and space if present
    str = str.trim();

    return str || "0s"; // Return "0 seconds" for no difference
  };
}

export class Yarn {
  static cachePurge = async (pkgNames?: string[]) => {
    try {
      log4("cleanYarnCache->start");
      if (!pkgNames) {
        await fs.purgeDir(`${fs.home}/Library/Caches/Yarn/v6`);
      } else {
        await P.all([
          fs.purgeDir(`${fs.home}/Library/Caches/Yarn/v6/`, {
            excludes: [/\.tmp/],
            includes: [
              new RegExp(
                `^(${pkgNames
                  .map((n) => `npm-${n.replace("/", "-")}`)
                  .join("|")})`
              ),
            ],
          }),
          sh.exec(
            `find ${
              fs.home
              // TODO: find the pattern of where the package.jsons are and consider avoiding a sh.exec
            }/Library/Caches/Yarn/v6/.tmp -name package.json -exec grep -sl ${pkgNames
              .map((name) => `-e ${name}`)
              .join(" ")} {} \\; | xargs dirname | xargs rm -rf`
          ),
        ]);
      }
      log4("cleanYarnCache->end");
    } catch (e: anyOk) {
      throw stepErr(e, "cleanYarnCache");
    }
  };
}

/** Mainly used for testing */
if (import.meta.url === `file://${process.argv[1]}`) {
  // console.log(process.argv);
  // d@ts-expect-error - gets confused args
  // await main(...process.argv.slice(2));
  await fs.ls(process.argv[2], { recursive: true });
}
