#!/usr/bin/env bun

import childProcessN from "node:child_process";
import cryptoN from "node:crypto";
import fsN from "node:fs";
import osN from "node:os";
import pathN from "node:path";
import { Readable } from "node:stream";
import urlNode from "node:url";
import utilNode from "node:util";
import equals from "fast-deep-equal";
import { merge } from "merge-anything";

export const UTIL_ENV = {
  ci: process.env["CI"] === "1" ? true : false,
  logLevel: Number(process.env["LOG"] ?? 1),
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
    const changed: A[] = [];
    const removed = a.filter((v: anyOk) => !b.includes(v));
    const unchanged: A[] = [];
    for (const ao of a) {
      for (const bo of b) {
        if (equals(ao, bo)) unchanged.push(ao);
        else changed.push(ao);
      }
    }
    return { added, removed, changed, unchanged };
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
  from: Array.from,
  /** Note: USE just .sort() instead -- sorts an array in place alphabetically */
  // sortAlpha: <T extends string[]>(arr: T): T => arr.sort(strCompare),
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
    (Is.undef(a) as anyOk), // technically is just omitted
  /** checks if var is a scalar */
  scalar: (a: anyOk): a is Scalar =>
    Is.bigint(a) || Is.bool(a) || Is.date(a) || Is.null(a) || Is.num(a) || Is.str(a) || Is.undef(a),
  /** checks if a var is a RegExp */
  regex: (a: unknown): a is RegExp => a instanceof RegExp,
  /** checks if a var is a set */
  set: <T>(a: T): T extends Set<anyOk> ? true : false => (a instanceof Set) as anyOk,
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
  compare: <O1 extends Record<anyOk, anyOk>, O2 extends Record<anyOk, anyOk>>(o1: O1, o2: O2) => {
    const added: (keyof O2)[] = [];
    const changed: (keyof O1)[] = [];
    const removed: (keyof O1)[] = [];
    const unchanged: (keyof O1)[] = [];

    // loop through k,v of o1
    for (const k in o1) {
      if (k in o2) {
        if (equals(o1[k], o2[k])) unchanged.push(k);
        else changed.push(k);
      } else removed.push(k);
    }
    added.push(...O.keys(o2).filter((k) => !(changed.includes(k) || removed.includes(k) || unchanged.includes(k))));

    return {
      equals: added.length + changed.length + removed.length === 0 ? true : false,
      added,
      changed,
      removed,
    };
  },
  cp: <T>(o: T): ReadonlyNot<T> => structuredClone(o),
  /** An alias for Object.entries */
  ents: ((...args: [anyOk]) => Object.entries(...args)) as ObjectConstructor["entries"],
  /** An alias for Object.fromEntries */
  fromEnts: ((...args: [anyOk]) => Object.fromEntries(...args)) as ObjectConstructor["fromEntries"],
  /** An alias for Object.keys with better types */
  keys: <T extends HashM<anyOk>>(obj: T): (keyof T)[] => Object.keys(obj) as anyOk,
  merge,
  /** Create a copy that excludes the keys specified */
  omit: <T extends HashM<anyOk>, K extends keyof T>(obj: T, omitKeys: K[]): Omit<T, K> => {
    const res = O.ass({}, obj);
    omitKeys?.forEach((omk) => {
      if (omk in obj) delete res[omk];
    });
    return res;
  },
  /** Create a copy that includes only the keys specified */
  pick: <T extends HashM<anyOk>, K extends keyof T>(obj: T, keyOrKeys: K | K[]): Pick<T, K> => {
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
      .toSorted()
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
  wr: Promise.withResolvers,
});

/**
 * similar to Promise.all, but also flushes the list, which is convenient if
 * using re-useable promise arrays.
 */
export const pAll: typeof Promise.all = async (
  // @ts-expect-error - it's fine
  ps,
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

export const strCondense = (s: string, opts: { removeStyle?: boolean } = {}): string => {
  const { removeStyle = true } = opts;
  s = s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
  if (removeStyle) s = s.replace(strAnsiEscapeExp, "");
  return s;
};

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
      `WARNING: strMatchMany matched both include:${includeMatch} and exclude:${excludeMatch} on string ${strToTestAgainst}`,
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
      const files = (await fs.find(this.cacheDir, { excludes, includes })).map(fs.get);
      const count = await P.all(files.map((f) => f.del()));
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
 * - tip: if performance is a concern, consider promise methods for async operations unless you're confident
 *   that you already pumped caches. File.read is handy for pumping caches.
 */
class File<
  /** Type of json */
  JSON,
  /** Type of ghost attrs */
  GATTRS,
> {
  constructor(path: string) {
    this._path = path;
  }

  append(buffer: Buffer | string) {
    this.buffer = Buffer.concat([this.buffer, Is.buffer(buffer) ? buffer : Buffer.from(buffer)]);
    return this;
  }
  appendP = async (buffer: string | Buffer) => {
    await this.bufferP();
    this.append(buffer);
    return this;
  };

  get basename() {
    return pathN.basename(this.path);
  }

  // Call this if the buffer, or file was moved
  cacheReset = () => {
    delete this.bufferLast;
    delete this.jsonLast;
    delete this.md5Last;
    delete this.gattrsLast;
  };

  /** Gets a buffer from cache or reads synchronously */
  get buffer(): Buffer {
    try {
      if (!this.bufferLast) {
        this.cacheReset();
        try {
          this.bufferLast = fsN.readFileSync(this.path);
        } catch (e) {
          this.bufferLast = Buffer.from("", "utf-8");
          this.bufferDirty = true;
        }
      }
      return this.bufferLast;
    } catch (e: anyOk) {
      throw stepErr(e, `F:buffer`, { bufferPath: this.path });
    }
  }
  /** Gets buffer from cache or reads with a promise  */
  bufferP = async () => {
    try {
      if (!this.bufferLast) {
        if (this.exists) {
          this.bufferLast = await fsN.promises.readFile(this.path);
        } else {
          this.bufferLast = Buffer.from("", "utf-8");
          this.bufferDirty = true;
        }
      }
      return this.bufferLast;
    } catch (e: anyOk) {
      throw stepErr(e, `F:bufferP`, { bufferPath: this.path });
    }
  };
  set buffer(buffer: Buffer | string) {
    this.cacheReset();
    this.bufferLast = Is.buffer(buffer) ? buffer : Buffer.from(buffer);
    this.bufferDirty = true;
  }
  /** Set var, -- but returns this -- for chaining */
  bufferSet(buffer: Buffer | string) {
    this.buffer = buffer;
    return this;
  }
  private bufferDirty = false;
  private bufferLast?: Buffer;

  del = async (skipgGattrsDel?: boolean) => {
    await fs.rm(this.path, { force: true });
    if (!skipgGattrsDel) await this.gattrsF.del(true);
    this.cacheReset();
    delete this.existsLast;
    delete this.statLast;
  };

  get dirname() {
    return pathN.dirname(this.path);
  }

  get exists() {
    if (this.existsLast === undefined) {
      this.existsLast = fsN.existsSync(this.path);
    }
    return this.existsLast;
  }
  existsP = async () => {
    if (this.existsLast === undefined) {
      this.existsLast = await fsN.promises.exists(this.path);
    }
    return this.existsLast;
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
  private existsLast?: boolean;

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
  get gattrs(): Readonly<GATTRS> {
    if (this.gattrsLast) return this.gattrsLast;
    if (!this.exists) {
      this.gattrsF.del().catch(() => {});
      throw stepErr(Error(`Trying to get gattrs on file which d.n.e.`), "F:gattrs", {
        filePath: this.path,
      });
    }
    const attrs = this.gattrsF.json;
    const attrsNoHidden = O.omit(attrs, ["hidden"]) as Readonly<GATTRS>;
    this.gattrsLast = attrsNoHidden;
    return attrsNoHidden;
  }
  gattrsP = async (): Promise<Readonly<GATTRS>> => {
    try {
      if (this.gattrsLast) return this.gattrsLast;
      l4(`F:gattrsP->${this.path}`);
      const exists = await this.existsP();
      if (!exists) {
        this.gattrsF.del().catch(() => {});
        throw Error(`Trying to get gattrs on file which d.n.e.`);
      }
      const attrs = await this.gattrsF.jsonP();
      const attrsNoHidden = O.omit(attrs, ["hidden"]) as Readonly<GATTRS>;
      this.gattrsLast = attrsNoHidden;
      return attrsNoHidden;
    } catch (e: anyOk) {
      throw stepErr(e, "F:gattrsP", {
        filePath: this.path,
        gattrsPath: this._gattrsPath,
      });
    }
  };
  private get gattrsF() {
    if (!this.gattrsFLast) {
      this.gattrsFLast = new File<GATTRS & FileGattrsHidden, anyOk>(this._gattrsPath);
    }
    return this.gattrsFLast;
  }
  gattrsSet = (to: GATTRS) => {
    this.gattrsLast = to;
    this.gattrsDirty = true;
    return this;
  };
  /**
   * sets gattrs but with a promise read to this.gattrsF.jsonP()
   */
  gattrsSetP = async (to: GATTRS) => {
    const toWithHidden = O.ass({}, await this.gattrsF.jsonP(), to);
    this.gattrsF.jsonSet(toWithHidden);
    return this;
  };
  /** merge an obj into gattrs */
  gattrsSetM(obj: PartialR<GATTRS>) {
    this.gattrsSet(O.merge(this.gattrs, obj) as anyOk);
    return this;
  }
  /** merge an obj into gattrs with a promise read */
  gattrsSetMP = async (obj: PartialR<GATTRS>) => {
    await this.gattrsP();
    this.gattrsSetM(obj);
    return this;
  };
  private gattrsFLast?: File<GATTRS & FileGattrsHidden, anyOk>;
  private gattrsLast?: GATTRS;
  private gattrsDirty = false;
  private _gattrsDir = `${fs.home}/.bldr/gattrs`;
  private get _gattrsPath() {
    return this._gattrsDir + this.path.replace(fs.home, "").replace(/\//g, ".");
  }

  /** gets json from cache or reads it synchronously */
  get json(): Readonly<JSON> {
    if (this.jsonLast) return this.jsonLast;
    try {
      this.jsonLast = this.text ? JSON.parse(this.text) : {};
    } catch (e: anyOk) {
      throw stepErr(e, "F:json", { jsonPath: this.path });
    }
    return this.jsonLast!;
  }
  jsonP = async () => {
    await this.textP();
    return this.json;
  };
  /**
   * sets the value of the json obj to be stored on the file.
   * - note: we intentionally do NOT have a set() bc File won't detect
   *   changes to the inner json obj, and it's too easy to make that
   *   mistake. I tried a proxy, but it got to complicated.
   */
  jsonSet(to: JSON) {
    // Format it like Prettier does
    this.text = str(to, 2).replace(/{}/g, "{\n  }") + "\n";
    this.jsonLast = to;
    return this;
  }
  /** merge an obj into json */
  jsonSetM(obj: PartialR<JSON>) {
    this.jsonSet(O.merge(this.json, obj) as anyOk);
    return this;
  }
  /** merge an obj into json with a promise read */
  jsonSetMP = async (obj: PartialR<JSON>) => {
    await this.jsonP();
    this.jsonSetM(obj);
    return this;
  };
  private jsonLast?: JSON;

  get md5() {
    if (!this.md5Last) this.md5Last = md5(this.buffer);
    return this.md5Last;
  }
  md5P = async () => {
    await this.bufferP();
    return this.md5;
  };
  private md5Last?: string;

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

      if (this.gattrsFLast) {
        await this.gattrsFLast.mv(`${this._gattrsPath}/${this.path}`);
      }

      this._path = to;
      this.existsLast = true;
      return this;
    } catch (e: anyOk) {
      throw stepErr(e, "F:mv", { from, to });
    }
  };

  /** Read all file data from disk. Is nice if you want to pump caches. */
  read = async () => {
    l4(`F:read->${this.path}`);
    await this.existsAssertP();
    await this.gattrsP();
    await this.statP();
    await this.bufferP();
    return this;
  };

  save = async () => {
    try {
      const exists = await this.existsP();
      if (exists) {
        if (this.bufferDirty) {
          l5(`F:save->${this.path}`);
          await fs.set(this.path, this.buffer);
          this.bufferDirty = false;
        }
      } else {
        this.gattrsF.del().catch(() => {});
        await fs.mkdir(pathN.dirname(this.path));
        await fs.set(this.path, this.buffer);
        this.bufferDirty = false;
      }

      this.existsLast = true;
      delete this.statLast;

      if (this.gattrsDirty) {
        const gattrsLast = await this.gattrsF.jsonP();
        const gattrsOnlyHidden = O.pick(gattrsLast, ["hidden"]);
        const gattrsNext = { ...this.gattrs, ...gattrsOnlyHidden };
        await this.gattrsF.set({ json: gattrsNext });
      }
      await this.saveXattrs();

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
      /** merge with gattrs  */
      gattrsM?: PartialR<GATTRS>;
      json?: JSON;
      /** merge with json  */
      jsonM?: PartialR<JSON>;
      text?: string;
      xattrs?: Dict;
    } = {},
  ) => {
    try {
      const _p: Promise<anyOk>[] = [];
      const { buffer, gattrs, gattrsM, json, jsonM, text, xattrs } = opts;
      if (buffer) this.buffer = buffer;
      if (text) this.text = text;
      if (json) this.jsonSet(json);
      if (jsonM) _p.push(this.jsonSetMP(jsonM));
      if (xattrs) this.xattrs = xattrs;
      if (gattrs) this.gattrsSet(gattrs);
      if (gattrsM) _p.push(this.gattrsSetMP(gattrsM));
      await P.all(_p);
      await this.save();
      return this;
    } catch (e) {
      throw stepErr(e, "F:set", { setPath: this.path });
    }
  };

  snapshot = async (name: string) => {
    const gattrs: GATTRS & FileGattrsHidden = await this.gattrsF.jsonP();
    if (!gattrs.hidden) gattrs.hidden = {};
    if (!gattrs.hidden.snapshots) gattrs.hidden.snapshots = {};
    gattrs.hidden.snapshots[name] = (await this.bufferP()).toString("base64");
    return this.gattrsF.set({ json: gattrs });
  };
  snapshotGet = async (name: string) => {
    const gattrs = await this.gattrsF.jsonP();
    const snap64 = gattrs?.hidden?.snapshots?.[name];
    if (!snap64) {
      throw stepErr(Error(`Snapshot not found: ${name}`), "F:snapshotRestore", {
        snap64,
      });
    }
    const snap = Buffer.from(snap64, "base64");
    const res = {
      buffer: snap,
      get text() {
        return snap.toString("utf-8");
      },
      get json() {
        return JSON.parse(res.text);
      },
    };
    return res;
  };
  snapshotRestore = async (name: string) => {
    const snap = await this.snapshotGet(name);
    return this.set({ buffer: snap.buffer });
  };

  private statLast?: fsN.Stats;
  get stat() {
    if (this.statLast) return this.statLast;
    l4(`F:stat->${this.path}`);
    this.existsAssert();
    this.statLast = fsN.statSync(this.path);
    return this.statLast;
  }
  statP = async () => {
    if (this.statLast) return this.statLast;
    l4(`F:statP->${this.path}`);
    await this.existsAssertP();
    this.statLast = await fsN.promises.stat(this.path);
    return this.statLast;
  };

  get stream() {
    let stream: Readable;
    if (this.bufferLast) {
      stream = Readable.from(this.bufferLast);
    } else {
      stream = fsN.createReadStream(this.path);
    }
    return stream;
  }

  /** gets text from buffer (or cache if buffer is cached) */
  get text() {
    const text = this.buffer.toString("utf-8"); // note: toString="" for empty files
    return text;
  }
  /** get text from buffer (or cache if buffer is cached) using a promise */
  textP = async () => {
    await this.bufferP();
    return this.text;
  };
  set text(to: string) {
    this.buffer = to;
  }
  /** Set var, -- but returns this -- for chaining */
  textSet(to: string) {
    this.text = to;
    return this;
  }

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
        const xattrsRaw = childProcessN.execFileSync(`xattr -l ${this.path}`);
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
    } catch (e) {
      throw stepErr(e, `f.setXattrs`, {
        setXattrsPath: this.path,
        xattrs: this.xattrs,
      });
    }
  };
}
interface FileGattrsHidden {
  hidden?: {
    snapshots?: {
      [name: string]: string;
    };
  };
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

  static exists = async (path: string) => {
    return fsN.promises.exists(path);
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

        excludes.push(...[/\.DS_Store/]);

        if (includes?.length) {
          for (const inc of includes) {
            if (Is.str(inc) && inc.startsWith("/")) throw Error(`includes must be relative`);
          }
        }

        let paths: string[] = [];
        await fsN.promises
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

  static fileURLToPath = urlNode.fileURLToPath;

  /** get's a file object */
  static get = <JSON, GHOSTS>(path: string) => {
    let file = fs._getCache.get(path);
    if (!file) {
      file = new File(path);
      fs._getCache.set(path, file);
    }
    return file as File<JSON, GHOSTS>;
  };
  private static _getCache = new Map<string, File<anyOk, anyOk>>();

  /** get package.json file */
  static getPkgJsonFile = (pathToPkgOrPkgJson: string) => {
    let path = pathToPkgOrPkgJson;
    if (!path.endsWith("package.json")) path = `${path}/package.json`;
    const jsonF = fs.get<PkgJsonFields, never>(path);
    const pkgF = O.ass(jsonF, {
      /** Disable install and build hooks */
      disableHooks: async () => {
        if (jsonF.json.scripts) {
          const next = { ...jsonF.json };
          O.replKeys<PkgJsonFields>(next.scripts!, /^(preinstall|postinstall|prebuild|postbuild)/, `//$1`, true);
          await jsonF.set({ json: next });
        }
      },
      /** re-enable install and build hooks which were disabled */
      enableHooks: async () => {
        if (jsonF.json.scripts) {
          const next = { ...jsonF.json };
          O.replKeys(next.scripts!, /^(\/\/)(preinstall|postinstall|prebuild|postbuild)/, `$2`, true);
          await jsonF.set({ json: next });
        }
      },
    });
    return pkgF;
  };

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

  /** wrapper for fs.rm with defaults and filters */
  static rm = async (path: string, opts: Parameters<(typeof fsN.promises)["rm"]>[1] = {}) => {
    const { force, recursive = true } = opts;
    try {
      const stat = await fs.stat(path).catch(() => {});
      if (!stat) {
        if (force) return;
        throw stepErr(Error(`frm:path not found`), "stat", { rmPath: path });
      }
      const isFile = stat.isFile();
      if (isFile) {
        return fsN.promises.unlink(path).catch((e) => {
          throw stepErr(e, "unlink: no such file", { rmPath: path });
        });
      } else {
        return fsN.promises.rm(path, { force, recursive }).catch((e) => {
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

  /** gets fs.stat */
  static stat = async (path: string) => {
    try {
      const stat = await fsN.promises.stat(path);
      return stat as ReturnTypeP<typeof fsN.promises.stat> & { xattrs: Dict };
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
  static _exec = utilNode.promisify(childProcessN.exec);

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

    let _log1 = l1;
    let _log4 = l4;
    if (verbose) {
      _log1 = _log4 = l1;
    }
    if (silent) {
      _log1 = _log4 = l9;
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
        if (hasObjs) lines.push(...args.map((a: anyOk) => (Is.scalar(a) ? a : str(a))));
        else lines[0] += ` ${args.join(" ")}`;
        txt = lines.join(" ") + "\n";
      }
      Log.appendLogFilePromises.push(fs.append(Log.file, txt)); // be lazy about it

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
        2,
        { printUndefineds: true },
      ).replace(/"/g, "")}`,
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
            },
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
