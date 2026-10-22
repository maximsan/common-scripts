// @ts-check
// lib/shared/discovery.mjs - finding repos, package folders and files, and measuring folder trees. Never follows links.

import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { GIT_FOLDER, NODE_MODULES, PACKAGE_JSON } from './constants.mjs';
import { exists, isInside, realpathOrResolve, trashBase, validateTarget } from './paths.mjs';
import { assertSafeRoot } from './safe-root.mjs';

/** @typedef {import('./state.mjs').RunContext} RunContext */

/** @typedef {{ name: string, real: string }} Repo  a repo folder name and its resolved path */

/**
 * What measure found in a tree. `hasSpecialFile` marks an entry that is neither a file, a folder nor a link,
 * such as a socket a running program listens on.
 * @typedef {{
 *   bytes: number, files: number, newest: number, truncated: boolean, hasNestedRepo: boolean,
 *   hasSpecialFile: boolean,
 * }} TreeInfo
 */

const MAX_SEARCH_DEPTH = 6;

/**
 * Direct subfolders of `rootReal` that contain .git and really live inside it.
 * @param {string} rootReal  resolved folder holding the repos
 * @returns {Promise<Repo[]>} sorted by name
 */
export async function findRepos(rootReal) {
  /** @type {Repo[]} */
  const repos = [];

  for (const entry of await readdir(rootReal, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }

    const dir = path.join(rootReal, entry.name);

    if (!(await exists(path.join(dir, GIT_FOLDER)))) {
      continue;
    }

    const real = await realpathOrResolve(dir);

    if (isInside(rootReal, real)) {
      repos.push({ name: entry.name, real });
    }
  }

  return repos.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The start of every command that works on repos: refuse an unsafe current folder, then find its repos.
 * @param {RunContext} context  the current folder and environment
 * @returns {Promise<{ root: string, repos: Repo[] }>} the resolved current folder and the repos in it
 */
export async function findReposHere(context) {
  const root = await assertSafeRoot(context.cwd, { home: context.home, env: context.env });

  context.progress.start('Finding repos');

  return { root, repos: await findRepos(root) };
}

/**
 * Visit a repo's folders breadth-first, starting with the repo folder itself. Never follows links and
 * never enters dot-folders (.venv, .yarn, .next, ...), node_modules, devkit leftovers or nested repos.
 * @param {string} repoReal  resolved repo folder
 * @param {(dir: string, entries: import('node:fs').Dirent[]) => Set<string>} visit
 *   called once per folder with its entries; returns the names of subfolders not to enter
 */
async function walkRepo(repoReal, visit) {
  const queue = [{ dir: repoReal, depth: 0 }];

  for (let next = queue.shift(); next; next = queue.shift()) {
    const { dir, depth } = next;
    let entries;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const handled = visit(dir, entries);

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || handled.has(entry.name)) {
        continue;
      }

      const full = path.join(dir, entry.name);
      const descend = !entry.name.startsWith('.')
        && entry.name !== NODE_MODULES
        && trashBase(entry.name) === null
        && depth + 1 < MAX_SEARCH_DEPTH
        && !(await exists(path.join(full, GIT_FOLDER)))
        && (await validateTarget(repoReal, full)) === null;

      if (descend) {
        queue.push({ dir: full, depth: depth + 1 });
      }
    }
  }
}

/**
 * True when a folder's entries include a package.json file.
 * @param {import('node:fs').Dirent[]} entries  the folder's entries
 * @returns {boolean} whether the folder is a Node package
 */
const isPackageFolder = (entries) => entries.some((entry) => entry.name === PACKAGE_JSON && entry.isFile());

/**
 * Folders in a repo named in `names` (or devkit leftovers of them) that sit next to a package.json.
 * Searches the folders that walkRepo visits.
 * @param {string} repoReal  resolved repo folder
 * @param {readonly string[]} names  folder names to look for
 * @returns {Promise<string[]>} sorted absolute paths
 */
export async function findNamedDirs(repoReal, names) {
  const wanted = new Set(names);

  /** @type {string[]} */
  const found = [];

  await walkRepo(repoReal, (dir, entries) => {
    const matches = entries.filter((entry) => {
      const base = trashBase(entry.name);

      return entry.isDirectory()
        && !entry.isSymbolicLink()
        && (wanted.has(entry.name) || (base !== null && wanted.has(base)));
    });

    if (isPackageFolder(entries)) {
      found.push(...matches.map((entry) => path.join(dir, entry.name)));
    }

    return new Set(matches.map((entry) => entry.name));
  });

  return found.sort();
}

/**
 * Entries named `fileName` in the repo folder and in every package folder (one with a package.json) below
 * it. Searches the folders that walkRepo visits. Links are returned too, so the caller can report them.
 * @param {string} repoReal  resolved repo folder
 * @param {string} fileName  e.g. ".npmrc"
 * @returns {Promise<string[]>} sorted absolute paths
 */
export async function findPackageFiles(repoReal, fileName) {
  /** @type {string[]} */
  const found = [];

  await walkRepo(repoReal, (dir, entries) => {
    const inPackage = dir === repoReal || isPackageFolder(entries);

    if (inPackage && entries.some((entry) => entry.name === fileName && !entry.isDirectory())) {
      found.push(path.join(dir, fileName));
    }

    return new Set();
  });

  return found.sort();
}

/**
 * Size, file count and newest mtime of a tree, and whether a nested repo (.git) or a special file is inside.
 * Never follows links.
 * @param {string} dir  folder to measure
 * @param {{ skipNames?: Set<string>, maxFiles?: number }} [options]  names to skip; stop early after maxFiles
 * @returns {Promise<TreeInfo>} the totals; `truncated` is true when it stopped early
 */
export async function measure(dir, { skipNames = new Set(), maxFiles = Infinity } = {}) {
  /** @type {TreeInfo} */
  const tree = {
    bytes: 0, files: 0, newest: (await lstat(dir)).mtimeMs, truncated: false, hasNestedRepo: false,
    hasSpecialFile: false,
  };
  const stack = [dir];

  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    const listed = await readdir(current).catch(() => []);
    const names = listed.filter((name) => !skipNames.has(name) && !trashBase(name));

    tree.hasNestedRepo ||= names.includes(GIT_FOLDER);

    // A folder's entries are read together: one at a time, the wait per file adds up, most of all on Windows.
    const infos = await Promise.all(names.map((name) => lstat(path.join(current, name)).catch(() => null)));

    for (const [index, info] of infos.entries()) {
      if (!info) {
        continue;
      }

      tree.newest = Math.max(tree.newest, info.mtimeMs);

      if (info.isSymbolicLink()) {
        continue;
      }

      if (info.isDirectory()) {
        stack.push(path.join(current, names[index]));
      } else {
        tree.bytes += info.size;
        tree.files += 1;
        tree.hasSpecialFile ||= !info.isFile();
      }

      if (tree.files >= maxFiles) {
        return { ...tree, truncated: true };
      }
    }
  }

  return tree;
}

/**
 * Whether a nested repo (.git) or a special file is inside a tree, from the folder listings: faster than
 * measure, which reads every file's details. Folders and entries of unclear type are still checked with
 * lstat, so a link is never entered, even where a listing reports a junction as a folder. Never follows links.
 * @param {string} dir  folder to scan
 * @returns {Promise<Pick<TreeInfo, 'hasNestedRepo' | 'hasSpecialFile'>>} what the tree holds
 */
export async function scanTree(dir) {
  const found = { hasNestedRepo: false, hasSpecialFile: false };
  const stack = [dir];

  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    const listed = await readdir(current, { withFileTypes: true }).catch(() => []);
    const entries = listed.filter((entry) => !trashBase(entry.name));

    found.hasNestedRepo ||= entries.some((entry) => entry.name === GIT_FOLDER);

    const unclear = entries.filter((entry) => !entry.isFile() && !entry.isSymbolicLink());
    const infos = await Promise.all(unclear.map((entry) => lstat(path.join(current, entry.name)).catch(() => null)));

    for (const [index, info] of infos.entries()) {
      if (info?.isDirectory()) {
        stack.push(path.join(current, unclear[index].name));
      } else if (info && !info.isSymbolicLink()) {
        found.hasSpecialFile ||= !info.isFile();
      }
    }
  }

  return found;
}
