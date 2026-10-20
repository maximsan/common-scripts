// @ts-check
// devkit-core.mjs - the shared code's interface for nmclean.mjs, nminstall.mjs, devclean.mjs and npmrctoken.mjs.
// Scripts import from here only; the implementation lives in core/, one file per area.
// Runs on Windows, macOS and Linux. Node 18+, no dependencies.
// The safety model the core implements is described once, in README.md ("Safety model").

export {
  DAY_MS, DEFAULT_JOBS, EXIT_OK, GIT_FOLDER, LINE_BREAK, NODE_MODULES, NUL, PACKAGE_JSON, TEXT_ENCODING,
  YARN_BERRY_MAJOR,
} from './core/constants.mjs';
export { SafetyError, errorCode } from './core/errors.mjs';
export { HOST_RULES } from './core/platform.mjs';
export { assertSafeRoot, exists, resolveTempDir, toPosix } from './core/paths.mjs';
export { git, lastLine, runShell, yarnMajor } from './core/processes.mjs';
export { findPackageFiles, findRepos, measure } from './core/discovery.mjs';
export { checkRepoFolder, checkTempEntry, removeRepoFolder, removeTempEntry } from './core/deletion.mjs';
export { ageInDays, formatBytes, mapPool, planAndRun, planFolders, skippedItem } from './core/run.mjs';
export { readState, writeState } from './core/state.mjs';
export { parseArgs, runMain } from './core/cli.mjs';

/** @typedef {import('./core/run.mjs').BaseOptions} BaseOptions */
/** @typedef {import('./core/run.mjs').KeepRule} KeepRule */
/** @typedef {import('./core/run.mjs').PlanItem} PlanItem */
/** @typedef {import('./core/run.mjs').PlanSection} PlanSection */
/** @typedef {import('./core/discovery.mjs').Repo} Repo */
/** @typedef {import('./core/state.mjs').RunContext} RunContext */
/** @typedef {import('./core/run.mjs').RunResult} RunResult */
