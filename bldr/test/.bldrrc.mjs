// @ts-check

export default bldrConfig({});

//
// bldr config function below
//
// FIXME: types should be imported from the package
//
//

/** Used mainly to make typing better and easier by using `typeof configEmpty` */
const configEmpty = Object.freeze({
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
   * Can be basenames, regex, or relative paths from the pkg roots.
   *
   * Hint: can use .pkg.bldrrc.mjs for project-specific ignores.
   * Hint: we already ignore __generated__ files by default.
   *
   * @type {string[]}
   */
  postBuildSourceCheckIgnores: [],
});

/**
 *
 * @param {Partial<typeof configEmpty>} opts
 */
export function bldrConfig(opts) {
  return opts;
}
