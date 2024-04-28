#!/usr/bin/env bun

import childProcessNode from "node:child_process";
import { promises as fsNode } from "node:fs";
import os from "node:os";
import pathNode from "node:path";
import util from "node:util";

export const UTIL_ENV = {
  ci: process.env["CI"] === "1" ? true : false,
  logLevel: Number(process.env["LOG"] ?? 1),
  semiDry: Number(process.env["DRY"]),
};

/** Aliases and misc */

/** Makes a function cached (forever atm) */
export const cachify = <T extends Fnc>(fn: T) => {
  const cache: Map<any, any> = new Map();
  return (...args: Parameters<T>): ReturnType<T> => {
    const key = JSON.stringify(args?.length ? args : "none");
    if (cache.has(key)) return cache.get(key);
    const res = fn(...args);
    cache.set(key, res);
    return res;
  };
};

/** any function */
export type Fnc = (...args: any) => any;

/** alias for Record<string, T> */
export type Dict<T> = { [k: string]: T };

/** Type guard for checking if a value is a certain type */
export const isTypeOf = (a: unknown, typeOrTypes: string | string[]) => {
  const types = Array.isArray(typeOrTypes) ? typeOrTypes : [typeOrTypes];
  return types.includes(typeof a);
};

/** alias for Array.isArray */
export const isArr = (a: unknown): a is any[] => Array.isArray(a);

/** alias for typeof var === "number" */
export const isNum = (a: unknown): a is number => typeof a === "number";

/** alias for typeof var === "string" */
export const isStr = (s: unknown): s is string => typeof s === "string";

import crypto from "node:crypto";
// import fs from "fs";

export const md5 = (bufferOrBuffers: Buffer | Buffer[]) => {
  const hash = crypto.createHash("md5");
  if (isArr(bufferOrBuffers)) {
    bufferOrBuffers.forEach((b) => hash.update(b));
  } else {
    hash.update(bufferOrBuffers);
  }
  return hash.digest("hex");
};

/** alias for Object */
export const O = Object;

/** omit kets from an object */
export const omit = <T extends Record<string, any>, K extends keyof T>(
  obj: T,
  keys: readonly K[] | K[]
): Omit<T, K> => {
  const res = Object.assign({}, obj);
  keys?.forEach((k) => {
    if (k in obj) delete res[k];
  });
  return res;
};

/** alias for Promise */
export const P = Promise;

/** A return type of a promise */
export type PReturnType<T extends (...args: any) => Promise<any>> =
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
export const stepErr = (e: any, step: string, extra: Dict<string> = {}) => {
  return O.assign(e, {
    step: `${step}${e?.step ? `:${e?.step}` : ""}`,
    ...extra,
  });
};
/** Convenient to .catch */
export const stepErrCb =
  (step: string, extra: Dict<string> = {}) =>
  (e: any) => {
    O.assign(e, { step: `${step}${e?.step ? `:${e?.step}` : ""}`, ...extra });
    throw e;
  };
/**
 * Convenient if the error is inline with a var declaration
 * always pass a real Error, otherwise the stack trace will have throwError
 */
export const throwStepErr = (e: any, step: string) => {
  O.assign(e, { step: `${step}${e?.step ? `:${e?.step}` : ""}` });
  throw e;
};

// Regular expression to match ANSI escape codes
export const strAnsiEscapeExp =
  /(?:\x1B[@-Z\\-_]|\x9B|\x1B\[)[0-?]*[ -/]*[@-~]/g;

export const str = (o: any, spaces?: number): string =>
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

export const str2 = (o: any): string => {
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

export const strTrim = (s: string, len: number) => {
  if (s.length <= len) return s;
  return s.slice(0, len) + "...";
};

/**
 * convenience method for throwing errors inline.
 * always pass a real Error, otherwise the stack trace will have throwError
 */
export const throwErr = (error: any, ...extra: any): never => {
  throw O.assign(error, extra);
};

export class Bazel {
  /**
   * traverse the directory tree from __dirname to find the nearest WORKSPACE.bazel
   * file and return the path
   */
  static findNearestWsRootNoCache = async (startFrom = process.cwd()) => {
    log4("findNearestWsRoot->start");
    let root = startFrom;
    while (true) {
      const ws = await fs.getC(`${root}/WORKSPACE.bazel`).catch(() => {});
      if (ws) break;
      const next = pathNode.resolve(root, "..");
      if (next === root) {
        throw stepErr(Error("No WORKSPACE.bazel found"), "findNearestWsRoot");
      }
      root = next;
    }
    log4(`findNearestWsRoot->${root}`);
    return root;
  };
  static findNearestWsRoot = cachify(Bazel.findNearestWsRootNoCache);
}

/** Filesystem (aka fs) - helpers */
export class fs {
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

      let backupPath =
        `${fs.tmpDir}/` +
        path
          // .replace(wss.getWorkspaceCache?.path ?? "", "")
          // .slice(1)
          .replace(/\//g, ".") +
        "-" +
        new Date().toISOString().slice(11, -2).replace(/:/g, ".");

      if (text) {
        await fs.set(backupPath, text, { skipBackup: true });
      } else if (moveInsteadOfCopy) {
        await fs.rename(path, backupPath, { skipBackup: true });
      } else {
        await fs.copyFile(path, backupPath, { skipBackup: true });
      }
    } catch (e: any) {
      // don't throw if backup fails bc it's not critical and is often an unhandled error so will hard hault the process
      log1(
        O.assign(e, {
          extra: "WARN: fs.backup failed",
          step: `fs.backup:${e?.step}`,
        })
      );
    }
  };

  static copyFile = async (
    from: string,
    to: string,
    options: {
      skipBackup?: boolean;
    } = {}
  ) => {
    const toStat = await fs.stat(to);

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
    } catch (e: any) {
      throw stepErr(e, `fs.copyFile:backup->failed`);
    }

    if (toStat?.isDirectory()) {
      to = `${to}/${pathNode.basename(from)}`;
    }

    await fsNode.copyFile(from, to).catch((e) => {
      throw stepErr(
        Error(`${e.message};\nfrom:${from}\nto:${to}`),
        `fs.copyFile`
      );
    });
  };

  static createdFiles: string[] = [];

  static dirtyFiles: Dict<{
    orig: string;
    path: string;
  }> = {};

  /** get's a file object */
  static get = async (path: string) => {
    const text = await fsNode.readFile(path, "utf-8").catch(() => {
      throw stepErr(Error(`file not found: ${path}`), `fs.get`);
    });
    const file = {
      /** resets the file to the original state when first read */
      reset: async () => {
        log5(`fs.get->reset ${path}`);
        await fs.set(path, text);
        log5(`fs.get->reset-success ${path}`);
      },
      save: async () => fs.set(path, file.text),
      set: (newText: string) => fs.set(path, newText),
      text,
    };
    return file;
  };
  /** get's a file object from cache or fs */
  static getC = cachify(fs.get);

  /** get json file */
  static getJsonFile = async <T extends any>(path: string) => {
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
      setJson: async (json: any) => file.set(str(json, 2) + "\n"),
    };
    return jsonF;
  };
  /** get json file from cache or fs */
  static getJsonFileC = cachify(fs.getJsonFile);

  /** get package.json file */
  static getPkgJsonFile = (pathToPkgOrPkgJson: string) => {
    let path = pathToPkgOrPkgJson;
    if (!path.endsWith("package.json")) path = `${path}/package.json`;
    return fs.getJsonFile<{
      name: string;
      dependencies: Dict<string>;
      devDependencies: Dict<string>;
      peerDependencies: Dict<string>;
    }>(path);
  };
  /** get package.json file from cache or fs */
  static getPkgJsonFileC = cachify(fs.getPkgJsonFile);

  static home = os.homedir();

  /** get file list from cache or fs */
  // TODO: replace usages of sh.find with this
  static ls = async (
    path: string,
    options: {
      type?: "file" | "dir";
      /** regex excludes */
      excludes?: RegExp[];
      currentDepth?: number;
      maxDepth?: number;
      recursive?: boolean;
    } = {}
  ): Promise<null | string[]> => {
    // log4(`fs:ls:start->${path}`);

    const {
      currentDepth = 0,
      excludes = [],
      maxDepth = Infinity,
      recursive = false,
      type,
    } = options;

    excludes.push(...[/.DS_Store/]);

    const paths: string[] = [];
    await fsNode.readdir(path).then(async (paths2) =>
      P.all(
        paths2.map(async (p) => {
          for (let e of excludes) {
            if (p.match(e)) return;
          }
          p = `${path}/${p}`;
          const stat = await fs.stat(p);
          const isDir = stat!.isDirectory();
          const isFile = stat!.isFile();
          if (isDir && recursive && currentDepth < maxDepth) {
            await fs
              .ls(p, {
                currentDepth: currentDepth + 1,
                excludes,
                maxDepth,
                recursive,
                type,
              })
              .then((paths3) => {
                paths3 && paths.push(...paths3);
              });
          }
          if (type) {
            if (type === "dir" && !isDir) return false;
            if (type === "file" && !isFile) return false;
          }
          paths.push(p);
        })
      )
    );

    // log4(`fs:ls:res->${paths ? `found: ${paths.length}` : " not found"}`);
    paths.sort();
    return paths;
  };
  static lsC = cachify(fs.ls);

  static pathRel = (path: string) => {
    if (path.startsWith(process.cwd())) {
      return path.replace(process.cwd(), "").replace(/^\//, "") ?? "./";
    }
    return path;
  };

  static purgeDir = async (path: string) => {
    try {
      const todo = await fs.ls(path);
      if (!todo?.length) return;
      await P.all(todo.map((f) => fs.rm(`${path}/${f}`, { skipBackup: true })));
      return todo.length;
    } catch (e: any) {
      throw stepErr(e, `fs.purgeDir`, { path });
    }
  };

  static read = fs.get;

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
        if (await fs.stat(to)) {
          await fs.backup(to);
          if (!(to in fs.dirtyFiles)) {
            fs.dirtyFiles[to] = { path: to, orig: (await fs.get(to)).text };
          }
        } else {
          fs.createdFiles.push(to);
        }
      }
    } catch (e: any) {
      throw O.assign(Error(e), { step: `fs.rename:backup->failed` });
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
        O.values(fs.dirtyFiles).map((df) =>
          fs.set(df.path, df.orig, { skipBackup: true })
        )
      );
      await P.all(fs.createdFiles.map((cf) => fs.rm(cf, { skipBackup: true })));
    } catch (e: any) {
      throw stepErr(e, "fs.resetChangedFiles");
    }
  };

  /** wrapper for fs.rm with defaults and option to ignore not-found */
  static rm = async (
    path: string,
    options: Parameters<(typeof fsNode)["rm"]>[1] & {
      skipBackup?: boolean;
    } = {}
  ) => {
    try {
      const { skipBackup = false, ...restOptions } = options;
      const isFile = (await fs.stat(path))?.isFile();
      if (!skipBackup && !(path in fs.dirtyFiles) && isFile) {
        fs.dirtyFiles[path] = { path, orig: (await fs.get(path)).text };
      }
      if (isFile) {
        return fsNode.unlink(path);
      } else {
        if (!("recursive" in restOptions)) restOptions.recursive = true;
        if (!("force" in restOptions)) restOptions.force = true;
        return fsNode.rm(path, restOptions);
      }
    } catch (e: any) {
      throw stepErr(e, "fs.rm", { cmd: `fs:rm->${path}` });
    }
  };

  /** fs.stat or null. Is cleaner than dealing with exceptions. */
  static stat = async (path: string) => {
    return fsNode.stat(path).catch(() => null);
  };

  static tmpDir =
    `/tmp/lerna-crosslink-build/` +
    new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/(\-|T|:)/g, ".");
  static tmpDirCreate = cachify(async () => {
    return util
      .promisify(childProcessNode.exec)(`mkdir -p ${fs.tmpDir}`)
      .catch((e) => {
        throw stepErr(e, `fs.tmpDirCreate`);
      });
  });
  static tmpDirPurge = async () => {
    log2("purgeTmpDir");
    await fs.rm(fs.tmpDir);
  };

  static set = async (
    to: string,
    text: string,
    options: {
      skipBackup?: boolean;
    } = {}
  ) => {
    try {
      const { skipBackup = false } = options;
      if (!skipBackup) {
        if (await fs.stat(to)) {
          await fs.backup(to);
          if (!(to in fs.dirtyFiles)) {
            fs.dirtyFiles[to] = { path: to, orig: (await fs.get(to)).text };
          }
        } else {
          fs.createdFiles.push(to);
        }
      }
    } catch (e: any) {
      throw stepErr(e, `fs.set:backup->failed`);
    }
    await fsNode.writeFile(to, text, "utf8").catch((e) => {
      throw stepErr(Error(`${e.message}; to:${to}`), `fs.set`);
    });
  };
}

/** Shell / Process helpers aka sh */
export class sh {
  static _exec = util.promisify(childProcessNode.exec);

  static cmdExists = async (cmd: string) =>
    !!(await sh.exec(`command -v ${cmd}`, { silent: true }).catch(() => {}));
  static assertCmdExists = async (cmd: string) =>
    await sh.exec(`command -v ${cmd}`, { silent: true }).catch(() => {
      throw stepErr(Error(`Command not found: ${cmd}`), `sh.assertCmdExists`);
    });

  /** Node exec wrapper with lots of special sauce */
  static exec = async (
    cmd: string,
    options: {
      /** cb for logs on a lineArray.filter */
      logFilter?: (text: string) => any;
      rawOutput?: boolean;
      silent?: boolean;
      throws?: boolean;
      verbose?: boolean;
      /** working directory */
      wd?: string;
    } = {}
  ): Promise<string> => {
    const {
      logFilter = () => true,
      rawOutput = false,
      silent = false,
      throws = true,
      verbose = false,
      wd = process.cwd(),
    } = options;

    let _log1 = log1;
    let _log2 = log2;
    let _log3 = log3;
    let _log4 = log4;
    if (verbose) {
      _log1 = _log2 = _log3 = _log4 = log1;
    }
    if (silent) {
      _log1 = _log2 = _log3 = _log4 = log9;
    }

    const id = (sh.execCount = (sh.execCount ?? 0) + 1);
    const prefix = `sh:${id}:`;

    _log3(`${prefix} cmd='${strTrim(cmd, 300)}'`);
    log9(`${prefix}:${id} cmdFull='${cmd}'`);
    _log4(`${prefix} cwd=${wd}`);

    const cwdExp = new RegExp(process.cwd(), "g");

    // const cmdFinal = (options.wd ? `cd ${wd} && ${cmd}` : cmd) + " 2>&1";
    const cmdFinal = options.wd ? `cd ${wd} && ${cmd}` : cmd;

    // let execP = Promise.withResolvers<string>();
    return new Promise((resolve, reject) => {
      let allout = "";
      const execLog = (text: string, type: "stdout" | "stderr") => {
        let out = strCondense(text, { removeStyle: false });
        if (!out) return;
        allout += out + "\n";
        // let outPrefix = `stdout:`;
        // if (out.length > maxStdOutLen) {
        //   out = out.slice(0, maxStdOutLen) + "...";
        //   outPrefix += " (trimmed)";
        // }
        if (rawOutput) log0(text);
        else {
          for (let l of out.split("\n")) {
            if (!logFilter(l)) continue;
            l = l.replace(cwdExp, "wd:");
            l = `${prefix} ${l}`;
            _log3(l);
          }
        }
      };

      const cp = childProcessNode.spawn(cmdFinal, { shell: true });
      cp.stdout.on("data", (data) => execLog(data.toString(), "stdout"));
      cp.stderr.on("data", (data) => execLog(data.toString(), "stderr"));
      cp.on("close", (code) => {
        if (!allout) {
          _log2(`${prefix} (empty stdout/stderr)`);
        }
        if (code) {
          _log1(`${prefix} ERROR!`);
          _log1(`${prefix} cmd='${strTrim(cmd, 200)}'`);
          _log1(`${prefix} wd=${wd}`);
          _log1(`${prefix} code=${code}`);

          const err = O.assign(Error(`sh:${id}->nonzero-return`), {
            cmd: strTrim(cmd, 200),
            execId: id,
            step: "exec",
            workingDir: wd,
          });
          if (throws) {
            // execP.reject(err);
            reject(err);
          }
        }
        // execP.resolve(allout);
        resolve(allout);
      });

      // return execP.promise;
    });
  };
  static execCount = 0;

  static sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
}

export class Log {
  static file = `${fs.tmpDir}/run.log`;
  static appendLogFilePromises: Promise<any>[] = [];
  public prefix: string;
  public showLogLevels: boolean;
  public showTimestamps: boolean;

  constructor(
    options: {
      prefix?: string;
    } = {}
  ) {
    const { prefix } = options;
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
    const logFnc = async (...args: any) => {
      /** determines how much logging is printed to the console. Higher is more. */
      const logLevel = UTIL_ENV.logLevel;
      let isErr = args[0] instanceof Error;

      // This debug line helps find empty log calls
      // if ([...args].join("").trim() === "") console.trace();

      if (n === 0) {
        console.log(...args);
        fs.tmpDirCreate().then(() => {
          fsNode.appendFile(Log.file, args.join(" ") + "\n");
        });
        return args;
      }

      // if first arg is an array, log each item in the array
      if (isArr(args[0])) {
        args[0].forEach((a) => logFnc(a));
        return;
      }

      if (this.prefix && !isErr) {
        if (isStr(args[0])) args[0] = this.prefix + args[0];
        else args.unshift(this.prefix);
      }

      // ts = yyyy:hh:mm:ss:msms -> ie 2024:15:12:41.03
      const ts = new Date().toISOString().slice(0, -2);

      // skip logging to console if the log message level is higher than the log level
      if (logLevel >= n) {
        let argsExtra = args;
        if (isStr(args[0])) {
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
      await fs.tmpDirCreate();
      let txt = "";
      if (isErr) {
        let lines = [];
        // dump of the error in a the way that mimics console
        lines.push(args[0].stack + " {");
        lines.push(...O.entries(args[0]).map(([k, v]) => `  ${k}: ${v}`));
        lines.push("}");
        txt = lines.join("\n") + "\n";
      } else {
        let lines = [];
        lines.push(`${ts} L${n}`);
        const hasObjs = args.some(
          (a: any[]) => !isTypeOf(a, ["string", "number"])
        );
        if (!hasObjs) lines[0] += ` ${args.join(" ")}`;
        else lines.push(...args.map(str));
        txt = lines.join(" ") + "\n";
      }
      Log.appendLogFilePromises.push(fsNode.appendFile(Log.file, txt)); // be lazy about it

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
  l0 = (...args: any) => {
    return this.logn(0)(...args);
  };
  l1 = (...args: any) => {
    return this.logn(1)(...args);
  };
  l2 = (...args: any) => {
    return this.logn(2)(...args);
  };
  l3 = (...args: any) => {
    return this.logn(3)(...args);
  };
  l4 = (...args: any) => {
    return this.logn(4)(...args);
  };
  l5 = (...args: any) => {
    return this.logn(5)(...args);
  };
  /** High number that's used mainly to print to log file without console  */
  l9 = (...args: any) => {
    return this.logn(9)(...args);
  };

  lErrCtx = (e: any) => {
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

  lFinish = async (maybeErr?: any) => {
    if (maybeErr) this.lErrCtx(maybeErr);
    this.l1("Full-log:", Log.file);
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

/** Mainly used for testing */
if (import.meta.url === `file://${process.argv[1]}`) {
  // console.log(process.argv);
  // d@ts-expect-error - gets confused args
  // await main(...process.argv.slice(2));
  // await fs.ls(process.argv[2], { recursive: true });
}
