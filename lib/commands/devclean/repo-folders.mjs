// @ts-check
// lib/commands/devclean/repo-folders.mjs - the node_modules and build sections: repo folders (see docs/GLOSSARY.md)
// that are old enough to delete.

import {
  ageInDays, DEFAULT_JOBS, GIT_FOLDER, measure, NODE_MODULES, planFolders,
} from '../../shared/index.mjs';

/** @typedef {import('../../shared/index.mjs').KeepRule} KeepRule */
/** @typedef {import('../../shared/index.mjs').PlanItem} PlanItem */
/** @typedef {import('../../shared/index.mjs').Repo} Repo */

export const BUILD_DIRS = Object.freeze(['.next', '.turbo', '.parcel-cache', 'coverage', 'dist', 'build']);

// A bigger working tree is treated as active (kept).
const ACTIVITY_MAX_FILES = 200_000;

/**
 * Newest file change in a repo's working tree; node_modules, .git and build outputs are ignored.
 * @param {Repo} repo  the repo to look at
 * @returns {Promise<number>} mtime in ms; the current time when the tree is too big to scan
 */
async function repoActivity(repo) {
  const skipNames = new Set([NODE_MODULES, GIT_FOLDER, ...BUILD_DIRS]);
  const tree = await measure(repo.real, { skipNames, maxFiles: ACTIVITY_MAX_FILES });

  return tree.truncated ? Date.now() : tree.newest;
}

/**
 * node_modules in repos whose working tree has not changed for `staleDays`.
 * @param {Repo[]} repos  repos to search
 * @param {{ staleDays: number, jobs?: number, now?: number }} options
 *   days without a change, parallel repos, and the time to measure ages from
 * @returns {Promise<PlanItem[]>} one plan line per node_modules found
 */
export function planStaleNodeModules(repos, { staleDays, jobs = DEFAULT_JOBS, now = Date.now() }) {
  /** @type {Map<string, number>} */
  const activity = new Map();

  /**
   * Keep node_modules of a repo that changed recently.
   * @type {KeepRule}
   */
  const keepIfActive = async (_tree, repo, { fresh }) => {
    const cached = activity.get(repo.name);
    const changed = fresh || cached === undefined ? await repoActivity(repo) : cached;

    activity.set(repo.name, changed);

    const days = ageInDays(changed, now);

    return days < staleDays ? `repo changed ${days} day(s) ago (< ${staleDays})` : null;
  };

  return planFolders(repos, [NODE_MODULES], { jobs, keepIf: keepIfActive });
}

/**
 * Git-ignored build output folders not rebuilt for `buildDays`.
 * @param {Repo[]} repos  repos to search
 * @param {{ buildDays: number, jobs?: number, now?: number }} options
 *   days without a rebuild, parallel repos, and the time to measure ages from
 * @returns {Promise<PlanItem[]>} one plan line per build folder found
 */
export function planBuildOutputs(repos, { buildDays, jobs = DEFAULT_JOBS, now = Date.now() }) {
  /**
   * Keep a build folder that was rebuilt recently.
   * @type {KeepRule}
   */
  const keepIfRecent = async (tree) => {
    const days = ageInDays(tree.newest, now);

    return days < buildDays ? `built ${days} day(s) ago (< ${buildDays})` : null;
  };

  return planFolders(repos, BUILD_DIRS, { jobs, keepIf: keepIfRecent });
}
