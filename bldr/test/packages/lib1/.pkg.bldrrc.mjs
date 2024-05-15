// @ts-check

export default bldrPkgConfig({
  postBuildSourceCheckIgnores: [],
});

//
// bldr pkg config function below
//
// FIXME: types should be imported from the package
//
//

/** Used mainly to make typing better and easier by using `typeof configEmpty` */
const configPkgEmpty = Object.freeze({
  /**
   * List of log filters to apply to the build log, like to suppress distracting
   * build warnings.
   *
   * @type {string | RegExp[]}
   */
  buildLogFilters: [],
  /**
   * List of log filters to apply to the install log, like to suppress distracting
   * install warnings.
   *
   * @type {string | RegExp[]}
   */
  installLogFilters: [],
  /**
   * List of files that should be ignored in the post-build source change check.
   *
   * bldr will error if src files change post-build bc this may mean a build artifact
   * was mistakenly included in the build artifact, which can cause excessive cache
   * misses.
   *
   * Can be basenames, regex, or relative paths from the pkg root.
   *
   * Hint: can use .bldrrc.mjs for workspace wide
   * Hint: we already ignore __generated__ files by default.
   *
   * @type {string[]}
   */
  postBuildSourceCheckIgnores: [],
});

/**
 *
 * @param {Partial<typeof configPkgEmpty>} opts
 */
export function bldrPkgConfig(opts) {
  return opts;
}
