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
};

/** Aliases and misc */

/** Array aliases */
export const A = {
  /** a very basic compare */
  compare: <A, B>(
    /** from array */
    a: A[],
    /** to array */
    b: B[]
  ) => {
    const added = b.filter((v: anyOk) => !a.includes(v));
    const removed = a.filter((v: anyOk) => !b.includes(v));
    return { added, removed };
  },
  /** Depups an array in place */
  dedup: <T>(arr: T[]) => {
    const deduped = A.toDedup(arr);
    arr.length = 0;
    arr.push(...deduped);
    return arr;
  },
  /** filter in place */
  filter: <T>(arr: T[], cb: (v: T, i: number, arr: T[]) => boolean): T[] => {
    const filtered = arr.filter(cb);
    arr.length = 0;
    arr.push(...filtered);
    return arr;
  },
  /** Note: USE just .sort() instead -- sorts an array in place alphabetically */
  // sortAlpha: <T extends string[]>(arr: T): T => arr.sort(strCompare),
  /** Depups an array */
  toDedup: <T>(arr: T[]): T[] => [...new Set(arr)],
  /** A better Array.from that will turn anything into an array */
  // from: <T>(arg: T): T extends ArrayLike<anyOk> ? T : T[] => {
  from: <
    // the default if we just convert to array by wrapping in brackets ie [ANY]
    ANY,
    // Map key/val types
    M1,
    M2,
    // Record key/val types
    R1 extends string | number | symbol,
    R2,
    // Set val type
    S
  >(
    arg: Map<M1, M2> | Record<R1, R2> | ANY
  ): ANY extends anyOk[]
    ? ANY
    : ANY extends
        | bigint
        | boolean
        | Buffer
        | Date
        | Fnc
        | number
        | RegExp
        | string
        | symbol
        | undefined
    ? ANY[]
    : ANY extends Map<M1, M2>
    ? [M1, M2][]
    : ANY extends Set<S>
    ? S[]
    : ANY extends Record<R1, R2>
    ? [R1, R2][]
    : ANY[] => {
    if (Is.arr(arg)) return arg as anyOk;
    if (Is.map(arg)) return Array.from(arg as Map<anyOk, anyOk>) as anyOk;
    if (Is.set(arg)) return Array.from(arg as Set<anyOk>) as anyOk;
    // if (Is.scalar(arg)) return [arg] as anyOk;
    return [arg] as anyOk;
  },
  equals: <T>(a: T[], b: T[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]),
};

type Cachified<T extends Fnc> = (
  ...args: [
    ...Parameters<T>,
    opts?: { bustCache?: boolean; setCache?: ReturnType<T> | ReturnTypeP<T> }
  ]
) => ReturnType<T>;
/**
 * Wraps an async function with a simple cache
 * - an optional obj parameter is added to the end of the function signature,
 *   which can be used to bust or set the cache
 *
 * ex. f = cachify(async (a: number) => a + 1))
 * f(1) // 2
 * f(1) // 2, but from cache
 * f(1, { bustCache: true }) // 2, but recalculated
 * f(1, { setCache: 3 }) // sets the cache to 3 and returns it
 */
export function cachify<T extends Fnc>(fn: T): Cachified<T> {
  const cache: Map<anyOk, anyOk> = new Map();
  const cached = (...args: anyOk[]) => {
    const maybeOpts = args.at(-1);
    if (maybeOpts?.bustCache) {
      cache.clear();
      args.pop();
    }
    const key = JSON.stringify(args?.length ? args : "none");
    if (maybeOpts?.setCache) {
      cache.set(key, Promise.resolve(maybeOpts.setCache));
      return maybeOpts.setCache;
    }
    if (cache.has(key)) return cache.get(key);
    const res = fn(...args);
    cache.set(key, res);
    return res;
  };
  return cached as T;
}

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
  /** checks if a var is a function */
  fnc: <T>(a: T): T extends Fnc ? true : false =>
    (typeof a === "function") as anyOk,
  /** checks if a var is a map */
  map: <T>(a: T): T extends Map<anyOk, anyOk> ? true : false =>
    (a instanceof Map) as anyOk,
  /** checks if null */
  null: (a: unknown): a is null => a === null,
  /** checks if a var is a number */
  num: (a: unknown): a is number => typeof a === "number",
  /** checks if is a Primitive */
  primitive: (a: unknown): a is Primitive =>
    Is.scalar(a) || Is.buffer(a) || Is.fnc(a) || Is.regex(a) || Is.sym(a),
  /** checks if a var can be JSON serialized */
  serializable: <T>(a: T): T extends Serializable ? true : false =>
    Is.arr(a) ||
    Is.bigint(a) ||
    Is.bool(a) ||
    Is.buffer(a) ||
    Is.date(a) ||
    Is.fnc(a) ||
    Is.map(a) ||
    Is.null(a) ||
    Is.num(a) ||
    // Is.regex(a) || // technically serializable, but into a string
    Is.set(a) ||
    Is.str(a) ||
    // Is.sym(a) || // technically serializable, into "Symbol(value)"
    (Is.undef(a) as anyOk), // technically is just omitted
  /** checks if var is a scalar */
  scalar: (a: anyOk): a is Scalar =>
    Is.bigint(a) ||
    Is.bool(a) ||
    Is.date(a) ||
    Is.null(a) ||
    Is.num(a) ||
    Is.str(a) ||
    Is.undef(a),
  /** checks if a var is a RegExp */
  regex: (a: unknown): a is RegExp => a instanceof RegExp,
  /** checks if a var is a set */
  set: <T>(a: T): T extends Set<anyOk> ? true : false =>
    (a instanceof Set) as anyOk,
  /** checks if a var is a string */
  str: (a: unknown): a is string => typeof a === "string",
  /** checks if a var is a symbol */
  sym: (a: unknown): a is symbol => typeof a === "symbol",
  /** checks if a var is undefined */
  undef: (a: unknown): a is undefined => typeof a === "undefined",
};
function foo() {
  // const a = 1;
  // const b = "foo";
  // const c = new Date();
  // const d = new Map();
  // const e = new Set();
  // const f = () => {};
  // const g = /foo/;
  const a = Is.serializable(1);
  const b = Is.serializable("foo");
  const c = Is.serializable(new Date());
  const d = Is.serializable(new Map<string, string>());
  const e = Is.serializable(new Set<string>());
  const f = Is.serializable(() => {});
  const g = Is.serializable(/foo/);
  const h = Is.serializable(null);
  const i = Is.serializable(undefined);
  const j = Is.serializable(logDefault);
}

/** makes a Dict from an array of objects, keyed by `key` */
export const keyBy = <T>(arr: T[], key: string) =>
  arr.reduce((acc, item: anyOk) => {
    acc[item[key]] = item;
    return acc;
  }, {} as HashM<T>);
export const keyByC = cachify(keyBy);

export const md5 = (srcOrSrcs: (string | Buffer) | (string | Buffer)[]) => {
  const hash = cryptoNode.createHash("md5");
  A.from(srcOrSrcs).forEach((b) => {
    hash.update(b);
  });
  return hash.digest("base64url");
};

/** aliases for Object */
export const O = {
  /** An alias for Object.assign */
  ass: <T extends anyOk[]>(...args: T): Combine<T> =>
    Object.assign(...(args as unknown as [anyOk])),
  /** A super basic compare check */
  compare: (o1: anyOk, o2: anyOk) => {
    const { added, removed } = A.compare(O.keys(o1), O.keys(o2));
    const changed = O.ents(o2).reduce((acc, [k, v]) => {
      if (k in o1 && o1[k] !== v) acc.push(k);
      return acc;
    }, [] as string[]);

    return {
      equals:
        added.length + changed.length + removed.length === 0 ? true : false,
      added,
      changed: O.fromEnts(changed.map((c) => [c, [o1[c], o2[c]]])),
      removed,
    };
  },
  /** An alias for Object.entries */
  ents: ((...args: [anyOk]) =>
    Object.entries(...args)) as ObjectConstructor["entries"],
  /** An alias for Object.fromEntries */
  fromEnts: ((...args: [anyOk]) =>
    Object.fromEntries(...args)) as ObjectConstructor["fromEntries"],
  /** An alias for Object.keys */
  keys: (obj: HashM<anyOk>): string[] => Object.keys(obj),
  /** Omit keys from an obj */
  omit: <T extends HashM<anyOk>, K extends keyof T>(
    obj: T,
    keys: readonly K[] | K[]
  ): Omit<T, K> => {
    const res = O.ass({}, obj);
    keys?.forEach((k) => {
      if (k in obj) delete res[k];
    });
    return res;
  },
  /** Deletes the keys of an obj and returns the pre-purged obj  */
  purge: (obj: anyOk, opts: SMM = {}): anyOk => {
    const { excludes, includes } = opts;
    const before = { ...obj };
    for (const k in obj) {
      if (strMatchMany(k, { excludes, includes })) {
        delete obj[k];
      }
    }
    return before;
  },
  /**
   * Renames a key of an obj while preserving its' order
   */
  renameKey: <T extends HashM<anyOk>, O extends keyof T, N extends string>(
    obj: T,
    oldKey: O,
    newKey: N,
    inPlace?: boolean
  ): Omit<T, O> & { [K in N]: T[O] } => {
    const before = { ...obj };
    let after: anyOk = {};
    if (inPlace) {
      after = obj;
      O.purge(obj);
    }
    O.ents(before).forEach(([k, v]) => {
      after[k === oldKey ? newKey : k] = v;
    });
    return after;
  },
  /**
   * RegExp replaces keys of an obj while preserving its' order
   *
   * use renameKey if a simple string bc more typestrict
   */
  replKeys: <T extends HashM<anyOk>>(
    obj: T,
    strReplFrom: RegExp, // use renameKey if a simple string bc more typestrict
    strReplTo: string,
    inPlace?: boolean
  ): Partial<T> => {
    const before = { ...obj };
    let after: anyOk = {};
    if (inPlace) {
      after = obj;
      O.purge(obj);
    }
    O.ents(before).forEach(([k, v]) => {
      after[k.replace(strReplFrom, strReplTo)] = v;
    });
    return after;
  },
  /** sorts an obj by key, returning the sorted copy or sorts in place if inPlace is true */
  sort: <T extends HashM<anyOk>>(obj: T, inPlace?: boolean): T => {
    const sorted = O.keys(obj)
      .toSorted()
      .reduce((result: anyOk, key: string) => {
        result[key] = obj[key];
        return result;
      }, {});
    if (inPlace) {
      O.purge(obj);
      O.ents(sorted).forEach(([k, v]) => {
        (obj as anyOk)[k] = v;
      });
      return obj;
    }
    return sorted;
  },
  /** An alias for Object.values */
  vals: ((...args: [anyOk]) =>
    Object.values(...args)) as ObjectConstructor["values"],
  /** Get the values of a multi-level nested object */
  valsRecursive: <T extends object>(obj: T): ValOfRecursive<T>[] => {
    const ents = O.ents(obj);
    const valsDeep: anyOk[] = [];
    ents.forEach(([k, v]) => {
      if (!Is.serializable(v)) {
        throw stepErr(
          "valsRecursive: non-serializable value",
          "O.valsRecursive",
          { k, v }
        );
      }
      if (Is.primitive(v)) valsDeep.push(v);
      // @ts-expect-error - may be infinite recursion. be careful!
      if (Is.arr(v)) valsDeep.push(...v.map(O.valsRecursive));
      else valsDeep.push(...O.valsRecursive(v));
    });
    return valsDeep.flat();
  },
};

/** alias for Promise */
export const P = O.ass(Promise, {
  wr: Promise.withResolvers,
});

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
      if (v instanceof Map) return O.fromEnts(v.entries());
      if (v instanceof Set) return A.from(v);
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

/** Alias for localCompare, useful for sorting alphabetically */
export const strCompare = (a: string, b: string) => a.localeCompare(b);

export const strCondense = (
  s: string,
  opts: { removeStyle?: boolean } = {}
): string => {
  const { removeStyle = true } = opts;
  s = s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
  if (removeStyle) s = s.replace(strAnsiEscapeExp, "");
  return s;
};

export const strFileEscape = (s: string, replChar = "-") =>
  // TODO: dont replace periods '.'
  s.replace(/[^a-zA-Z0-9]/g, replChar).replace(/_+/g, "_");

/** Options for strMatchMany */
export interface SMM {
  /** Option for strMatchMany to exclude strings or regexs as a string filter */
  excludes?: (string | RegExp)[];
  /** Option for strMatchMany to include strings or regexs as a string filter */
  includes?: [string | RegExp, ...(string | RegExp)[]];
}
/** Match a string against multiple strings and regexs */
export const strMatchMany = (strToTestAgainst: string, opts: SMM) => {
  const { excludes, includes } = opts;

  if (includes && includes.length === 0) {
    throw stepErr(
      Error(`includes is an empty array. This is probably a mistake.`),
      "strMatchMany"
    );
  }

  let includeMatch: RegExp | true | null = null;
  let excludeMatch: RegExp | true | null = null;

  if (includes) {
    const includesRExp: RegExp[] = [];
    includesRExp.push(...includes.filter(Is.regex));
    const strs = includes.filter(Is.str);
    if (strs?.length) {
      includesRExp.push(new RegExp(strs.join("|")));
    }
    for (const i of includesRExp) {
      if (strToTestAgainst.match(i)) {
        includeMatch = i;
        break;
      }
    }
  } else {
    includeMatch = true;
  }

  if (excludes) {
    const excludesRExp: RegExp[] = [];
    excludesRExp.push(...excludes.filter(Is.regex));
    const strs = excludes.filter(Is.str);
    if (strs?.length) {
      excludesRExp.push(new RegExp(strs.join("|")));
    }
    for (const e of excludesRExp) {
      if (strToTestAgainst.match(e)) {
        excludeMatch = e;
        break;
      }
    }
  }

  if (includes?.length && includeMatch && excludeMatch) {
    l1(
      `WARNING: strMatchMany matched both include:${includeMatch} and exclude:${excludeMatch} on string ${strToTestAgainst}`
    );
  }

  return includeMatch && !excludeMatch;
};
/** Filter a string array against strMatchMany */
export const strMatchManyFilter = (strs: string[], opts: SMM): string[] => {
  return strs.filter((s) => strMatchMany(s, opts));
};

export const strTrim = (s: string, len: number) => {
  if (s.length <= len) return s;
  return s.slice(0, len) + "...";
};

export const throttle = <Fn extends FncP>(
  fn: Fn,
  opts: {
    logForWaitFrequencyMs?: number;
    logForWaitUpdates?: LogFn;
    maxConcurrent?: number;
  } = {}
): Fn => {
  const {
    logForWaitFrequencyMs = 10000,
    logForWaitUpdates: log = l2,
    maxConcurrent = osNode.cpus().length,
  } = opts;
  let queueCount = 0;
  const _p: Promise<anyOk>[] = [];
  const throttled = async (...args: anyOk) => {
    queueCount++;
    const i = setInterval(
      () =>
        log(`${queueCount} task(s) waiting for activeCount < maxConcurrent`),
      logForWaitFrequencyMs
    );
    while (_p.length >= maxConcurrent) {
      await P.race(_p);
    }
    queueCount--;
    clearInterval(i);
    const p = fn(...args);
    _p.push(p);
    p.finally(() => _p.splice(_p.indexOf(p), 1));
    return p;
  };
  return throttled as Fn;
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
    opts?: { attrs?: Dict }
  ) => Promise<AbstractCacheStat>;
  get!: (
    key: string,
    opts?: { attrs?: boolean }
  ) => Promise<AbstractCacheStat & { buffer: Buffer }>;
  stat!: (
    key: string,
    opts?: { attrs?: boolean }
  ) => Promise<AbstractCacheStat>;
}
export interface AbstractCacheStat {
  attrs: Dict;
  key: string;
  size: bigint;
  ts: Date;
}
export class LocalCache extends AbstractCache {
  static csumType = "md5";
  public path: string;

  constructor(opts: { path: string }) {
    super();
    this.path = opts.path;
  }
  add = async (key: string, buffer: Buffer, opts: { attrs?: Dict } = {}) => {
    try {
      l5(`LCACHE:put->${key}`);
      const { attrs } = opts;
      await this.init();
      const toPath = this.cPath(key);
      await fs.setBin(toPath, buffer, { xattrs: attrs });
      // get stat without attrs bc we already have attrs to save a fs call
      const stat = await this.stat(key);
      Object.assign(stat, { attrs });
      return stat;
    } catch (e: anyOk) {
      throw stepErr(e, "LCACHE:add", { key });
    }
  };
  get = async (key: string) => {
    try {
      l5(`LCACHE:get->${key}`);
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
      l5("LCACHE:init");
      const stat = await fs.stat(this.path).catch(() => {});
      if (stat) return;
      await fsNode.mkdir(this.path, { recursive: true });
    } catch (e: anyOk) {
      throw stepErr(e, "LCACHE.init");
    }
  });
  purge = async (opts: SMM = {}) => {
    try {
      l3("LCACHE:purge");
      await this.init();
      const { excludes, includes } = opts;
      const count = await fs.purgeDir(this.path, { excludes, includes });
      return count;
    } catch (e: anyOk) {
      throw stepErr(e, "LocalCache:purge");
    }
  };
  stat = async (key: string, opts: { attrs?: boolean } = {}) => {
    l5(`LCACHE:stat->${key}`);
    const { attrs } = opts;
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
    opts: {
      text?: string;
      moveInsteadOfCopy?: boolean;
    } = {}
  ) => {
    try {
      const { text = null, moveInsteadOfCopy = false } = opts;

      await fs.tmpDirCreate();
      const wsRoot = await fs.findNearestWsRoot();

      if (!path.startsWith(wsRoot)) {
        throw stepErr(Error(`path not in workspace`), `wsroot`, {
          backupPath: path,
        });
      }

      let backupPath = "";
      for (let i = 0; i < Infinity; i++) {
        backupPath =
          `${fs.tmpDir}/${strFileEscape(path, ".")}-` +
          String(i).padStart(2, "0");
        if (!(await fs.stat(backupPath).catch(() => {}))) break;
      }

      if (text) {
        await fs.set(backupPath, text, { skipBackup: true });
      } else if (moveInsteadOfCopy) {
        await fs.rename(path, backupPath, { skipBackup: true });
      } else {
        await fs.cp(path, backupPath, { skipBackup: true });
      }
    } catch (e: anyOk) {
      throw stepErr(e, `fs.backup`, { backupPath: path });
    }
  };

  static cp = async (
    from: string,
    to: string,
    opts: {
      skipBackup?: boolean;
    } = {}
  ) => {
    try {
      const toStat = await fs.stat(to).catch(() => {});

      try {
        const { skipBackup = false } = opts;
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

  /** get file list from cache or fs */
  // FIXME: replace usages of sh.find with this
  static find = cachify(
    async (
      /** an abs path to search within */
      pathToFindIn: string,
      opts: SMM & {
        /** if recursing, how deep to go. default=Inf */
        maxDepth?: number;
        /** recurse into directories. default=false */
        recursive?: boolean;
        /** Should the paths returned be relative to pathToLs. default=false; */
        relative?: boolean;
        /** Search files or dirs. default=both */
        typeFilter?: "file" | "dir";
        /** internal use: how deep we are if recursing */
        currentDepth?: number;
      } = {}
    ): Promise<string[]> => {
      try {
        l5(`fs.find:start->${pathToFindIn}`);

        if (pathToFindIn[0] !== "/")
          pathToFindIn = pathNode.resolve(process.cwd(), pathToFindIn);

        const {
          currentDepth = 0,
          excludes = [],
          includes,
          maxDepth = Infinity,
          recursive = false,
          relative = false,
          typeFilter,
        } = opts;

        excludes.push(...[/\.DS_Store/]);

        if (includes?.length) {
          for (const inc of includes) {
            if (Is.str(inc) && inc.startsWith("/"))
              throw Error(`includes must be relative`);
          }
        }

        let paths: string[] = [];
        await fsNode
          .readdir(pathToFindIn, { withFileTypes: true })
          .then(async (rdResults) =>
            P.all(
              rdResults.map(async (rdResult) => {
                const shouldInclude = strMatchMany(rdResult.name, {
                  excludes,
                  includes,
                });
                if (!shouldInclude) return;

                const rdResAbsPath = `${pathToFindIn}/${rdResult.name}`;
                const isDir = rdResult.isDirectory();
                const isFile = rdResult.isFile();

                if (isDir && recursive && currentDepth < maxDepth) {
                  const lsPaths = await fs.find(rdResAbsPath, {
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
          paths = paths.map((p) => fs.pathRel(pathToFindIn, p));
        }
        if (currentDepth === 0) paths.sort();
        return paths;
      } catch (e) {
        throw stepErr(e, `fs.find`, { pathToLs: pathToFindIn });
      }
    }
  );

  /**
   * traverse the directory tree from __dirname to find the nearest package.json
   * with name=root or .bldrrc.mjs. If none found, throw an error.
   */
  static findNearestWsRoot = cachify(async (startFrom = process.cwd()) => {
    l4("FS:findNearestWsRoot->start");
    let root = startFrom;
    while (true) {
      l5(`FS:findNearestWsRoot->${root}`);
      const ws = await fs.getPkgJsonFile(root).catch(() => {});
      if (ws?.json.name === "root") break;
      const configF = await import(`${root}/.bldrrc.mjs`).catch(() => {});
      if (configF?.config) break;
      const next = fs.resolve(root, "..");
      if (next === root) {
        throw stepErr(
          Error(
            "No package.json:name=root or .bldrrc.mjs found in the directory tree"
          ),
          "findNearestWsRoot"
        );
      }
      root = next;
    }
    l4(`FS:findNearestWsRoot->${root}`);
    return root;
  });

  /** get's a file object */
  static get = cachify(
    async (
      path: string,
      opts: {
        xattrs?: boolean;
      } = {}
    ) => {
      try {
        const { xattrs } = opts;
        const text = await fsNode.readFile(path, "utf-8").catch(() => {
          throw stepErr(Error(`fg:file not found`), `readfile`);
        });
        const file = {
          /** resets the file to the original state when first read */
          reset: async () => {
            l5(`FS:get->reset ${path}`);
            await fs.set(path, text).catch((e) => {
              throw stepErr(e, `FS:get.reset`, { rstPath: path });
            });
            l5(`FS:get->reset-success ${path}`);
          },
          save: async () => {
            return fs.set(path, file.text);
          },
          set: (newText: string) => {
            return fs.set(path, newText);
          },
          xattrs: xattrs ? await fs.getXattrs(path) : {},
          text,
        };
        return file;
      } catch (e: anyOk) {
        throw stepErr(e, `fs.get`, { getPath: path });
      }
    }
  );

  /** Gets the contents of a file as a buffer */
  static getBin = async (
    path: string,
    opts: {
      xattrs?: boolean;
    } = {}
  ) => {
    try {
      const { xattrs } = opts;
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
        await file.reset().catch((e) => {
          throw stepErr(e, `fs.getJsonFile.reset`, { resetJsonPath: path });
        });
        jsonF.json = jsonF.jsonOrig;
      },
      /** will save to fs whatever the current values in json are */
      save: async () => {
        await jsonF.setJson(jsonF?.json).catch((e) => {
          throw stepErr(e, `fs.getJsonFile.save`, { saveJsonPath: path });
        });
      },
      /** will set the json and write it to disk */
      setJson: async (json: anyOk) => {
        const text =
          str(json, 2)
            // make empty squigly brackets go to new line like prettier
            .replace(/{},/g, "{\n  },") +
          // add new line at end like prettier
          "\n";
        await file.set(text).catch((e) => {
          throw stepErr(e, `fs.getJsonFile.setJson`, { setJsonPath: path });
        });
      },
    };
    return jsonF;
  };

  /** get package.json file */
  static getPkgJsonFile = async (pathToPkgOrPkgJson: string) => {
    let path = pathToPkgOrPkgJson;
    if (!path.endsWith("package.json")) path = `${path}/package.json`;
    const jsonF = await fs.getJsonFile<PkgJsonFields>(path);
    return {
      ...jsonF,
      /** Disable install and build hooks */
      disableHooks: async () => {
        if (jsonF.json.scripts) {
          O.replKeys(
            jsonF.json.scripts,
            /^(preinstall|postinstall|prebuild|postbuild)/,
            `//$1`,
            true
          );
          await jsonF.save();
        }
      },
      /** re-enable install and build hooks which were disabled */
      enableHooks: async () => {
        if (jsonF.json.scripts) {
          O.replKeys(
            jsonF.json.scripts,
            /^(\/\/)(preinstall|postinstall|prebuild|postbuild)/,
            `$2`,
            true
          );
          await jsonF.save();
        }
      },
    };
  };

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

  static mkdir = async (path: string) => {
    try {
      await fsNode.mkdir(path, { recursive: true });
    } catch (e: anyOk) {
      throw stepErr(e, `fs.mkdir`, { mkdirPath: path });
    }
  };

  /**
   * md5s the recursive contents of files and paths
   * - returns a Dict of paths and their md5s
   * - sorts before returning
   */
  static md5 = async (
    filePathOrPaths: string | [string, ...string[]],
    opts: SMM & {
      /** will add a 'combined' csum to the result */
      combine?: boolean;
      salts?: string[];
    } = {}
  ): Promise<Dict> => {
    try {
      const { combine, excludes, includes } = opts;
      const paths = A.from(filePathOrPaths);
      if (!paths.length) throw stepErr(Error(`No paths`), "args");
      let md5s: Dict = {};
      await P.all(
        paths.map(async (path) => {
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
            const buffer = (await fs.getBin(path)).buffer;
            md5s[path] = md5(buffer);
          } else {
            const pathsRecursive = await fs.find(path, {
              ...opts,
              recursive: true,
              typeFilter: "file",
            });
            await P.all(
              pathsRecursive.map(async (pathR) => {
                const buffer = await fs
                  .getBin(fs.resolve(path, pathR))
                  .then((r) => r.buffer);
                md5s[pathR] = md5(buffer);
              })
            );
          }
        })
      );
      O.sort(md5s, true);
      const res = combine ? { combined: md5(O.vals(md5s)), ...md5s } : md5s;
      return res;
    } catch (e: anyOk) {
      throw stepErr(e, `fs.md5`);
    }
  };

  static mv = async (
    from: string,
    to: string,
    opts: {
      skipBackup?: boolean;
    } = {}
  ) => {
    try {
      const { skipBackup = false } = opts;
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
      throw O.ass(Error(e), { step: `fs.mv:backup->failed` });
    }
    await fsNode.rename(from, to).catch((e) => {
      throw stepErr(Error(`${e.message};\nfrom:${from}\nto:${to}`), `fs.mv`);
    });
  };
  static rename = fs.mv;

  static pathRel = pathNode.relative;

  /** Purges a directory */
  static purgeDir = async (path: string, opts: SMM = {}) => {
    const { excludes, includes } = opts;
    try {
      const todo = await fs
        .find(path, { includes, excludes, recursive: false })
        .catch(() => []);
      if (!todo?.length) return 0;
      await P.all(todo.map((f) => fs.rm(f, { skipBackup: true })));
      return todo.length;
    } catch (e: anyOk) {
      throw stepErr(e, `fs.purgeDir`, { excludes, includes, path });
    }
  };

  static read = fs.get;
  static relative = pathNode.relative;

  static resetChangedFiles = async () => {
    try {
      const lctx = `FS:resetChangedFiles`;
      l4(`${lctx}->start!`);
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
    opts: Parameters<(typeof fsNode)["rm"]>[1] & {
      skipBackup?: boolean;
    } = {}
  ) => {
    const { force, recursive = true, skipBackup = true } = opts;
    if (path.includes("bldr")) console.log(path, opts);
    try {
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
        return fsNode.unlink(path).catch((e) => {
          throw stepErr(e, "unlink: no such file", { rmPath: path });
        });
      } else {
        return fsNode.rm(path, { force, recursive }).catch((e) => {
          throw stepErr(e, "rm: no such file", { rmPath: path });
        });
      }
    } catch (e: anyOk) {
      if (force) {
        l5(`fs.rm->ignoring missing ${path} bc force`);
        return;
      } else {
        throw stepErr(e, "fs.rm", { rmPath: path });
      }
    }
  };

  static set = async (
    toPath: string,
    text: string,
    opts: {
      skipBackup?: boolean;
      xattrs?: Dict;
    } = {}
  ) => {
    const { skipBackup = false, xattrs } = opts;

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
      throw stepErr(e, `fs.set.backup`, { backupPath: toPath });
    }
    try {
      await fsNode.writeFile(toPath, text, "utf8").catch((e) => {
        throw stepErr(Error(e.message), `write`);
      });
      if (xattrs) {
        await fs.setXattrs(toPath, xattrs);
      }
    } catch (e: anyOk) {
      throw stepErr(e, `fs.set`, { setPath: toPath });
    }
  };

  static setBin = async (
    toPath: string,
    bin: Buffer,
    opts: {
      xattrs?: Dict;
    } = {}
  ) => {
    const { xattrs } = opts;
    await fsNode.writeFile(toPath, bin).catch((e) => {
      throw stepErr(Error(`${e.message}; to:${toPath}`), `fs.setBin`);
    });
    if (xattrs) {
      await fs.setXattrs(toPath, xattrs);
    }
  };

  /**
   * sets xattrs (extended attributes) to a file
   *
   * LIMITS
   * - keys and values must be strings
   * - keys must be < 127 bytes
   * - values must be < 4KB on ext4, 128KB on Mac
   * - some key prefixes are reserved for special attrs
   * - size of all xattr combined on a file must be < 4KB on ext4, 128KB on Mac
   */
  static setXattrs = async (toPath: string, xattrs: Dict) => {
    try {
      const ents = O.ents(xattrs);
      if (!ents.length) {
        throw stepErr(Error(`Empty xattrs`), `check`);
      }
      const cmds = ents.map(([k, v]) => {
        if (["", null, undefined].includes(k) || !Is.str(k)) {
          throw stepErr(Error(`Bad key value`), `check-key`, {
            key:
              k === undefined
                ? "undefined"
                : k === null
                ? "null"
                : k === ""
                ? "empty"
                : k,
            val: v,
          });
        }
        if (["", null, undefined].includes(v) || !Is.str(v)) {
          throw stepErr(Error(`Bad value`), `check-val`, {
            key: k,
            val:
              v === undefined
                ? "undefined"
                : v === null
                ? "null"
                : v === ""
                ? "empty"
                : v,
          });
        }
        // Using '--' to avoid issues with keys/values starting with '-'
        return `xattr -w -- "${k}" "${v}" ${toPath}`;
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
    opts: {
      xattrs?: boolean;
    } = {}
  ) => {
    try {
      const { xattrs: incXattrs } = opts;
      const stat = await fsNode.stat(path);
      let xattrs = {};
      if (incXattrs) {
        xattrs = await fs.getXattrs(path);
      }
      O.ass(stat, { xattrs });
      return stat as ReturnTypeP<typeof fsNode.stat> & { xattrs: Dict };
    } catch (e) {
      throw stepErr(Error("fsc:File not found"), "fs.stat", {
        statPath: path,
      });
    }
  };

  static tmpDir =
    `${fs.home}/.bldr/runs/` +
    new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/(-|T|:)/g, ".");
  static tmpDirCreate = cachify(async () => {
    return fs.mkdir(fs.tmpDir).catch((e) => {
      throw stepErr(e, `fs.tmpDirCreate`);
    });
  });
  static tmpDirPurge = async () => {
    l2("purgeTmpDir");
    await fs.rm(fs.tmpDir);
  };
}

/** Shell / Process helpers aka sh */
export class sh {
  static _exec = utilNode.promisify(childProcessNode.exec);

  static cmdExists = async (
    cmd: string,
    opts: {
      /** Working directory. This may be important if you use .tool-versions */
      wd?: string;
    } = {}
  ) => {
    const { wd } = opts;
    const res = !!(await sh
      .exec(`command -v ${cmd}`, { silent: true, wd })
      .catch(() => {}));
    return res;
  };
  static assertCmdExists = cachify(
    async (
      cmd: string,
      opts: {
        /** Working directory. This may be important if you use .tool-versions */
        wd?: string;
      } = {}
    ) => {
      const { wd } = opts;
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
    opts: {
      /** cb for logs on a lineArray.filter */
      logFilter?: (text: string) => boolean;
      prefix?: string;
      printOutput?: boolean;
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
      printOutput,
      rawOutput,
      silent,
      throws = true,
      verbose,
      wd = process.cwd(),
    } = opts;

    let _log1 = l1;
    let _log4 = l4;
    if (verbose) {
      _log1 = _log4 = l1;
    }
    if (silent) {
      _log1 = _log4 = l9;
    }

    let { prefix = `sh:${id}:` } = opts;
    prefix = prefix;

    /** Special handle the logging of the stdout/err */
    /** Track if out was logged bc we need to log it on error if !silent regardless  */
    let outWasLoggedToConsole = false;
    let _logOut = _log4;
    if (rawOutput) {
      _logOut = l0;
      outWasLoggedToConsole = true;
    } else if (silent) {
      _logOut = l9;
    } else if (verbose || printOutput) {
      _logOut = l1;
      outWasLoggedToConsole = true;
    } else {
      _logOut = l4;
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
    l9(`${prefix}:${id} cmdFull='${cmd}'`);
    _log4(`${prefix} cwd=${wd}`);

    const cmdFinal = opts.wd ? `cd ${wd} && ${cmd} 2>&1` : cmd;
    const execP = P.wr<string>();
    const cp = childProcessNode.spawn(cmdFinal, { shell: true });
    cp.stdout.on("data", (data) => logOut(data.toString()));
    cp.stderr.on("data", (data) => logOut(data.toString()));
    cp.on("close", (code) => {
      if (!allout) {
        allout = "(empty stdout/stderr)";
        logOut(allout);
      }
      if (code) {
        if (!outWasLoggedToConsole && !silent) {
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
      execP.resolve(allout.slice(0, -1)); // chop the last \n
    });
    return execP.promise;
  };
  static execCount = 0;

  static sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
}

export class Log {
  static black = (text: string) => `\x1b[30m${text}\x1b[0m`;
  static blue = (text: string) => `\x1b[34m${text}\x1b[0m`;
  static brightCyan = (text: string) => `\x1b[96m${text}\x1b[0m`;
  static brightYellow = (text: string) => `\x1b[93m${text}\x1b[0m`;
  static cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;
  static gray = (text: string) => `\x1b[90m${text}\x1b[0m`;
  static green = (text: string) => `\x1b[32m${text}\x1b[0m`;
  static magenta = (text: string) => `\x1b[35m${text}\x1b[0m`;
  static red = (text: string) => `\x1b[31m${text}\x1b[0m`;
  static white = (text: string) => `\x1b[37m${text}\x1b[0m`;
  static yellow = (text: string) => `\x1b[33m${text}\x1b[0m`;

  static appendLogFilePromises: Promise<void>[] = [];
  static file = `${fs.tmpDir}/run.log`;

  public color = Log.gray;
  public logLevel = UTIL_ENV.logLevel;
  public prefix: string;
  public showLogLevels: boolean;
  public showTimestamps: boolean;

  constructor(opts: { prefix: string }) {
    const { prefix } = opts;
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
          if (args[0].match(/INFO/)) args[0] = Log.cyan(args[0]);
          else if (args[0].match(/ERROR/)) args[0] = Log.red(args[0]);
          else {
            for (let i = 0; i < args.length; i++) {
              if (Is.str(args[i])) {
                args[i] = this.color(args[i]);
              }
            }
          }
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
          const hasObjs = args.some((a: anyOk[]) => !Is.scalar(a));
          if (hasObjs)
            lines.push(...args.map((a: anyOk) => (Is.scalar(a) ? a : str(a))));
          else lines[0] += ` ${args.join(" ")}`;
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
    this.l1(e);
    this.l1(`:ERROR: ${e.message}`);
    this.l1(
      `:ERROR:CTX->${str(
        {
          step: `${e?.step ?? "unknown"}`,
          ...O.omit(e, ["message", "originalColumn", "originalLine", "stack"]),
        },
        2
      ).replace(/"/g, "")}`
    );
  };

  lFinish = async (opts: { err?: anyOk } = {}) => {
    const { err } = opts;
    if (err) this.lErrCtx(err);
    this.l2(`LOG->${Log.file}`);
    await Log.waitForlogFileSettled();
  };

  static waitForlogFileSettled = async () => {
    await pAll(Log.appendLogFilePromises);
  };
}
export const logDefault = new Log({ prefix: "" });
export type LogFn = typeof logDefault.l0;
export const l0 = logDefault.l0;
export const l1 = logDefault.l1;
export const l2 = logDefault.l2;
export const l3 = logDefault.l3;
export const l4 = logDefault.l4;
export const l5 = logDefault.l5;
export const l9 = logDefault.l9;
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

export class Tree {
  /**
   * Produces a visual representation of a tree structure.
   *
   * ex.
   *
   * const tree: TreeNode = {
   *   name: "A",
   *   children: [
   *     { name: "B", children: [{ name: "H" }, { name: "I" }] },
   *     { name: "C", children: [{ name: "J" }, { name: "K" }] },
   *     { name: "D", children: [{ name: "L" }, { name: "M" }] },
   *   ],
   * };
   *
   * treeVizCreate(tree) =>
   * A
   * ├──B
   * |  ├──H
   * |  └──I
   * ├──C
   * |  ├──J
   * |  └──K
   * └──D
   *    ├──L
   *    └──M
   */
  static viz(
    node: TreeNode,
    opts: {
      /** Specify a different key for children. default=children */
      childrenKey?: string;
      /** Specify a different key for name. default=name */
      nameKey?: string;
      /** internal use */
      level?: number;
      /** internal use */
      prefix?: string;
      /** internal use */
      isLast?: boolean;
    } = {}
  ): string {
    const {
      childrenKey = "children",
      nameKey = "name",
      level = 0,
      prefix = "",
      isLast = true,
    } = opts;

    const children = node[childrenKey as "children"] ?? [];
    const name = node[nameKey as "name"];

    const connector = isLast ? "└─" : "├─";

    let textSelf = "";
    textSelf = prefix + connector + name;
    textSelf = textSelf.slice(2); // this slices the indentation of the first obj

    let text = textSelf;

    if (level === 0 && !children.length) {
      children.push({ [nameKey as "name"]: "none" });
    }

    const childPrefix = prefix + (isLast ? "   " : "|  ");
    children.forEach((child, index, array) => {
      text +=
        "\n" +
        Tree.viz(child, {
          childrenKey,
          nameKey,
          level: level + 1,
          prefix: childPrefix,
          isLast: index === array.length - 1,
        });
    });

    return text;
  }
}
type TreeNode = {
  name: string;
  children?: TreeNode[];
};

export class Yarn {
  /** A file to be used as a lock/mutex to prevent mult yarn install or cache clears from running concurrently */
  static mutex = "/tmp/yarn-mutex";
  /** Kind of like yarn cache clean, but much faster */
  static cachePurge = async (opts: {
    /** what pkgNames to include. No glob support */
    pkgNames?: [string, ...string[]];
  }) => {
    const { pkgNames } = opts;
    try {
      l4("cleanYarnCache->start");

      const wsRoot = await fs.findNearestWsRoot();

      if (!pkgNames?.length) {
        await sh.exec(`yarn cache clean --mutex file:${Yarn.mutex}`, {
          wd: wsRoot,
        });
      } else {
        for (const inc of pkgNames) {
          if (inc.includes("*")) {
            throw stepErr(Error(`Glob not supported`), "cleanYarnCache", {
              inc,
            });
          }
          await sh.exec(`yarn cache clean ${inc}`, { wd: wsRoot });
          await sh.exec(
            `find $(yarn cache dir)/.tmp -name package.json -exec grep -sl ${inc} {} \\; ` +
              `| xargs dirname | xargs rm -rf`,
            {
              wd: wsRoot,
            }
          );
        }
      }

      // Below is an appoach to bypass the yarn cache clean command, but seems to have issues
      // with yarn.locks for ext packages. So, we're sticking with the yarn cache clean command.
      // It's faster though, so we may revisit later.
      // const cachePath = `${fs.home}/Library/Caches/Yarn/v6`;
      // 1. purge the tmp dir
      // don't just purge the whole dir -- that can cause issues
      // await fs.rm(`${cachePath}/.tmp`, { force: true, skipBackup: true });
      // 2. long-term cache and filter by domains and pkgNames
      // await fs.purgeDir(cachePath, { excludes, includes });

      l4("cleanYarnCache->end");
    } catch (e: anyOk) {
      throw stepErr(e, "cleanYarnCache", { includes: pkgNames });
    }
  };
}

/** Mainly used for testing */
if (import.meta.url === `file://${process.argv[1]}`) {
  // console.log(process.argv);
  // d@ts-expect-error - gets confused args
  // await main(...process.argv.slice(2));
  // await fs.ls(process.argv[2], { recursive: true });
}