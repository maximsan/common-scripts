// @ts-check
// lib/shared/temp-entry.mjs - the temp-entry rule (see GLOSSARY.md): may a file or folder directly inside the
// temp folder be deleted, and deleting it after checking again.

import { lstat } from 'node:fs/promises';
import { measure } from './discovery.mjs';
import { errorCode, errorText } from './errors.mjs';
import { isInside, validateTarget } from './paths.mjs';
import { HOST_RULES } from './platform.mjs';
import { safeRemoveFile, safeRemoveTree } from './remove.mjs';

/** @typedef {import('./discovery.mjs').TreeInfo} TreeInfo */
/** @typedef {import('./run.mjs').RunResult} RunResult */

/**
 * True when the current user owns the entry. On a shared temp folder (Linux /tmp) other users' entries
 * are kept. Windows reports no owner here; its temp folder is per user anyway.
 * @param {import('node:fs').Stats} info  the entry's lstat result
 * @returns {boolean} whether it may be deleted on ownership grounds
 */
const ownedByMe = (info) => !HOST_RULES.fileOwners || info.uid === process.getuid?.();

/**
 * The keep reason for something last changed at `mtimeMs`.
 * @param {number} mtimeMs  newest change
 * @param {number} cutoffMs  changes at or after this time keep it
 * @returns {string | null} why it is kept, or null when it is old enough
 */
const changedSince = (mtimeMs, cutoffMs) => (mtimeMs >= cutoffMs ? 'changed recently' : null);

/**
 * Why a temp folder must be kept, or null when it may be deleted.
 * - A nested repo: deleting it fails on its .git folder and leaves a leftover that fails on every run.
 * - A special file, such as a socket: a running program talks through it. Its date does not change while it
 *   is used, so an old date does not mean the folder is unused. Example: a browser's SingletonSocket, or
 *   ssh-agent's socket on Linux.
 * - Otherwise: something in it changed recently.
 * @param {TreeInfo} tree  what measure found in the folder
 * @param {number} cutoffMs  changes at or after this time keep it
 * @returns {string | null} why it is kept, or null when it may be deleted
 */
function tempFolderReason(tree, cutoffMs) {
  if (tree.hasNestedRepo) {
    return 'contains a nested git repo (left alone)';
  }

  if (tree.hasSpecialFile) {
    return 'contains a socket or other special file (left alone)';
  }

  return changedSince(tree.newest, cutoffMs);
}

/**
 * Whether a temp entry (see GLOSSARY.md) may be deleted, applying every rule in README "Temp folder": it is
 * a file or a folder, not a link, yours, holds no nested repo or special file, and nothing in it changed at
 * or after `cutoffMs`. Never rejects.
 * @param {string} tempReal  resolved temp folder
 * @param {string} entry  file or folder directly inside it
 * @param {number} cutoffMs  the entry is kept if anything in it changed at or after this time
 * @returns {Promise<{ reason: string | null, bytes: number | null, isFolder: boolean }>}
 *   why it must be kept (null: it may go), its size, and whether it is a folder
 */
export async function checkTempEntry(tempReal, entry, cutoffMs) {
  /**
   * The result for an entry that must be kept.
   * @param {string} reason  why it is kept
   * @returns {{ reason: string, bytes: null, isFolder: boolean }} the result
   */
  const kept = (reason) => ({ reason, bytes: null, isFolder: false });

  try {
    const info = await lstat(entry);

    if (info.isSymbolicLink()) {
      return kept('is a symlink/junction (left alone)');
    }

    if (!ownedByMe(info)) {
      return kept('belongs to another user');
    }

    const isFolder = info.isDirectory();

    if (!isFolder && !info.isFile()) {
      return kept('is not a file or folder');
    }

    if (!isFolder) {
      const reason = isInside(tempReal, entry) ? changedSince(info.mtimeMs, cutoffMs) : 'outside the allowed folder';

      return { reason, bytes: info.size, isFolder };
    }

    const problem = await validateTarget(tempReal, entry);

    if (problem) {
      return kept(problem);
    }

    const tree = await measure(entry);

    return { reason: tempFolderReason(tree, cutoffMs), bytes: tree.bytes, isFolder };
  } catch (err) {
    return kept(errorCode(err) === 'ENOENT' ? 'no longer exists' : errorText(err));
  }
}

/**
 * Delete a temp entry after checking it again with checkTempEntry: it may have changed, or been replaced by
 * a link, since planning. Never rejects.
 * @param {string} tempReal  resolved temp folder
 * @param {string} entry  file or folder directly inside it
 * @param {number} cutoffMs  the entry is kept if anything in it changed at or after this time
 * @returns {Promise<RunResult>} ok, or why it was kept or what went wrong
 */
export async function removeTempEntry(tempReal, entry, cutoffMs) {
  const { reason, isFolder } = await checkTempEntry(tempReal, entry, cutoffMs);

  if (reason) {
    return { ok: false, output: `${reason} (re-checked before deleting; kept)` };
  }

  return isFolder ? safeRemoveTree(entry, tempReal) : safeRemoveFile(entry);
}
