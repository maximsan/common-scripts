// @ts-check
// lib/shared/paths.mjs - comparing paths, and checking that a path is a plain folder with no link on the way.

import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { GIT_FOLDER, TRASH_TAG } from './constants.mjs';
import { HOST_RULES } from './platform.mjs';

/** @typedef {import('./platform.mjs').PlatformRules} PlatformRules */

const TRASH_STAMP = /^\d{13}$/;

/**
 * Absolute form of a path, lower-cased where the system ignores letter case.
 * @param {string} anyPath  relative or absolute path
 * @param {PlatformRules} rules  the system's rules
 * @returns {string} the path ready for comparing
 */
function normalize(anyPath, rules) {
  const resolved = rules.paths.resolve(anyPath);

  return rules.ignoreCase ? resolved.toLowerCase() : resolved;
}

/**
 * True when two paths name the same place after resolving.
 * @param {string} first  one path
 * @param {string} second  the other path
 * @param {PlatformRules} [rules]  the system's rules
 * @returns {boolean} whether they are the same
 */
export const samePath = (first, second, rules = HOST_RULES) => normalize(first, rules) === normalize(second, rules);

/**
 * True if anything (file, folder or link) exists at a path.
 * @param {string} target  path to look at
 * @returns {Promise<boolean>} whether something is there
 */
export const exists = (target) => lstat(target).then(() => true, () => false);

/**
 * Forward-slash form of a relative path, as git and the output use it.
 * @param {string} relativePath  path with the platform's separators
 * @returns {string} the path with "/" separators
 */
export const toPosix = (relativePath) => relativePath.split(path.sep).join('/');

/**
 * Real path when it can be resolved (expands 8.3 names and junctions), otherwise the plain absolute path.
 * @param {string} target  path that may not exist
 * @returns {Promise<string>} the resolved path
 */
export const realpathOrResolve = (target) => realpath(target).catch(() => path.resolve(target));

/**
 * True when `child` is strictly inside `parent`.
 * @param {string} parent  the outer folder
 * @param {string} child  the path to test
 * @param {PlatformRules} [rules]  the system's rules
 * @returns {boolean} whether `child` is below `parent`
 */
export function isInside(parent, child, rules = HOST_RULES) {
  const { relative, sep, isAbsolute } = rules.paths;
  const relativePath = relative(normalize(parent, rules), normalize(child, rules));

  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath);
}

/**
 * True when `child` is `folder` itself or inside it.
 * @param {string} folder  the outer folder
 * @param {string} child  the path to test
 * @param {PlatformRules} [rules]  the system's rules
 * @returns {boolean} whether `child` is `folder` or below it
 */
export const isAtOrInside = (folder, child, rules = HOST_RULES) => samePath(folder, child, rules)
  || isInside(folder, child, rules);

/**
 * Original name of a folder that devkit renamed for deletion, e.g.
 * "node_modules.devkit-deleting-1712345678901" -> "node_modules".
 * @param {string} name  a folder name
 * @returns {string | null} the original name, or null for any other name
 */
export function trashBase(name) {
  const tagStart = name.indexOf(TRASH_TAG);

  if (tagStart <= 0 || !TRASH_STAMP.test(name.slice(tagStart + TRASH_TAG.length))) {
    return null;
  }

  return name.slice(0, tagStart);
}

/**
 * Checks that `target` is a plain folder strictly inside `boundaryReal`, with no link anywhere on its path.
 * @param {string} boundaryReal  resolved folder the target must be inside
 * @param {string} target  folder to check
 * @returns {Promise<string | null>} reason it must not be deleted, or null
 */
export async function validateTarget(boundaryReal, target) {
  let info;

  try {
    info = await lstat(target);
  } catch {
    return 'no longer exists';
  }

  if (info.isSymbolicLink()) {
    return 'is a symlink/junction (left alone)';
  }

  if (!info.isDirectory()) {
    return 'is not a folder';
  }

  let real;

  try {
    real = await realpath(target);
  } catch {
    return 'cannot resolve path';
  }

  if (!samePath(real, target)) {
    return 'path goes through a link (left alone)';
  }

  if (!isInside(boundaryReal, real)) {
    return 'outside the allowed folder';
  }

  if (path.relative(boundaryReal, real).split(path.sep).includes(GIT_FOLDER)) {
    return 'inside .git';
  }

  return null;
}
