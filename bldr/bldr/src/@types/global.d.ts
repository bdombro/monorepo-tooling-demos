/* eslint-disable @typescript-eslint/no-explicit-any */
/** Super sany -- avoids eslint errors. Use sparingly! */
type anyOk = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Should be fixed at some point */
type TSFIXME = anyOk;

type Fnc = (...args: anyOk[]) => anyOk;
type FncP = (...args: anyOk[]) => Promise<anyOk>;

/** A better ReturnType? */
// type ReturnType<T extends Fnc> = T extends (...args: sany[]) => infer R
//   ? R
//   : never;

// eslint-disable-next-line @typescript-eslint/ban-types
type ReturnTypeLoose<T extends Function> = T extends (...args: anyOk[]) => infer R ? R : never;

type ThenArg<T> = T extends PromiseLike<infer U> ? U : T;
type ReturnTypeP<T extends (...args: anyOk[]) => anyOk> = ThenArg<ReturnType<T>>;
/** A return type of a promise */
// type ReturnTypeP<T extends (...args: anyOk) => Promise<anyOk>> =
//   ReturnType<T> extends Promise<infer U> ? U : never;

/**
 * Make all properties in T never
 */
type Never<T> = {
  [P in keyof T]?: never;
};
/**
 * Make properties either normal or never
 */
type AllOrNothing<T> = T | Never<T>;

type ReadonlyNot<T> = {
  -readonly [P in keyof T]: T[P] extends object ? ReadonlyNot<T[P]> : T[P];
};

/** Accepts any type that's not an array */
type ArrayNot =
  // | Primitive
  {
    length?: never;
    [key: string]: anyOk;
  };

/**
 * The type of mult objs in an array combined using '&'
 * see O.ass for an example.
 */
type Combine<T extends object[]> = T extends [infer First, ...infer Rest]
  ? First extends object
    ? Rest extends object[]
      ? Combine<Rest> & First
      : never
    : never
  : // eslint-disable-next-line @typescript-eslint/ban-types
    {};

/** Partial recursive */
type PartialR<T> = {
  [P in keyof T]?: T[P] extends (infer U)[] ? PartialR<U>[] : T[P] extends object ? PartialR<T[P]> : T[P];
};

/** get the values of an obj, like with Object.values */
type ValOf<T> = T[keyof T];
/** gets all possible values for an object recursive, like for O.valsRecursive */
type ValOfRecursive<T> = T extends object
  ? T[keyof T] extends Primitive
    ? T[keyof T]
    : ValOfRecursive<T[keyof T]>
  : T;

/** alias for Record<string, string> */
type Dict = Record<string, string>;

/** alias for Record<string, any> */
type HashM<T> = Record<string, T>;

/** Vars that cannot be broken down further */
type Scalar = bigint | boolean | Date | null | number | string | undefined;

/** Not an array or set. Is imperfect bc most non-standard classes will be rejected  */
type Primitive = Scalar | Buffer | Fnc | RegExp | symbol;

/** not a Primitive, aka  */
type PrimitiveNot = Exclude<object, Primitive> | Array<anyOk>;

/** Aka plain object, can be serialized without data loss */
type Serializable =
  | Scalar
  | Serializable[]
  | [Serializable, ...Serializable[]]
  | { [key: string]: Serializable | HashM<Serializable> }
  // Note: Set and Map is one-way to array and hashmap
  | Set<Serializable>
  | Map<Serializable, Serializable>;

/** The shape of a package.json file */
interface PkgJsonFields {
  bin?: Dict;
  dependencies?: Dict;
  description?: string;
  devDependencies?: Dict;
  // exports
  exports?: {
    [glob: string]: {
      [importOrRequire: string]: {
        types: string;
        default: string;
      };
    };
  };
  files?: string[];
  main?: string;
  name: string;
  optionalDependencies?: Dict;
  peerDependencies?: Dict;
  private?: boolean;
  scripts?: {
    clean?: string;
    preinstall?: string;
    install?: string;
    postinstall?: string;
    prebuild?: string;
    build?: string;
    postbuild?: string;
    [key: string]: string;
  };
  version: string;
}
