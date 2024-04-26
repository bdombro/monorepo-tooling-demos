#!/usr/bin/env node
/**
 * monorepocli (aka mrc) - A monorepo cli tool that links internal packages like npm packages
 *
 * Motivation:
 *   1. Existing monorepo tools mismanage crosslinks in a monorepo, by linking them via a basic symlink.
 *     This causes many issues, such as:
 *     1. deeply nested node_modules folders
 *     2. devDependencies of the crosslinks being installed
 *     3. dependencies being in diff places vs if installed as an npm package
 *     4. symlink issues todo with the way that node resolves modules
 *   2. Existing monorepo tools don't allow for each package to have it's own package manager and lock
 *      file, which dramatically decreases flexibility, while dramatically increasing cost of adoption
 *
 *   Example crosslink conflicts in existing tools:
 *   - a React app may have deps that have devDeps with diff version of React. This causes typescript
 *     and bundlers to include multiple versions of React, which blows up the bundle size,
 *     causes runtime errors, and typescript errors.
 *   - symlink resolution conflict: if "libA" depends on lodash, and "libB" depends on lodash and
 *     "libA", nested libA will use it's own copy of lodash instead of libB's.
 *
 * Goal: De-conflict nested dependencies
 *
 * Assumptions:
 *  - This script is called from somewhere inside a monorepocli monorepo
 *  - The ws root has a monorepocli.conf.js field
 *  - Workspace packages have a name field with a domain, ie @app/packageName
 *  - ws packages don't use postinstall or postbuild scripts
 */
import { exec as cpExec } from "child_process";
import { promises as fsNode } from "fs";
import pathNode from "path";
import util from "util";

export const UTIL_ENV = {
  logLevel: Number(process.env.LOG ?? 1),
  semiDry: Number(process.env.DRY),
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

/** alias for Object */
export const O = Object;

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
  return O.assign(e, { step: `${step}:${e?.step}`, ...extra });
};
/** Convenient to .catch */
export const stepErrCb =
  (step: string, extra: Dict<string> = {}) =>
  (e: any) => {
    O.assign(e, { step: `${step}:${e?.step}`, ...extra });
    throw e;
  };
/**
 * Convenient if the error is inline with a var declaration
 * always pass a real Error, otherwise the stack trace will have throwError
 */
export const throwStepErr = (e: any, step: string) => {
  O.assign(e, { step: `${step}:${e?.step}` });
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

export const strCondense = (str: string): string =>
  str
    .replace(strAnsiEscapeExp, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");

/**
 * convenience method for throwing errors inline.
 * always pass a real Error, otherwise the stack trace will have throwError
 */
export const throwErr = (error: any, ...extra: any): never => {
  throw O.assign(error, extra);
};

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
        await fs.writeFile(backupPath, text, { skipBackup: true });
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
        await fs.writeFile(path, text);
        log5(`fs.get->reset-success ${path}`);
      },
      set: (newText: string) => fs.writeFile(path, newText),
      text,
    };
    return file;
  };
  /** get's a file object from cache or fs */
  static getC = cachify(fs.get);

  /** get json file */
  static getJsonFile = async <T extends any>(path: string) => {
    const rfRes = await fs.get(path);
    const json = JSON.parse(rfRes.text) as T;
    const jsonF = {
      ...rfRes,
      json,
      jsonOrig: json,
      path,
      /** will reset to the original values when first read */
      reset: async () => {
        await rfRes.reset();
        jsonF.json = jsonF.jsonOrig;
      },
      /** will save to fs whatever the current values in json are */
      save: async () => jsonF.setJson(jsonF?.json),
      /** will set the json and write it to disk */
      setJson: async (json: any) => rfRes.set(str(json, 2) + "\n"),
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

  /** get file list from cache or fs */
  static ls = async (path: string): Promise<null | string[]> => {
    const lctx = `fs.ls: ${path}`;

    log4(`${lctx}:start`);

    const files = await fsNode
      .readdir(path)
      .then(
        (p) => p.filter((p) => p !== ".DS_Store"),
        () => null
      )
      .catch((e) => {
        throw stepErr(Error(`${e.message}; ls:${path}`), `fs.ls`);
      });

    log4(`${lctx}: ${files ? `found: ${files.length}` : " not found"}`);
    return files;
  };
  static lsC = cachify(fs.ls);

  static pathRel = (path: string) => {
    if (path.startsWith(process.cwd())) {
      return path.replace(process.cwd(), "").replace(/^\//, "") ?? "./";
    }
    return path;
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
          fs.writeFile(df.path, df.orig, { skipBackup: true })
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
      .promisify(cpExec)(`mkdir -p ${fs.tmpDir}`)
      .catch((e) => {
        throw stepErr(e, `fs.tmpDirCreate`);
      });
  });
  static tmpDirPurge = async () => {
    log2("purgeTmpDir");
    await fs.rm(fs.tmpDir);
  };

  static writeFile = async (
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
      throw stepErr(e, `fs.writeFile:backup->failed`);
    }
    await fsNode.writeFile(to, text, "utf8").catch((e) => {
      throw stepErr(Error(`${e.message}; to:${to}`), `fs.writeFile`);
    });
  };
}

/** Shell / Process helpers aka sh */
export class sh {
  static _exec = util.promisify(cpExec);

  static cmdExists = async (cmd: string) =>
    !!(await sh.exec(`command -v ${cmd}`, { throws: false }));
  static assertCmdExists = async (cmd: string) =>
    await sh.exec(`command -v ${cmd}`).catch(() => {
      throw stepErr(Error(`Command not found: ${cmd}`), `sh.assertCmdExists`);
    });

  /** Node exec wrapper with lots of special sauce */
  static exec = async (
    cmd: string,
    options: {
      mockStderr?: string;
      mockStdout?: string;
      silent?: boolean;
      throws?: boolean;
      verbose?: boolean;
      /** working directory */
      wd?: string;
    } = {}
  ) => {
    const {
      mockStderr = null,
      mockStdout = null,
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
    const lctx = `exec:${id}`;

    _log3(`${lctx} cmd='${cmd}'`);
    _log4(`${lctx} cwd=${wd}`);

    const maxStdOutLen = 20000;

    const mockExec = async () => {
      const execR = {
        code: 1,
        killed: false,
        signal: null,
        stderr: mockStderr,
        stdout: mockStdout,
      };
      if (mockStderr) {
        throw O.assign(Error(mockStderr), execR);
      }
      return execR;
    };

    const cwdExp = new RegExp(process.cwd(), "g");

    const execOrMock =
      UTIL_ENV.semiDry && (isStr(mockStdout) || isStr(mockStderr))
        ? mockExec
        : sh._exec;
    const cmdWithCd = options.wd ? `cd ${wd} && ${cmd}` : cmd;

    const execR = await execOrMock(cmdWithCd).catch((e) => {
      if (!throws) return e;

      let out = strCondense(e.stdout ?? "none");
      let outFlags = "";
      if (out.length > maxStdOutLen) {
        out = out.slice(0, maxStdOutLen) + "...";
        outFlags = "(trimmed)";
      }

      let err = strCondense(e.stderr);
      let errFlags = "";
      if (err.length > maxStdOutLen) {
        err = err.slice(0, maxStdOutLen) + "...";
        errFlags = "(trimmed)";
      }

      _log1(
        (
          `ERROR!\n` +
          `cmd='${cmd}'\n` +
          `wd=${wd}\n\n` +
          `stdout: ${outFlags}\n` +
          `${out}\n\n\n` +
          `stderr: ${errFlags}\n` +
          `cmd='${cmd}'\n` +
          `${err}\n\n\n` +
          `context:\n` +
          `cmd='${cmd}'\n` +
          `wd=${wd}\n\n`
        )
          .split("\n")
          .map((l) => `${lctx} ${l}`)
      );

      _log1(`${lctx}:end`);
      const e2 = O.assign(Error(`${lctx}->nonzero-return`), {
        cmd,
        execId: id,
        step: "exec",
        workingDir: wd,
      });
      throw e2;
    });

    if (execR instanceof Error) {
      _log4(`${lctx}:end->non-zero-return-skipped`);
      return "";
    }

    let out = strCondense(execR.stdout ?? "none");
    let outPrefix = `stdout:`;
    if (out.length > maxStdOutLen) {
      out = out.slice(0, maxStdOutLen) + "...";
      outPrefix += " (trimmed)";
    }

    `${outPrefix}\n${out}`
      .split("\n")
      .forEach((l) => _log4(`${lctx} ${l.replace(cwdExp, "wd:")}`));
    if (!out) {
      _log4(`${lctx}>none`);
    }

    _log4(`${lctx}:end`);
    return out;
  };
  static execCount = 0;

  static sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
}

export class Log {
  static file = `${fs.tmpDir}/run.log`;

  /** determines how much logging is printed to the console. Higher is more. */
  static logLevel = UTIL_ENV.logLevel;

  static logn(n: number) {
    const logLevel = Log.logLevel;
    const logFnc = (...args: any) => {
      // This debug line helps find empty log calls
      // if ([...args].join("").trim() === "") console.trace();

      // if first arg is an array, log each item in the array
      if (isArr(args[0])) {
        args[0].forEach((a) => logFnc(a));
        return;
      }

      // ts = yyyy:hh:mm:ss:msms -> ie 2024:15:12:41.03
      const ts = new Date().toISOString().slice(0, -2);

      // skip logging to console if the log message level is higher than the log level
      if (logLevel >= n) {
        if (logLevel <= 1) console.log(...args);
        else {
          const tsNoYear = ts.slice(11);
          // prepend the log level to the log message
          const argsExtra =
            args[0] instanceof Error ? args : [tsNoYear, `L${n}`, ...args];
          console.log(...argsExtra);
        }
      }

      // lazily log to file
      fs.tmpDirCreate().then(() => {
        let txt = "";
        if (args[0] instanceof Error) {
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
        fsNode.appendFile(Log.file, txt);
      });

      return args;

      // end of logFnc
    };
    return logFnc;
    // end of logn
  }
  static l1(...args: any) {
    return Log.logn(1)(...args);
  }
  static l2(...args: any) {
    return Log.logn(2)(...args);
  }
  static l3(...args: any) {
    return Log.logn(3)(...args);
  }
  static l4(...args: any) {
    return Log.logn(4)(...args);
  }
  static l5(...args: any) {
    return Log.logn(5)(...args);
  }
  /** High number that's used mainly to print to log file without console  */
  static l9(...args: any) {
    return Log.logn(9)(...args);
  }
}
export const log1 = Log.l1;
export const log2 = Log.l2;
export const log3 = Log.l3;
export const log4 = Log.l4;
export const log5 = Log.l5;
export const log9 = Log.l9;

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
