// @ts-check
// lib/shared/repo-folder.mjs - the repo-folder rule (see docs/GLOSSARY.md): may a folder inside a repo be deleted,
// deleting it after checking again, and planning such deletions across repos.

import path from 'node:path';
import { EXIT_FAILED, NUL } from './constants.mjs';
import { findNamedDirs, measure } from './discovery.mjs';
import { toPosix, trashBase, validateTarget } from './paths.mjs';
import { git } from './processes.mjs';
import { safeRemoveTree } from './remove.mjs';
import { mapPool } from './run.mjs';

/** @typedef {import('./discovery.mjs').Repo} Repo */
/** @typedef {import('./discovery.mjs').TreeInfo} TreeInfo */
/** @typedef {import('./run.mjs').PlanItem} PlanItem */
/** @typedef {import('./run.mjs').RunResult} RunResult */

/**
 * Decides whether a planned folder is kept: returns the reason to keep it, or null to delete it.
 * `fresh` is true on the re-check right before deletion, so cached values must be recomputed.
 * @typedef {(tree: TreeInfo, repo: Repo, context: { fresh: boolean }) => Promise<string | null>} KeepRule
 */

/**
 * Checks that git allows deleting `target`: no tracked file inside and, optionally, git-ignored.
 * Tracked files are matched case-insensitively, so "Dist/a.js" in the index protects a "dist" folder
 * (a case-only rename on Windows would otherwise slip through).
 * @param {string} repoReal  resolved repo folder
 * @param {string} target  folder inside the repo
 * @param {{ requireIgnored?: boolean }} [options]  false skips the git-ignore check
 * @returns {Promise<string | null>} reason it must not be deleted, or null
 */
async function gitGuard(repoReal, target, { requireIgnored = true } = {}) {
  const relativePath = toPosix(path.relative(repoReal, target));
  const tracked = await git(['-C', repoReal, 'ls-files', '-z']);

  if (!tracked.ok) {
    return 'git ls-files failed';
  }

  const prefix = `${relativePath.toLowerCase()}/`;

  if (tracked.stdout.split(NUL).some((file) => file.toLowerCase().startsWith(prefix))) {
    return 'contains files tracked by git';
  }

  if (!requireIgnored) {
    return null;
  }

  // The trailing "/" marks a folder; it also made [slug]-style names match correctly in testing (git 2.34).
  const ignored = await git(['-C', repoReal, 'check-ignore', '-q', '--', `${relativePath}/`]);

  if (ignored.code === EXIT_FAILED) {
    return 'not ignored by git';
  }

  return ignored.ok ? null : 'git check-ignore failed';
}

/**
 * Whether a repo folder (see docs/GLOSSARY.md) may be deleted or rewritten, applying every rule in
 * docs/safety-model.md "What may be deleted in a repo". A devkit leftover skips the git-ignore check and
 * `keepIf`: its new name no longer matches .gitignore, and it is already half deleted.
 * @param {string} repoReal  resolved repo folder
 * @param {string} target  folder inside the repo
 * @param {{ keepIf?: ((tree: TreeInfo) => Promise<string | null>) | null }} [options]
 *   an extra reason to keep the folder, e.g. its age
 * @returns {Promise<{ reason: string | null, tree: TreeInfo | null, leftover: boolean }>}
 *   why it must be kept (null: it may go), its contents when they were measured, and whether it is a leftover
 */
export async function checkRepoFolder(repoReal, target, { keepIf = null } = {}) {
  const leftover = trashBase(path.basename(target)) !== null;
  const blocked = (await validateTarget(repoReal, target))
    ?? (await gitGuard(repoReal, target, { requireIgnored: !leftover }));

  if (blocked) {
    return { reason: blocked, tree: null, leftover };
  }

  const tree = await measure(target);

  if (tree.hasNestedRepo) {
    return { reason: 'contains a nested git repo (left alone)', tree, leftover };
  }

  return { reason: keepIf && !leftover ? await keepIf(tree) : null, tree, leftover };
}

/**
 * Delete a repo folder after checking it again with checkRepoFolder: git state, links and age can change
 * between planning and running. Never rejects.
 * @param {string} repoReal  resolved repo folder
 * @param {string} target  folder inside the repo
 * @param {{ keepIf?: ((tree: TreeInfo) => Promise<string | null>) | null }} [options]
 *   an extra reason to keep the folder, e.g. its age
 * @returns {Promise<RunResult>} ok, or why it was kept or what went wrong
 */
export async function removeRepoFolder(repoReal, target, options = {}) {
  const { reason } = await checkRepoFolder(repoReal, target, options);

  if (reason) {
    return { ok: false, output: `${reason} (re-checked before deleting; kept)` };
  }

  return safeRemoveTree(target, repoReal);
}

/**
 * Plan deletion of allow-listed folders in one repo. Each item deletes through removeRepoFolder, which
 * checks the folder again first.
 * @param {Repo} repo  the repo to search
 * @param {readonly string[]} names  folder names to delete, e.g. [NODE_MODULES]
 * @param {{ keepIf?: KeepRule | null }} [options]  extra reason to keep a folder, e.g. its age
 * @returns {Promise<PlanItem[]>} one plan line per folder found
 */
async function planRepoDirs(repo, names, { keepIf = null } = {}) {
  /** @type {PlanItem[]} */
  const items = [];

  /**
   * The keep rule for one phase of the run.
   * @param {boolean} fresh  true right before deleting: cached values are recomputed
   * @returns {((tree: TreeInfo) => Promise<string | null>) | null} the rule, or null without one
   */
  const keepIfFor = (fresh) => keepIf && ((tree) => keepIf(tree, repo, { fresh }));

  for (const target of await findNamedDirs(repo.real, names)) {
    const planned = await checkRepoFolder(repo.real, target, { keepIf: keepIfFor(false) });

    items.push({
      name: `${repo.name}/${toPosix(path.relative(repo.real, target))}`,
      detail: planned.leftover ? 'leftover of an earlier run' : '',
      bytes: planned.tree?.bytes ?? null,
      skip: planned.reason,
      run: () => removeRepoFolder(repo.real, target, { keepIf: keepIfFor(true) }),
    });
  }

  return items;
}

/**
 * Plan deletion of allow-listed folders across repos, `jobs` repos at a time.
 * @param {Repo[]} repos  repos to search
 * @param {readonly string[]} names  folder names to delete
 * @param {{ jobs: number, keepIf?: KeepRule | null, onRepoDone?: () => void }} options
 *   parallel repos, an extra reason to keep, and a callback per planned repo, e.g. to advance the progress line
 * @returns {Promise<PlanItem[]>} plan lines of all repos
 */
export async function planFolders(repos, names, { jobs, keepIf = null, onRepoDone = () => {} }) {
  const planned = await mapPool(repos, jobs, async (repo) => {
    const items = await planRepoDirs(repo, names, { keepIf });

    onRepoDone();

    return items;
  });

  return planned.flat();
}
