// @ts-check
// core/deletion.mjs - deleting folders and files without following links, and the repo-folder rule.

import { chmod, lstat, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { EXIT_FAILED, NUL, TRASH_TAG } from './constants.mjs';
import { measure } from './discovery.mjs';
import { errorCode, errorText } from './errors.mjs';
import { isInside, toPosix, trashBase, validateTarget } from './paths.mjs';
import { git } from './processes.mjs';

/** @typedef {import('./discovery.mjs').TreeInfo} TreeInfo */
/** @typedef {import('./run.mjs').RunResult} RunResult */

const MAX_ERRORS_SHOWN = 5;
const DIRECTORY_LINK_CODES = ['EPERM', 'EISDIR', 'EACCES']; // unlink refused: it is a directory link, use rmdir
const READ_ONLY_CODES = ['EPERM', 'EACCES'];
const IN_USE_CODES = ['EBUSY', 'EPERM'];
const WRITABLE_FILE_MODE = 0o666;

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
 * Remove a link itself, never its target.
 * @param {string} link  path of the symlink or junction
 */
async function removeLink(link) {
  try {
    await unlink(link);
  } catch (err) {
    if (!DIRECTORY_LINK_CODES.includes(errorCode(err) ?? '')) {
      throw err;
    }

    await rmdir(link); // non-recursive: removes only the directory link
  }
}

/**
 * Remove a file, clearing the read-only attribute if needed.
 * @param {string} file  path of the file
 */
async function removeFile(file) {
  try {
    await unlink(file);
  } catch (err) {
    if (!READ_ONLY_CODES.includes(errorCode(err) ?? '')) {
      throw err;
    }

    await chmod(file, WRITABLE_FILE_MODE);
    await unlink(file);
  }
}

/**
 * Empty `dir` depth-first, collecting errors instead of stopping.
 * @param {string} dir  folder to empty
 * @param {string} rootPath  the folder being deleted; nothing outside it is entered
 * @param {string[]} errors  receives one line per failure
 */
async function removeContents(dir, rootPath, errors) {
  let names;

  try {
    names = await readdir(dir);
  } catch (err) {
    errors.push(`${dir}: ${errorText(err)}`);

    return;
  }

  for (const name of names) {
    const full = path.join(dir, name);

    try {
      const info = await lstat(full);

      if (info.isSymbolicLink()) {
        await removeLink(full);
      } else if (!info.isDirectory()) {
        await removeFile(full);
      } else if ((await validateTarget(rootPath, full)) !== null) {
        // another kind of reparse point: never descend
        await removeLink(full);
      } else {
        await removeContents(full, rootPath, errors);
        await rmdir(full);
      }
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') {
        errors.push(`${full}: ${errorText(err)}`);
      }
    }
  }
}

/**
 * Delete a folder tree inside `boundaryReal` without ever following links. Never rejects.
 * The folder is renamed first; if the rename is refused (typically a file in use) nothing is deleted.
 * @param {string} target  folder to delete
 * @param {string} boundaryReal  resolved folder the target must be inside
 * @returns {Promise<RunResult>} ok, or what went wrong
 */
export async function safeRemoveTree(target, boundaryReal) {
  const problem = await validateTarget(boundaryReal, target);

  if (problem) {
    return { ok: false, output: problem };
  }

  let work = target;

  if (!trashBase(path.basename(target))) {
    work = `${target}${TRASH_TAG}${Date.now()}`;

    try {
      await rename(target, work);
    } catch (err) {
      return {
        ok: false,
        output: `could not start (${errorText(err)}); a file is probably in use: `
          + 'close editors, dev servers and terminals using it, then retry',
      };
    }
  }

  const afterRename = await validateTarget(boundaryReal, work); // a link swapped in after the rename stops here

  if (afterRename) {
    return { ok: false, output: `renamed to ${path.basename(work)} but ${afterRename}; nothing deleted` };
  }

  /** @type {string[]} */
  const errors = [];

  await removeContents(work, path.resolve(work), errors);

  try {
    await rmdir(work);
  } catch (err) {
    if (!errors.length) {
      errors.push(`${work}: ${errorText(err)}`);
    }
  }

  if (!errors.length) {
    return { ok: true, output: '' };
  }

  const header = `partly removed; ${path.basename(work)} is retried on the next run`;

  return { ok: false, output: [header, ...errors.slice(0, MAX_ERRORS_SHOWN)].join('\n') };
}

/**
 * Delete one file inside `boundaryReal` if it is still older than `cutoffMs`. Never rejects.
 * @param {string} file  file to delete
 * @param {string} boundaryReal  resolved folder the file must be inside
 * @param {number} cutoffMs  the file is kept if modified at or after this time
 * @returns {Promise<RunResult>} ok, or why it was kept
 */
export async function safeRemoveOldFile(file, boundaryReal, cutoffMs) {
  try {
    const info = await lstat(file);

    if (info.isSymbolicLink() || !info.isFile()) {
      return { ok: false, output: 'changed since planning (kept)' };
    }

    if (info.mtimeMs >= cutoffMs) {
      return { ok: false, output: 'modified since planning (kept)' };
    }

    if (!isInside(boundaryReal, file)) {
      return { ok: false, output: 'outside the allowed folder' };
    }

    await removeFile(file);

    return { ok: true, output: '' };
  } catch (err) {
    return { ok: false, output: IN_USE_CODES.includes(errorCode(err) ?? '') ? 'in use' : errorText(err) };
  }
}

/**
 * Whether a repo folder (see GLOSSARY.md) may be deleted or rewritten, applying every rule in README
 * "What may be deleted in a repo". A devkit leftover skips the git-ignore check and `keepIf`: its new
 * name no longer matches .gitignore, and it is already half deleted.
 * @param {string} repoReal  resolved repo folder
 * @param {string} target  folder inside the repo
 * @param {{ keepIf?: ((tree: TreeInfo) => Promise<string | null>) | null }} [options]
 *   an extra reason to keep the folder, e.g. its age
 * @returns {Promise<{ reason: string | null, tree: TreeInfo | null }>}
 *   why it must be kept (null: it may go), and its contents when they were measured
 */
export async function checkRepoFolder(repoReal, target, { keepIf = null } = {}) {
  const leftover = trashBase(path.basename(target)) !== null;
  const blocked = (await validateTarget(repoReal, target))
    ?? (await gitGuard(repoReal, target, { requireIgnored: !leftover }));

  if (blocked) {
    return { reason: blocked, tree: null };
  }

  const tree = await measure(target);

  if (tree.hasNestedRepo) {
    return { reason: 'contains a nested git repo (left alone)', tree };
  }

  return { reason: keepIf && !leftover ? await keepIf(tree) : null, tree };
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
