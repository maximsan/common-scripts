// @ts-check
// lib/shared/index.mjs - the shared code's interface for the commands in lib/commands/ (all except gpall).
// Commands import from here only; the implementation lives in the other files of lib/shared/, one file per area.
// Runs on Windows, macOS and Linux. Node 18+, no dependencies.
// The safety model the core implements is described once, in README.md ("Safety model").

export {
  DAY_MS, DEFAULT_JOBS, EXIT_OK, GIT_FOLDER, LINE_BREAK, NODE_MODULES, NUL, PACKAGE_JSON, TEXT_ENCODING,
  YARN_BERRY_MAJOR,
} from './constants.mjs';
export { SafetyError, errorCode } from './errors.mjs';
export { exists, toPosix } from './paths.mjs';
export { assertSafeRoot, resolveTempDir } from './safe-root.mjs';
export { git, lastLine, runShell, yarnMajor } from './processes.mjs';
export { findPackageFiles, findRepos, measure } from './discovery.mjs';
export { checkRepoFolder, planFolders, removeRepoFolder } from './repo-folder.mjs';
export { checkTempEntry, removeTempEntry } from './temp-entry.mjs';
export { ageInDays, formatBytes } from './format.mjs';
export { mapPool, planAndRun, skippedItem } from './run.mjs';
export { readState, writeState } from './state.mjs';
export { parseArgs, runCommand } from './cli.mjs';

/** @typedef {import('./run.mjs').BaseOptions} BaseOptions */
/** @typedef {import('./repo-folder.mjs').KeepRule} KeepRule */
/** @typedef {import('./run.mjs').PlanItem} PlanItem */
/** @typedef {import('./run.mjs').PlanSection} PlanSection */
/** @typedef {import('./discovery.mjs').Repo} Repo */
/** @typedef {import('./state.mjs').RunContext} RunContext */
/** @typedef {import('./run.mjs').RunResult} RunResult */
