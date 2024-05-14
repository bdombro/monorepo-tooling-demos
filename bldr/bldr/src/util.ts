#!/usr/bin/env bun

import childProcessN from "node:child_process";
import cryptoN from "node:crypto";
import fsN from "node:fs";
import osN from "node:os";
import pathN from "node:path";
import streamN from "node:stream";
import urlN from "node:url";
import utilN from "node:util";
import zlibN from "node:zlib";

import equals from "fast-deep-equal";
import { mergeAndConcat } from "merge-anything";

export const UTIL_ENV = {
  ci: process.env["CI"] === "1" ? true : false,
  logLevel: Number(process.env["LOG"] ?? 2),
};

/** Aliases and misc */

/** Array aliases */
export const A = {
  /** shallow compare */
  compare: <A, B>(
    /** from array */
    a: A[],
    /** to array */
    b: B[],
  ) => {
    const added = b.filter((v: anyOk) => !a.includes(v));
    const modified: A[] = [];
    const removed = a.filter((v: anyOk) => !b.includes(v));
    const unchanged: A[] = [];
    for (const ao of a) {
      for (const bo of b) {
        if (equals(ao, bo)) unchanged.push(ao);
        else modified.push(ao);
      }
    }
    return { added, removed, modified, unchanged };
  },
  /** Depups an array in place */
  dedup: <T>(arr: T[]) => {
    const deduped = A.toDedup(arr);
    arr.length = 0;
    arr.push(...deduped);
    return arr;
  },
  /** true if empty */
  empty: (arr: anyOk[]) => arr.length === 0,
  /** filter in place */
  filter: <T>(arr: T[], cb: (v: T, i: number, arr: T[]) => boolean): T[] => {
    const filtered = arr.filter(cb);
    arr.length = 0;
    arr.push(...filtered);
    return arr;
  },
  from: Array.from,
  /** Note: Don't use sortAlpha, USE just .sort() instead -- sorts an array in place alphabetically */
  // sortAlpha: <T extends string[]>(arr: T): T => arr.sort(strCompare),
  /** applies a callback on an array */
  mapInPlace: <T>(arr: T[], cb: (v: T, i: number, arr: T[]) => T): T[] => {
    for (let i = 0; i < arr.length; i++) {
      arr[i] = cb(arr[i], i, arr);
    }
    return arr;
  },
  /** Depups an array */
  toDedup: <T>(arr: T[]): T[] => [...new Set(arr)],
  equals: <T>(a: T[], b: T[]) => a.length === b.length && a.every((v, i) => v === b[i]),
};

type Cachified<T extends Fnc> = (
  ...args: [...Parameters<T>, opts?: { bustCache?: boolean; setCache?: ReturnType<T> | ReturnTypeP<T> }]
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
export function cachify<T extends Fnc>(
  fn: T,
  /** give this cached fnc a name for debugging/tracking usage. Don't commit though bc it's noisy. */
  name?: string,
): Cachified<T> {
  const cache: Map<anyOk, anyOk> = new Map();
  const cached = (...args: anyOk[]) => {
    const maybeOpts = args.at(-1);
    if (maybeOpts?.bustCache) {
      cache.clear();
      args.pop();
    }
    const key = JSON.stringify(args?.length ? args : "none");
    if (name) {
      ldbg(
        `cachify: ${name} ` +
          strCondenseObj({
            args,
            cacheSize: cache.size,
          }),
      );
    }
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

export const gzip = utilN.promisify(zlibN.gzip);
export const gzipSync = zlibN.gzipSync;
export const gunzip = utilN.promisify(zlibN.gunzip);
export const gunzipSync = zlibN.gunzipSync;

/**
 * methods to check if a var is a type
 *
 * tips: returning 'a is T' is a type guard that helps with type inference.
 * ex
 * if (Is.str(a)) {
 *  a // ts knows 'a' is a string
 * }
 */
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
  /** checks if a var is defined and not null */
  def: <T>(a: T): a is NonNullable<T> => a !== undefined && a !== null,
  /** checks if a var is a function */
  fnc: <T>(a: T): T extends Fnc ? true : false => (typeof a === "function") as anyOk,
  /** checks if a var is a map */
  map: <T>(a: T): T extends Map<anyOk, anyOk> ? true : false => (a instanceof Map) as anyOk,
  /** checks if null */
  null: (a: unknown): a is null => a === null,
  /** checks if a var is a number */
  num: (a: unknown): a is number => typeof a === "number",
  /** checks if is a Primitive */
  primitive: (a: unknown): a is Primitive => Is.scalar(a) || Is.buffer(a) || Is.fnc(a) || Is.regex(a) || Is.sym(a),
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
    (Is.und(a) as anyOk), // technically is just omitted
  /** checks if var is a scalar */
  scalar: (a: anyOk): a is Scalar =>
    Is.bigint(a) || Is.bool(a) || Is.date(a) || Is.null(a) || Is.num(a) || Is.str(a) || Is.und(a),
  /** checks if a var is a RegExp */
  regex: (a: unknown): a is RegExp => a instanceof RegExp,
  /** checks if a var is a set */
  set: <T>(a: T): T extends Set<anyOk> ? true : false => (a instanceof Set) as anyOk,
  /** checks if a var is a string */
  str: (a: unknown): a is string => typeof a === "string",
  /** checks if a var is a symbol */
  sym: (a: unknown): a is symbol => typeof a === "symbol",
  /** checks if a var is undefined */
  und: (a: unknown): a is undefined => typeof a === "undefined",
};

/** makes a Dict from an array of objects, keyed by `key` */
export const keyBy = <T>(arr: T[], key: string) =>
  arr.reduce((acc, item: anyOk) => {
    acc[item[key]] = item;
    return acc;
  }, {} as HashM<T>);

export const md5 = (
  srcOrSrcs: (string | Buffer) | (string | Buffer)[],
  opts: {
    /** prefix a step on error. Is convenient to avoid wrapping in try/catch just to add a step. */
    errStep?: string;
  } = {},
) => {
  const { errStep } = opts;
  const srcs = Is.arr(srcOrSrcs) ? srcOrSrcs : [srcOrSrcs];
  try {
    const hash = cryptoN.createHash("md5");
    for (const src of srcs) {
      try {
        hash.update(src);
      } catch (e: anyOk) {
        throw stepErr(e, "update", { md5Src: src });
      }
    }
    try {
      const res = hash.digest("base64url");
      return res;
    } catch (e) {
      throw stepErr(e, "digest");
    }
  } catch (e: anyOk) {
    throw stepErr(e, `${errStep ? `${errStep}:` : ""}md5`, { md5Srcs: srcs });
  }
};

/** aliases for Object */
export const O = {
  /** An alias for Object.assign */
  ass: <T extends anyOk[]>(...args: T): Combine<T> => Object.assign(...(args as unknown as [anyOk])),
  /** A super basic compare check */
  cmp: <O1 extends Record<anyOk, anyOk>, O2 extends Record<anyOk, anyOk>>(o1: O1, o2: O2) => {
    const added: (keyof O2)[] = [];
    const modified: (keyof O1)[] = [];
    const removed: (keyof O1)[] = [];
    const unchanged: (keyof O1)[] = [];

    // loop through k,v of o1
    for (const k in o1) {
      if (k in o2) {
        if (equals(o1[k], o2[k])) unchanged.push(k);
        else modified.push(k);
      } else removed.push(k);
    }
    added.push(...O.keys(o2).filter((k) => !(modified.includes(k) || removed.includes(k) || unchanged.includes(k))));

    return {
      equals: added.length + modified.length + removed.length === 0 ? true : false,
      added,
      /** all files that were added, modified, or removed */
      changed: [...added, ...modified, ...removed],
      modified,
      removed,
    };
  },
  cp: <T>(o: T): T => structuredClone(o),
  /** Deeply check if objs are equal */
  eq: equals,
  /** An alias for Object.entries */
  ents: ((...args: [anyOk]) => Object.entries(...args)) as ObjectConstructor["entries"],
  /** An alias for Object.fromEntries */
  empty: (obj: anyOk) => O.keys(obj).length === 0,
  fromEnts: ((...args: [anyOk]) => Object.fromEntries(...args)) as ObjectConstructor["fromEntries"],
  /** An alias to O.keys(o).length */
  len: (o: anyOk) => O.keys(o).length,
  /** An alias for Object.keys with better types */
  keys: <T extends HashM<anyOk>>(obj: T): (keyof T)[] => Object.keys(obj) as anyOk,
  /** Deeply merge objects */
  merge: mergeAndConcat,
  /** Shallow merge objects */
  mergeShallow: <T1, T2>(o1: T1, o2: T2): T1 & T2 => {
    const res = O.ass({}, o1, o2);
    return res;
  },
  /** Create a copy that excludes the keys specified */
  omit: <T extends HashM<anyOk>, K extends keyof T>(obj: T, omitKeys: K[]): ReadonlyNot<Omit<T, K>> => {
    const res = O.ass({}, obj);
    omitKeys.forEach((omk) => {
      if (omk in obj) delete res[omk];
    });
    return res;
  },
  /** Create a copy that includes only the keys specified */
  pick: <T extends HashM<anyOk>, K extends keyof T>(obj: T, keyOrKeys: K | K[]): ReadonlyNot<Pick<T, K>> => {
    const keys = Is.arr(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    const res = { ...obj };
    O.keys(obj).forEach((ok) => {
      if (!keys.includes(ok as anyOk)) delete res[ok];
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
    inPlace?: boolean,
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
    obj: HashM<anyOk>,
    strReplFrom: RegExp, // use renameKey if a simple string bc more typestrict
    strReplTo: string,
    inPlace?: boolean,
  ): T => {
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
      .sort()
      .reduce((result: anyOk, key) => {
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
  vals: ((...args: [anyOk]) => Object.values(...args)) as ObjectConstructor["values"],
  /** Get the values of a multi-level nested object */
  valsRecursive: <T extends object>(obj: T): ValOfRecursive<T>[] => {
    const ents = O.ents(obj);
    const valsDeep: anyOk[] = [];
    ents.forEach(([k, v]) => {
      if (!Is.serializable(v)) {
        throw stepErr("valsRecursive: non-serializable value", "O.valsRecursive", { k, v });
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
  /**
   * similar to Promise.all, but also flushes the list, which is convenient if
   * using re-useable promise arrays.
   */
  allF: (async (
    // @ts-expect-error - it's fine
    ps,
  ) => {
    // splice bc it gets cranky otherwise
    return Promise.all(ps.splice(0, ps.length));
  }) as PromiseConstructor["all"],
  // wr: Promise.withResolvers,
  /** a polyfill for Promise.withResolvers bc Node 18 doesn't have it yet. */
  wr: <ReturnT>() => {
    let resolve: (value: ReturnT | PromiseLike<ReturnT>) => void;
    let reject: (reason: anyOk) => void;
    const promise = new Promise<ReturnT>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // @ts-expect-error: complains vars aren't not resolved yet
    return { promise, resolve, reject };
  },
});

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

export const str = (o: anyOk, spaces?: number, opts: { printUndefineds?: boolean } = {}): string => {
  const { printUndefineds } = opts;
  return JSON.stringify(
    o,
    (k, v) => {
      if (v instanceof Error) return { ...v, stack: v.stack };
      if (v instanceof Map) return O.fromEnts(v.entries());
      if (v instanceof Set) return A.from(v);
      if (printUndefineds && v === undefined) return "undefined";
      return v;
    },
    spaces ? 2 : 0,
  );
};

/** Alias for localCompare, useful for sorting alphabetically */
export const strCompare = (a: string, b: string) => a.localeCompare(b);

/** a condensing stringify fnc for an object */
export const strCondenseObj = (o: anyOk): string => {
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

/** a condensing fnc for a blob of text with multiple new lines. Trims whitespace, new lines, ansi escapes */
export const strCondenseText = (s: string, opts: { removeStyle?: boolean } = {}): string => {
  const { removeStyle = true } = opts;
  s = s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
  if (removeStyle) s = s.replace(strAnsiEscapeExp, "");
  return s;
};

/** strips ansi escape sequences from a string -- useful for converting console log strs to clean strings */
export const strNoAnsiEscapes = (s: string) => s.replace(strAnsiEscapeExp, "");
/** alias for strNoAnsiEscapes */
export const strNoColors = strNoAnsiEscapes;

export const strFileEscape = (s: string, replChar = "-") => s.replace(/[^.a-zA-Z0-9]/g, replChar).replace(/_+/g, "_");

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
    throw stepErr(Error(`includes is an empty array. This is probably a mistake.`), "strMatchMany");
  }

  let includeMatch: RegExp | true | null = null;
  let excludeMatch: RegExp | true | null = null;

  if (includes) {
    const includesRExp: RegExp[] = [];
    includesRExp.push(...includes.filter(Is.regex));
    const strs = includes.filter(Is.str).map(strRegExpEscape);
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
    const strs = excludes.filter(Is.str).map(strRegExpEscape);
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
      `WARNING: strMatchMany matched both include:${includeMatch} and exclude:${excludeMatch} on string ${strToTestAgainst}`,
    );
  }

  return includeMatch && !excludeMatch;
};
/** Filter a string array against strMatchMany */
export const strMatchManyFilter = (strs: string[], opts: SMM): string[] => {
  return strs.filter((s) => strMatchMany(s, opts));
};

export const strRegExpEscape = (s: string) => s.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");

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
  } = {},
): Fn => {
  const { logForWaitFrequencyMs = 10000, logForWaitUpdates: log = l2, maxConcurrent = osN.cpus().length } = opts;
  let queueCount = 0;
  const _p: Promise<anyOk>[] = [];
  const throttled = async (...args: anyOk) => {
    queueCount++;
    const i = setInterval(
      () => log(`${queueCount} task(s) waiting for activeCount < maxConcurrent`),
      logForWaitFrequencyMs,
    );
    while (_p.length >= maxConcurrent) {
      await P.race(_p);
    }
    queueCount--;
    clearInterval(i);
    const p = fn(...args);
    _p.push(p);
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
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

export class AbstractCache<ATTRS extends HashM<anyOk>> {
  static csumType: string;
  add!: (key: string, buffer: Buffer, opts?: { attrs?: ATTRS }) => Promise<AbstractCacheStat<ATTRS>>;
  get!: (key: string, opts?: { attrs?: boolean }) => Promise<AbstractCacheStat<ATTRS> & { buffer: Buffer }>;
  stat!: (key: string, opts?: { attrs?: boolean }) => Promise<AbstractCacheStat<ATTRS>>;
}
export interface AbstractCacheStat<ATTRS> {
  attrs: ATTRS;
  key: string;
  size: bigint;
  ts: Date;
}
export class LocalCache<ATTRS extends HashM<anyOk>> extends AbstractCache<ATTRS> {
  static csumType = "md5";

  constructor(public cacheDir: string) {
    super();
    fsN.mkdirSync(cacheDir, { recursive: true });
  }
  add = async (key: string, buffer: Buffer, opts: { attrs?: ATTRS } = {}) => {
    try {
      l5(`LCACHE:put->${key}`);
      const { attrs } = opts;
      const cacheFile = this.getFile(key);
      await cacheFile.set({ buffer, gattrs: attrs });
      const stat = await this.stat(key);
      return stat;
    } catch (e: anyOk) {
      throw stepErr(e, "LCACHE:add", { key });
    }
  };

  find = async (opts: SMM = {}) => {
    try {
      l3("LCACHE:find");
      const { excludes, includes } = opts;
      return fs.find(this.cacheDir, { excludes, includes });
    } catch (e: anyOk) {
      throw stepErr(e, "LCACHE:find");
    }
  };

  get = async (key: string) => {
    try {
      l5(`LCACHE:get->${key}`);
      const cacheFile = this.getFile(key);
      const [buffer, stat] = await P.all([cacheFile.bufferP(), this.stat(key)]);
      return {
        ...stat,
        buffer,
      };
    } catch (e: anyOk) {
      throw stepErr(e, "LCACHE.get", { key });
    }
  };

  private getFile(key: string) {
    return fs.get<anyOk, ATTRS>(`${this.cacheDir}/${key}`);
  }

  purge = async (opts: SMM = {}) => {
    try {
      l3("LCACHE:purge");
      const { excludes, includes } = opts;
      const files = (await fs.find(this.cacheDir, { excludes, includes })).map((f) => File.get<never, never>(f));
      const count = await P.all(files.map((f) => f.delP()));
      return count;
    } catch (e: anyOk) {
      throw stepErr(e, "LocalCache:purge");
    }
  };

  stat = async (key: string) => {
    try {
      l5(`LCACHE:stat->${key}`);
      const file = this.getFile(key);
      const stat = await file.statP().catch(() => {
        throw stepErr(Error(`key not found: ${key}`), "LCACHE:stat");
      });
      return {
        attrs: await file.gattrsP(),
        key,
        size: BigInt(stat.size),
        ts: new Date(stat.mtime),
      };
    } catch (e: anyOk) {
      throw stepErr(e, "LCACHE:stat", { key });
    }
  };
}

/**
 * An OOP style file interface class
 *
 * - provides lazy getters for buffer, json, text, ghost attrs, xattrs with caches
 * - provides async methods to get, reset, save, set
 * - tip: DO store file instances in a central cache or suffer perf hits, memory leaks, and data loss. For
 *   convenience, use File.get(path) to get a file instance which is cached.
 * - tip: if performance is a concern, consider promise methods for async operations unless you're confident
 *   that you already pumped caches. File.read is handy for pumping caches.
 */
interface FileOpts<JSON, GATTRS> {
  jsonDefault?: JSON;
  gattrsDefault?: GATTRS;
}
export type FileI<JSON, GATTRS> = File<JSON, GATTRS>;
class File<
  /** Type of json */
  JSON,
  /** Type of ghost attrs */
  GATTRS,
> {
  constructor(path: string, opts: FileOpts<JSON, GATTRS> = {}) {
    this._path = path;
    if (opts.jsonDefault) this.jsonDefault = opts.jsonDefault;
    if (opts.gattrsDefault) this.gattrsDefault = opts.gattrsDefault;
  }

  /** Returns a File instance from cache or new */
  static get = <JSON, GATTRS>(path: string, opts?: FileOpts<JSON, GATTRS>) => {
    let file = File._getCache.get(path);
    if (!file) {
      file = new File(path, opts);
      File._getCache.set(path, file);
    }
    return file as File<JSON, GATTRS>;
  };
  private static _getCache = new Map<string, File<anyOk, anyOk>>();

  /** get package.json file */
  static getPkgJsonFile = (pathToPkgOrPkgJson: string) => {
    let path = pathToPkgOrPkgJson;
    if (!path.endsWith("package.json")) path = `${path}/package.json`;
    const jsonF = fs.get<PkgJsonFields, never>(path);
    const pkgF = O.ass(jsonF, {
      /** Disable install and build hooks */
      disableHooks: () => {
        if (jsonF.json.scripts) {
          const next = { ...jsonF.json };
          O.replKeys<PkgJsonFields>(next.scripts!, /^(preinstall|postinstall|prebuild|postbuild)/, `//$1`, true);
          jsonF.json = next;
        }
        return jsonF;
      },
      /** re-enable install and build hooks which were disabled */
      enableHooks: () => {
        if (jsonF.json.scripts) {
          const next = { ...jsonF.json };
          O.replKeys(next.scripts!, /^(\/\/)(preinstall|postinstall|prebuild|postbuild)/, `$2`, true);
          jsonF.json = next;
        }
        return jsonF;
      },
    });
    return pkgF;
  };

  get basename() {
    return pathN.basename(this.path);
  }

  /** Gets a buffer from cache or reads synchronously */
  get buffer(): Buffer {
    try {
      if (this._bufferVal) return this._bufferVal;
      this._bufferVal = fsN.readFileSync(this.path);
    } catch (e: anyOk) {
      if (this.jsonDefault) this._bufferVal = Buffer.from(str(this.jsonDefault));
      else throw stepErr(e, `F:buffer`, { bufferPath: this.path });
    }
    return this._bufferVal;
  }
  /** Gets buffer from cache or reads with a promise  */
  bufferP = async () => {
    try {
      if (this._bufferVal) return this._bufferVal;
      try {
        this._bufferVal = await fsN.promises.readFile(this.path);
      } catch (e: anyOk) {
        if (this.jsonDefault) this._bufferVal = Buffer.from(str(this.jsonDefault));
        else throw e;
      }
      return this._bufferVal;
    } catch (e: anyOk) {
      throw stepErr(e, `F:bufferP`, { bufferPath: this.path });
    }
  };
  set buffer(buffer: Buffer) {
    this._bufferVal = buffer;
    this.bufferDirty = true;
  }
  /** A setter that returns this, for chaining */
  bufferSet(buffer: Buffer) {
    this.buffer = buffer;
    return this;
  }
  private bufferDirty = false;
  private _bufferVal?: Buffer;

  cacheClear = () => {
    this.bufferDirty = this.textDirty = false;
    delete this._bufferVal;
    delete this._existsVal;
    delete this._jsonOrig;
    delete this._jsonVal;
    delete this._md5Val;
    delete this._statVal;
    delete this._textVal;
    return this;
  };

  del = () => {
    fs.rmSync(this.path, { force: true });
    if (!this.path.includes(File._gattrsDir)) this.gattrsF.del();
    this.cacheClear();
  };
  delP = async () => {
    await fs.rm(this.path, { force: true });
    if (!this.path.includes(File._gattrsDir)) await this.gattrsF.delP();
    this.cacheClear();
  };

  get dirname() {
    return pathN.dirname(this.path);
  }

  get exists() {
    if (this._existsVal === undefined) {
      this._existsVal = fs.existsS(this.path);
    }
    return this._existsVal;
  }
  existsP = async () => {
    if (this._existsVal === undefined) {
      this._existsVal = await fs.existsP(this.path);
    }
    return this._existsVal;
  };
  private existsAssert = () => {
    if (!this.exists) {
      throw stepErr(Error(`File does not exist: ${this.path}`), "F:exists", {
        filePath: this.path,
      });
    }
  };
  private existsAssertP = async () => {
    await this.existsP();
    this.existsAssert();
  };
  private _existsVal?: boolean;

  /**
   * Ghost attributes are a way to store metadata about a file in a hidden ghost file
   *
   * The path of the ghost file is the same as the file it is associated with,
   * but in {pkg}/node_modules/.cache/.bldr/ghosts/ instead of the original path.
   * Therefore, if you move the file without moving the ghost file, the ghost file
   * will not be findable automatically.
   *
   * This is kinda like a low-tech LevelDB for files.
   */
  get gattrs(): GATTRS {
    try {
      l4(`F:gattrs->${this.path}`);
      // This shouldn't happen normally, but delete orphaned ghost files
      if (!this.exists && this.gattrsF.exists) this.gattrsF.del();
      return this.gattrsF.json;
    } catch (e: anyOk) {
      throw stepErr(e, "F:gattrs", {
        filePath: this.path,
        gattrsPath: this._gattrsPath,
      });
    }
  }
  gattrsP = async (): Promise<GATTRS> => {
    // This shouldn't happen normally, but delete orphaned ghost files
    if (!(await this.existsP()) && (await this.gattrsF.existsP())) await this.gattrsF.delP();
    await this.gattrsF.jsonP().catch(() => {});
    return this.gattrs;
  };
  set gattrs(to: GATTRS) {
    if (this.path.includes(File._gattrsDir)) {
      throw stepErr(Error(`Cannot set gattrs on a gattrs file`), "F:gattrs", { gattrsPath: this.path });
    }
    this.gattrsF.json = to;
  }
  /** A setter that returns this */
  gattrsSet = (to: GATTRS) => {
    this.gattrs = to;
    return this;
  };
  static gattrsPurge = async (opts: SMM = {}) => {
    await fs.purgeDir(File._gattrsDir, opts);
  };
  get gattrsF() {
    if (this._gattrsFVal) return this._gattrsFVal;
    this._gattrsFVal = new File<GATTRS, anyOk>(this._gattrsPath, { jsonDefault: this.gattrsDefault });
    return this._gattrsFVal;
  }
  private gattrsDefault?: GATTRS;
  private _gattrsFVal?: File<GATTRS, anyOk>;
  static get _gattrsDir() {
    return `${fs.home}/.bldr/gattrs`;
  }
  private get _gattrsPath() {
    return File._gattrsDir + "/" + strFileEscape(this.path.replace(fs.home, "").slice(1), ".") + ".json";
  }

  //
  //
  // The JSON attrs are unfortunetely complicated, because we support partial updates
  // and lazy loading/setting.
  //
  //

  /** gets json from cache or reads it synchronously */
  get json(): JSON {
    if (!this._jsonVal) {
      try {
        this._jsonVal = JSON.parse(this.text);
        if (Is.und(this._jsonOrig)) {
          this._jsonOrig = O.cp(this._jsonVal);
        }
      } catch (e: anyOk) {
        throw stepErr(e, "F:json", { jsonPath: this.path });
      }
    }

    if (this._pjsonVal) {
      O.ass(this._jsonVal, this._pjsonVal);
      delete this._pjsonVal;
    }
    if (this._pdjsonVal) {
      this._jsonVal = O.merge(this._jsonVal, this._pdjsonVal) as JSON;
      delete this._pdjsonVal;
    }

    return this._jsonVal!;
  }
  jsonP = async () => {
    if (!this._jsonVal) await this.textP();
    return this.json;
  };
  /** sets the value of the json obj to be stored on the file */
  set json(to: JSON) {
    this._jsonVal = to;
  }
  /** A setter that returns this */
  jsonSet(to: JSON) {
    this.json = to;
    return this;
  }
  /** set json, but shallow merges into the existing json */
  pjson(to: Partial<JSON>) {
    if (!this._pjsonVal) this._pjsonVal = {};
    O.ass(this._pjsonVal, to);
    return this;
  }
  private _pjsonVal?: Partial<JSON>;
  /** set json, but deep merges into the existing json */
  pdjson(to: PartialR<JSON>) {
    if (!this._pdjsonVal) this._pdjsonVal = {};
    this._pdjsonVal = O.merge(this._pdjsonVal, to) as PartialR<JSON>;
    return this;
  }
  private _pdjsonVal?: PartialR<JSON>;
  get jsonDirty() {
    return this._pjsonVal || this._pdjsonVal || !O.eq(this._jsonOrig, this._jsonVal);
  }
  static jsonStr(json: anyOk) {
    // Format it like Prettier does
    return str(json, 2).replace(/{}/g, "{\n  }") + "\n";
  }
  private jsonDefault?: JSON;
  private _jsonVal?: JSON;
  private _jsonOrig?: JSON;

  get md5() {
    return this._md5Val || (this._md5Val = md5(this.buffer));
  }
  md5P = async () => {
    await this.bufferP();
    return this.md5;
  };
  private _md5Val?: string;

  /** path: the path of the file. Using getter to block setting */
  get path(): string {
    return this._path;
  }
  private _path;

  /** Moves the file */
  mv = async (to: string) => {
    const from = this.path;
    try {
      l5(`F:mv->${from} -> ${to}`);
      if (from === to) return this;
      if (!from) throw stepErr(Error(`From path cannot be empty`), "F:mv", { from });
      if (!to) throw stepErr(Error(`To path cannot be empty`), "F:mv", { to });
      if (!(await fsN.promises.exists(from))) {
        throw stepErr(Error(`From path does not exist: ${from}`), "F:mv", {
          from,
        });
      }
      if (await fsN.promises.exists(to)) {
        await fsN.promises.rm(to);
      }
      await fsN.promises.mkdir(pathN.dirname(to), { recursive: true });
      await fsN.promises.rename(this.path, to);

      if (this._gattrsFVal) {
        await this._gattrsFVal.mv(`${this._gattrsPath}/${this.path}`);
      }

      this._path = to;
      this._existsVal = true;
      return this;
    } catch (e: anyOk) {
      throw stepErr(e, "F:mv", { from, to });
    }
  };

  /** Read all file data from disk. Is nice if you want to pump caches and chaining */
  read = async () => {
    l4(`F:read->${this.path}`);
    await this.existsAssertP();
    const _p: Promise<anyOk>[] = [];
    _p.push(this.bufferP());
    _p.push(this.statP());
    if (this.gattrsF.exists) _p.push(this.gattrsP());
    await P.all(_p);
    return this;
  };

  save = async () => {
    try {
      l4(`F:save->${this.path}`);

      let buffer: Buffer | undefined = undefined;
      if (this.bufferDirty) buffer = this.buffer;
      if (this.textDirty) buffer = Buffer.from(this.text);
      // Us the promise to get jsonP bc jsonDirty can be true even without having ever read buffer
      // if (this.path.includes(File._gattrsDir) && this.jsonDirty) debugger;
      if (this.jsonDirty) buffer = Buffer.from(File.jsonStr(await this.jsonP()));

      if (!buffer && !(await this.existsP())) {
        throw stepErr(Error(`No buffer to save from`), "buffer-get");
      }

      if (buffer) {
        await fs.mkdir(pathN.dirname(this.path));
        await fs.set(this.path, buffer);
      }

      if (this.gattrsF.jsonDirty) await this.gattrsF.save();
      await this.saveXattrs();

      this.cacheClear();
      this._bufferVal = buffer;
      this._existsVal = true;

      l4(`F:save->${this.path}->done`);

      return this;
    } catch (e) {
      throw stepErr(e, "F:save", { savePath: this.path });
    }
  };

  /** A convenience method to set buffer and attrs and save in a single call */
  set = async (
    opts: {
      buffer?: Buffer;
      gattrs?: GATTRS;
      json?: JSON;
      pdjson?: PartialR<JSON>;
      pjson?: Partial<JSON>;
      text?: string;
      xattrs?: Dict;
    } = {},
  ) => {
    try {
      const { buffer, gattrs, json, pdjson, pjson, text, xattrs } = opts;
      if (buffer) this.buffer = buffer;
      if (text) this.text = text;
      if (json) this.json = json;
      if (pdjson) this.pdjson(pdjson);
      if (pjson) this.pjson(pjson);
      if (xattrs) this.xattrs = xattrs;
      if (gattrs) this.gattrs = gattrs;
      await this.save();
      return this;
    } catch (e) {
      throw stepErr(e, "F:set", { setPath: this.path });
    }
  };

  snapshot = async (name: string) => {
    try {
      const snaps: SnapshotFile = await this.snapshotF.jsonP();
      const buffer = await this.bufferP();
      const gz = await gzip(buffer);
      const gzbase64 = gz.toString("base64");
      const snap: Snapshot = {
        name,
        ts: Date.now(),
        gzbase64,
      };
      snaps[name] = snap;
      return this.snapshotF.set({ json: snaps });
    } catch (e) {
      throw stepErr(e, "F:snapshot", { filePath: this.path, snapName: name, snapPath: this._snapshotPath });
    }
  };
  snapshotGet = async (
    name: string,
  ): Promise<{
    get buffer(): Buffer;
    get text(): string;
    get json(): anyOk;
  }> => {
    try {
      const snaps = await this.snapshotF.jsonP();
      const snap = snaps[name];
      if (!snap) {
        throw stepErr(Error(`Snapshot not found`), "read");
      }
      const gz = Buffer.from(snap.gzbase64, "base64");
      const buffer = await gunzip(gz);
      const res = {
        get buffer() {
          return buffer;
        },
        get text() {
          try {
            return buffer.toString("utf-8");
          } catch (e) {
            throw stepErr(e, "F.snapshotGet.text");
          }
        },
        get json() {
          try {
            return JSON.parse(res.text);
          } catch (e) {
            throw stepErr(e, "F.snapshotGet.json");
          }
        },
      };
      return res;
    } catch (e: anyOk) {
      throw stepErr(e, "F:snapshotGet", {
        filePath: this.path,
        snapName: name,
        snapPath: this._snapshotPath,
      });
    }
  };
  snapshotRestore = async (name: string) => {
    try {
      const snap = await this.snapshotGet(name);
      return this.set({ buffer: snap.buffer });
    } catch (e: anyOk) {
      throw stepErr(e, "F:snapshotRestore");
    }
  };
  static snapshotPurge = async (opts: SMM = {}) => {
    await fs.purgeDir(File._snapshotDir, opts).catch((e) => {
      throw stepErr(e, "F:snapshotPurge");
    });
  };
  get snapshotF() {
    if (this._snapshotFVal) return this._snapshotFVal;
    this._snapshotFVal = new File<SnapshotFile, anyOk>(this._snapshotPath, { jsonDefault: {} });
    return this._snapshotFVal;
  }
  private _snapshotFVal?: File<SnapshotFile, anyOk>;
  static get _snapshotDir() {
    return `${fs.home}/.bldr/snapshots`;
  }
  private get _snapshotPath() {
    return File._snapshotDir + "/" + strFileEscape(this.path.replace(fs.home, "").slice(1), ".") + ".backups.json";
  }

  get size() {
    return this.stat.size;
  }
  sizeP() {
    return this.statP().then((s) => s.size);
  }

  private _statVal?: fsN.Stats;
  get stat() {
    if (this._statVal) return this._statVal;
    l4(`F:stat->${this.path}`);
    this.existsAssert();
    this._statVal = fsN.statSync(this.path);
    return this._statVal;
  }
  statP = async () => {
    if (this._statVal) return this._statVal;
    l4(`F:statP->${this.path}`);
    await this.existsAssertP();
    this._statVal = await fsN.promises.stat(this.path);
    return this._statVal;
  };

  get stream() {
    let stream: streamN.Readable;
    if (this._bufferVal) {
      stream = streamN.Readable.from(this._bufferVal);
    } else {
      stream = fsN.createReadStream(this.path);
    }
    return stream;
  }

  /** gets text from buffer (or cache if buffer is cached) */
  get text() {
    return this._textVal || (this._textVal = this.buffer.toString("utf-8"));
  }
  /** get text from buffer (or cache if buffer is cached) using a promise */
  textP = async () => {
    await this.bufferP();
    return this.text;
  };
  set text(to: string) {
    this._textVal = to;
    this.textDirty = true;
  }
  /** A setter that returns this, for chaining */
  textSet(to: string) {
    this.text = to;
    return this;
  }
  private textDirty = false;
  private _textVal?: string;

  /**
   * gets/sets xattrs (extended attributes) to a file
   *
   * LIMITS
   * - keys and values must be strings
   * - keys must be < 127 bytes
   * - values must be < 4KB on ext4, 128KB on Mac
   * - some key prefixes are reserved for special attrs
   * - size of all xattr combined on a file must be < 4KB on ext4, 128KB on Mac
   */
  get xattrs() {
    if (!this._xattrs) {
      try {
        const xattrsRaw = sh.execSync(`xattr -l ${this.path}`);
        this._xattrs = xattrsRaw
          .toString()
          .split("\n")
          .reduce<Dict>((acc, line) => {
            const [name, value] = line.split(":");
            if (name && value) {
              acc[name.trim()] = value.trim();
            }
            return acc;
          }, {});

        O.sort(this._xattrs, true);
      } catch (e) {
        throw stepErr(Error("fsgx: file not found"), `fs.getXattrs`, {
          getXattrsPath: this.path,
        });
      }
    }
    if (!this._xattrsOrig) this._xattrsOrig = this._xattrs;
    return this._xattrs;
  }
  set xattrs(xattrs: Dict) {
    this._xattrs = xattrs;
    if (!this._xattrsOrig) this._xattrsOrig = this._xattrs;
  }
  /** A setter that returns this, for chaining */
  setXattrs = async (xattrs: Dict) => {
    this.xattrs = xattrs;
    return this;
  };
  private _xattrs?: Dict;
  private _xattrsOrig?: Dict;
  private saveXattrs = async () => {
    if (!this._xattrs) return;
    if (equals(this._xattrs, this._xattrsOrig)) return;
    try {
      const ents = O.ents(this._xattrs);
      if (!ents.length) {
        throw stepErr(Error(`Empty xattrs`), `saveXattrs`);
      }
      const cmds = ents.map(([k, v]) => {
        if (["", null, undefined].includes(k) || !Is.str(k)) {
          throw stepErr(Error(`Bad key value`), `check-key`, {
            key: k === undefined ? "undefined" : k === null ? "null" : k === "" ? "empty" : k,
            val: v,
          });
        }
        if (["", null, undefined].includes(v) || !Is.str(v)) {
          throw stepErr(Error(`Bad value`), `check-val`, {
            key: k,
            val: v === undefined ? "undefined" : v === null ? "null" : v === "" ? "empty" : v,
          });
        }
        // Using '--' to avoid issues with keys/values starting with '-'
        return `xattr -w -- "${k}" "${v}" ${this.path}`;
      });
      await sh.exec(cmds.join("; "));
      delete this._statVal;
    } catch (e) {
      throw stepErr(e, `f.setXattrs`, {
        setXattrsPath: this.path,
        xattrs: this.xattrs,
      });
    }
  };
}
interface SnapshotFile {
  [name: string]: Snapshot;
}
interface Snapshot {
  name: string;
  ts: number;
  gzbase64: string;
}

/** Filesystem (aka fs) - helpers */
export class fs {
  static append = async (path: string, data: string) => {
    try {
      await fsN.promises.appendFile(path, data);
    } catch (e) {
      throw stepErr(e, "fs.append", { appendPath: path });
    }
  };

  static basename = pathN.basename;

  static cp = async (from: string, to: string) => {
    try {
      const toStat = await fs.stat(to).catch(() => {});
      if (toStat?.isDirectory()) {
        to = `${to}/${fs.basename(from)}`;
      }

      await fsN.promises.copyFile(from, to).catch((e) => {
        throw stepErr(e, "copyFile");
      });
    } catch (e: anyOk) {
      throw stepErr(e, `fs.copyFile`, { from, to });
    }
  };

  static createdFiles: string[] = [];

  static dirname = pathN.dirname;

  static dirtyFiles: HashM<{
    orig: string;
    path: string;
  }> = {};

  static existsS = (path: string) => {
    try {
      fsN.statSync(path);
      return true;
    } catch (e) {
      return false;
    }
  };
  static existsP = async (path: string) => {
    try {
      await fsN.promises.stat(path);
      return true;
    } catch (e) {
      return false;
    }
  };

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
      } = {},
    ): Promise<string[]> => {
      try {
        l5(`fs.find:start->${pathToFindIn}`);

        if (pathToFindIn[0] !== "/") pathToFindIn = pathN.resolve(process.cwd(), pathToFindIn);

        const {
          currentDepth = 0,
          excludes = [],
          includes,
          maxDepth = Infinity,
          recursive = false,
          relative = false,
          typeFilter,
        } = opts;

        if (!excludes.includes(".DS_Store")) excludes.push(".DS_Store");

        if (includes?.length) {
          for (const inc of includes) {
            if (Is.str(inc) && inc.startsWith("/")) throw Error(`includes must not be abs str paths`);
          }
        }

        let paths: string[] = [];
        await fsN.promises
          .readdir(pathToFindIn, { withFileTypes: true })
          .then(async (rdResults) =>
            P.all(
              rdResults.map(async (rdResult) => {
                const rdResAbsPath = `${pathToFindIn}/${rdResult.name}`;

                const shouldInclude = strMatchMany(rdResAbsPath, {
                  excludes,
                  includes,
                });
                if (!shouldInclude) return;

                const isDir = rdResult.isDirectory();
                const isFile = rdResult.isFile();

                if (isDir && recursive && currentDepth < maxDepth) {
                  const lsPaths = await fs.find(rdResAbsPath, {
                    currentDepth: currentDepth + 1,
                    excludes,
                    includes,
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
              }),
            ),
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
    },
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
      const ws = await fs
        .getPkgJsonFile(root)
        .jsonP()
        .catch(() => {});
      if (ws?.name === "root") break;
      const configF = await import(`${root}/.bldrrc.mjs`).catch(() => {});
      if (configF?.default) break;
      const next = fs.resolve(root, "..");
      if (next === root) {
        throw stepErr(
          Error("No package.json:name=root or .bldrrc.mjs found in the directory tree"),
          "findNearestWsRoot",
        );
      }
      root = next;
    }
    l4(`FS:findNearestWsRoot->${root}`);
    return root;
  });

  static fileURLToPath = urlN.fileURLToPath;

  /** get's a file object */
  static get = File.get;
  static getPkgJsonFile = File.getPkgJsonFile;

  static home = osN.homedir();

  static mkdir = async (path: string) => {
    try {
      await fsN.promises.mkdir(path, { recursive: true });
    } catch (e: anyOk) {
      throw stepErr(e, `fs.mkdir`, { mkdirPath: path });
    }
  };
  static mkdirS = (path: string) => {
    try {
      fsN.mkdirSync(path, { recursive: true });
    } catch (e: anyOk) {
      throw stepErr(e, `fs.mkdirS`, { mkdirPath: path });
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
    } = {},
  ): Promise<Dict> => {
    try {
      const { combine, excludes, includes } = opts;
      const paths = Is.arr(filePathOrPaths) ? filePathOrPaths : [filePathOrPaths];
      if (!paths.length) throw stepErr(Error(`No paths`), "args");
      const md5s: Dict = {};
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
            const buffer = (await fs.get(path)).buffer;
            md5s[path] = md5(buffer);
          } else {
            const pathsRecursive = await fs.find(path, {
              ...opts,
              recursive: true,
              typeFilter: "file",
            });
            await P.all(
              pathsRecursive.map(async (pathR) => {
                const pathAbs = await fs.resolve(path, pathR);
                const buffer = await fsN.promises.readFile(pathAbs);
                md5s[pathR] = md5(buffer);
              }),
            );
          }
        }),
      );
      O.sort(md5s, true);
      const res = combine ? { combined: md5(O.vals(md5s)), ...md5s } : md5s;
      return res;
    } catch (e: anyOk) {
      throw stepErr(e, `fs.md5`);
    }
  };

  static mv = async (from: string, to: string) => {
    await fsN.promises.rename(from, to).catch((e) => {
      throw stepErr(Error(`${e.message};\nfrom:${from}\nto:${to}`), `fs.mv`);
    });
  };
  static rename = fs.mv;

  static pathRel = pathN.relative;

  /** Purges a directory */
  static purgeDir = async (path: string, opts: SMM = {}) => {
    const { excludes, includes } = opts;
    try {
      const todo = await fs.find(path, { includes, excludes, recursive: false }).catch(() => []);
      if (!todo?.length) return 0;
      await P.all(todo.map((f) => fs.rm(f)));
      return todo.length;
    } catch (e: anyOk) {
      throw stepErr(e, `fs.purgeDir`, { excludes, includes, path });
    }
  };

  static read = fs.get;
  static relative = pathN.relative;

  static resolve = pathN.resolve;

  /** wrapper for fs.rm and unlink with defaults and exception handling */
  static rm = async (path: string, opts: Parameters<(typeof fsN.promises)["rm"]>[1] = {}) => {
    const { force, recursive = true } = opts;
    try {
      const stat = await fs.stat(path);
      const isFile = stat.isFile();
      if (isFile) {
        await fsN.promises.unlink(path);
      } else {
        await fsN.promises.rm(path, { force, recursive });
      }
    } catch (e: anyOk) {
      if (force) {
        l5(`fs.rm->ignoring missing ${path} bc force`);
      } else {
        throw stepErr(e, "fs.rm", { rmPath: path });
      }
    }
  };

  /** wrapper for fs.rm and unlink with defaults and exception handling */
  static rmSync = (path: string, opts: Parameters<(typeof fsN.promises)["rm"]>[1] = {}) => {
    const { force, recursive = true } = opts;
    try {
      const stat = fs.statSync(path);
      const isFile = stat.isFile();
      if (isFile) {
        fsN.unlinkSync(path);
      } else {
        fsN.rmSync(path, { force, recursive });
      }
    } catch (e: anyOk) {
      if (force) {
        l5(`fs.rm->ignoring missing ${path} bc force`);
      } else {
        throw stepErr(e, "fs.rm", { rmPath: path });
      }
    }
  };

  /** fs.stat wrapper with better exception handling */
  static stat = async (path: string) => {
    try {
      return fsN.promises.stat(path);
    } catch (e) {
      throw stepErr(Error("fsc:File not found"), "fs.stat", {
        statPath: path,
      });
    }
  };

  /** fs.statSync wrapper with better exception handling */
  static statSync = (path: string) => {
    try {
      return fsN.statSync(path);
    } catch (e) {
      throw stepErr(Error("fsc:File not found"), "fs.stat", {
        statPath: path,
      });
    }
  };

  static set = async (path: string, data: string | Buffer) => {
    try {
      await fsN.promises.writeFile(path, data, Is.str(data) ? "utf8" : undefined);
    } catch (e) {
      throw stepErr(e, "fs.set", { setPath: path });
    }
  };

  static get tmpDir() {
    const d =
      `${fs.home}/.bldr/runs/` +
      new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/(-|T|:)/g, ".");
    if (!fs._tmpDirCreated) {
      fsN.mkdirSync(d, { recursive: true });
    }
    return d;
  }
  private static _tmpDirCreated = false;
  static tmpDirPurge = async () => {
    l2("purgeTmpDir");
    await fs.rm(fs.tmpDir);
  };
}

/** Shell / Process helpers aka sh */
export class sh {
  static cmdExists = async (
    cmd: string,
    opts: {
      /** Working directory. This may be important if you use .tool-versions */
      wd?: string;
    } = {},
  ) => {
    const { wd } = opts;
    const res = !!(await sh.exec(`command -v ${cmd}`, { silent: true, wd }).catch(() => {}));
    return res;
  };
  static assertCmdExists = cachify(
    async (
      cmd: string,
      opts: {
        /** Working directory. This may be important if you use .tool-versions */
        wd?: string;
      } = {},
    ) => {
      const { wd } = opts;
      const res = await sh.exec(`command -v ${cmd}`, { silent: true, wd }).catch(() => {
        throw stepErr(Error(`Command not found: ${cmd}`), `sh.assertCmdExists`);
      });
      return res;
    },
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
    } = {},
  ): Promise<string> => {
    const id = (sh.execCount = (sh.execCount ?? 0) + 1);
    const { logFilter = () => true, printOutput, rawOutput, silent, throws = true, verbose, wd = process.cwd() } = opts;

    let _log3 = l3;
    let _log4 = l4;
    if (verbose) {
      _log3 = _log4 = l2;
    }
    if (silent) {
      _log3 = _log4 = l9;
    }

    const { prefix = `sh:${id}:` } = opts;

    /** Special handle the logging of the stdout/err */
    /** Track if out was logged bc we need to log it on error if !silent regardless  */
    let outWasLoggedToConsole = false;
    let _logOut = _log4;
    if (rawOutput) {
      _logOut = l0;
      outWasLoggedToConsole = true;
    } else if (silent) {
      _logOut = l9;
    } else if (verbose) {
      _logOut = l2;
      outWasLoggedToConsole = true;
    } else if (printOutput) {
      _logOut = l2;
      outWasLoggedToConsole = true;
    } else {
      _logOut = l3;
      outWasLoggedToConsole = logDefault.logLevel >= 3;
    }
    let allout = "";
    const logOut = (text: string) => {
      if (rawOutput) {
        _logOut(text);
        return;
      }

      const lines = text
        .split("\n")
        .map((l) => {
          l = l.trim().replace(strAnsiEscapeExp, "").replace(process.cwd(), "wd:");
          return l;
        })
        .filter(Boolean);
      if (lines.length) {
        allout += lines.join("\n") + "\n";
        // FIXME: Running with nodejs shows raw output to console for some reason
        const filtered = lines
          .filter(logFilter)
          .map((l) => l.trim())
          .filter(Boolean);
        if (filtered.length) {
          _logOut(filtered.map((l) => `${prefix} ${l}`).join("\n"));
        }
      }
    };

    _log4(`${prefix} cmd='${strTrim(cmd, 300)}'`);
    l9(`${prefix}:${id} cmdFull='${cmd}'`);
    _log4(`${prefix} cwd=${wd}`);

    const cmdFinal = opts.wd ? `cd ${wd} && ${cmd} 2>&1` : cmd;
    const execP = P.wr<string>();
    const cp = childProcessN.spawn(cmdFinal, { shell: true });
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
              .join("\n") + "\n",
          );
        }
        _log3(`${prefix} ERROR!`);
        _log3(`${prefix} cmd='${strTrim(cmd, 200)}'`);
        _log3(`${prefix} wd=${wd}`);
        _log3(`${prefix} code=${code}`);

        const err = O.ass(Error(`sh:${id}->nonzero-return`), {
          cmd: strTrim(cmd, 200),
          execId: id,
          step: "exec",
          workingDir: wd,
          ...(silent ? { allout } : {}),
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
  static execN = utilN.promisify(childProcessN.exec);
  static execSync = childProcessN.execFileSync;

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

  public colorDefault = Log.gray;
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
   * creates a log function with level = n
   *
   * - logs to console and lazily to a file
   * - provides a finish method to wait for logs to finish and print the log file path
   * - has options to control the look and feel
   * - has static vars for colors to for console
   *
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
        void fs.append(Log.file, args.join(" ") + "\n");
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
      const tsNoYear = ts.slice(11);

      const txt = Log.stringify(...args);

      const logFileTxt = `${tsNoYear} L${n} ${strNoColors(txt)}\n`;
      Log.appendLogFilePromises.push(fs.append(Log.file, logFileTxt)); // be lazy about it

      // skip logging to console if the log message level is higher than the log level
      if (this.logLevel >= n) {
        let conTxt = txt;

        if (this.showLogLevels) {
          conTxt = `L${n} ${conTxt}`;
        }
        if (this.showTimestamps) {
          conTxt = `${tsNoYear} ${conTxt}`;
        }

        if ((n === 1 && this.logLevel > 1) || txt.includes("INFO")) conTxt = Log.cyan(conTxt);
        else if (conTxt.includes("ERROR")) conTxt = Log.red(conTxt);
        else conTxt = this.colorDefault(conTxt);

        console.log(conTxt);
      }

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
  /** Prints in color for easy finding in debugging  */
  lerr = (err: anyOk) => {
    if (Is.str(err)) {
      return this.l1(Log.red(err));
    }
    console.log(err);

    const logTxt = `ERROR-CTX->${str(
      {
        message: err.message,
        breadcrumbs: `${err?.step ?? "unknown"}`,
        ...O.omit(err, ["message", "originalColumn", "originalLine", "step"]),
        stack: err.stack,
      },
      2,
      { printUndefineds: true },
    )}
      `;
    logDefault.l1(Log.red(logTxt));
  };
  /** Prints in color for easy finding in debugging  */
  lwarn = (...args: anyOk) => {
    const txt = Log.stringify(...args);
    return this.logn(1)(Log.yellow(txt));
  };
  /** Prints in color for easy finding in debugging  */
  ldbg = (...args: anyOk) => {
    const txt = Log.stringify(...args);
    return this.logn(1)(Log.magenta(txt));
  };

  lFinish = async (opts: { err?: anyOk } = {}) => {
    await Log.waitForlogFileSettled();
    const { err } = opts;
    if (err) this.lerr(err);
  };

  /** converts arbitrary args to a string */
  static stringify = (...args: anyOk[]) => {
    let txt = "";
    const hasObjs = args.some((a: anyOk[]) => !Is.scalar(a));
    if (hasObjs) {
      const lines = [];
      lines.push(...args.map((a: anyOk) => (Is.scalar(a) ? a : str(a))));
      txt = " " + lines.join(" ") + "\n";
    } else {
      txt += args.join(" ");
    }
    return txt;
  };

  static waitForlogFileSettled = async () => {
    await P.allF(Log.appendLogFilePromises);
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
export const ldbg = logDefault.ldbg;
export const lerr = logDefault.lerr;
export const lwarn = logDefault.lwarn;
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

  static iso = () => new Date().toISOString();
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
    } = {},
  ): string {
    const { childrenKey = "children", nameKey = "name", level = 0, prefix = "", isLast = true } = opts;

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
        for (const pkgName of pkgNames) {
          if (pkgName.includes("*")) {
            throw stepErr(Error(`Glob not supported`), "cleanYarnCache", {
              inc: pkgName,
            });
          }
          let tries = 0;
          const ycc = () =>
            sh.exec(`yarn cache clean ${pkgName}`, { prefix: "YARN", silent: true, wd: wsRoot }).catch(async (err) => {
              // handle error: An unexpected error occurred: "There should only be one folder in a package cache (got
              // in /Users/brian.dombrowski/Library/Caches/Yarn/v6/npm-@opendoor-eslint-plugin-0.0.0-local-482c49296f\
              //3a7e192ee780c76cfe4edf5c4c1cfc-3bad1dcac8b4c893e5960f8a7bb52a2e67bf4d44-integrity/node_modules/@opendoor)".
              // This doesn't seem to happen often and I'm not sure why it happens. But rm the dir seems to resolve.
              const onlyOneFolderPath = err?.allout.match(
                new RegExp(`There should only be one folder in a package cache \\(got  in (.*)/node_modules`),
              );

              // handle error: error An unexpected error occurred: \"ENOENT: no such file or directory, scandir \
              // '/Users/brian.dombrowski/Library/Caches/Yarn/v6/npm-@opendoor-eslint-plugin-0.0.1-\
              //  3140853c1c8e1a4a4d4e735dcca624fecf41024f/node_modules'\".
              // This doesn't seem to happen often and I'm not sure why it happens. But rm the dir seems to resolve.
              const nodeModulesMissingPath = err?.allout.match(
                new RegExp(`ENOENT: no such file or directory, scandir '(.*)/node_modules`),
              );

              const corruptFolderPath = onlyOneFolderPath?.[1] ?? nodeModulesMissingPath?.[1];

              if (corruptFolderPath && tries < 3) {
                tries++;
                lwarn(
                  `cleanYarnCache->detected and correcting yarn cache clean (${onlyOneFolderPath ? "oof" : "nmm"})`,
                );
                lwarn(`cleanYarnCache->corruptFolderPath: ${corruptFolderPath}`);
                await fs.rm(corruptFolderPath, { force: true, recursive: true });
                await ycc();
              } else {
                throw err;
              }
            });
          await ycc();

          const cacheDir = `${fs.home}/Library/Caches/Yarn/v6`;
          const pkgJsonsPaths = await fs.find(`${cacheDir}/.tmp`, { includes: ["package.json"], recursive: true });
          const pkgFs = await P.all(pkgJsonsPaths.map(async (p) => fs.getPkgJsonFile(p).read()));
          const pkgsToRm = pkgFs.filter((p) => p.json.name === pkgName);
          await P.all(pkgsToRm.map((p) => p.del()));
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
