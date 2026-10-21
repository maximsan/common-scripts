// @ts-check
// lib/shared/remove.mjs - deleting files and folder trees without ever following links.

import { chmod, lstat, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { TRASH_TAG } from './constants.mjs';
import { errorCode, errorText } from './errors.mjs';
import { trashBase, validateTarget } from './paths.mjs';
import { HOST_RULES } from './platform.mjs';

/** @typedef {import('./run.mjs').RunResult} RunResult */

const MAX_ERRORS_SHOWN = 5;
const DIRECTORY_LINK_CODES = ['EPERM', 'EISDIR', 'EACCES']; // unlink refused: it is a directory link, use rmdir
const READ_ONLY_CODES = ['EPERM', 'EACCES'];
const IN_USE_CODES = ['EBUSY', 'EPERM'];
const WRITABLE_FILE_MODE = 0o666;

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
 * Remove a file, clearing the read-only attribute first where that blocks deletion (see the platform rules).
 * @param {string} file  path of the file
 */
async function removeFile(file) {
  try {
    await unlink(file);
  } catch (err) {
    if (!HOST_RULES.readOnlyBlocksDelete || !READ_ONLY_CODES.includes(errorCode(err) ?? '')) {
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
 * Delete one file. Never rejects.
 * @param {string} file  path of the file
 * @returns {Promise<RunResult>} ok, or "in use", or what went wrong
 */
export async function safeRemoveFile(file) {
  try {
    await removeFile(file);

    return { ok: true, output: '' };
  } catch (err) {
    return { ok: false, output: IN_USE_CODES.includes(errorCode(err) ?? '') ? 'in use' : errorText(err) };
  }
}
