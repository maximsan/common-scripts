// @ts-check
// tests/utils.mjs - test material: files, real git repos, links and file dates.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DAY_MS } from '../lib/shared/index.mjs';

const GIT_IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
const DEFAULT_IGNORE = 'node_modules/\ndist/\n';
const DEFAULT_CONTENT = 'x';

/**
 * Run git in `cwd` with a fixed identity.
 * @param {string} cwd  the repo folder
 * @param {...string} args  git arguments
 * @returns {Buffer} git's standard output
 */
export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...GIT_IDENTITY, ...args], { stdio: 'pipe' });

/**
 * Write a file, creating parent folders.
 * @param {string} file  path of the file
 * @param {string} [content]  text to write
 */
export function write(file, content = DEFAULT_CONTENT) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/**
 * Set a file's or folder's mtime to `days` ago.
 * @param {string} target  file or folder
 * @param {number} days  how far back
 */
export function backdate(target, days) {
  const time = new Date(Date.now() - days * DAY_MS);

  utimesSync(target, time, time);
}

/**
 * Create a git repo (a Node project: package.json, .gitignore, index.js), all committed.
 * @param {string} parent  folder to create the repo in
 * @param {string} name  the repo's folder name
 * @param {{ ignore?: string }} [options]  content of .gitignore
 * @returns {string} repo path
 */
export function makeRepo(parent, name, { ignore = DEFAULT_IGNORE } = {}) {
  const dir = join(parent, name);

  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  write(join(dir, '.gitignore'), ignore);
  write(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  write(join(dir, 'index.js'), 'console.log(1)\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');

  return dir;
}

/**
 * Link a folder: a junction on Windows, where it needs no extra rights, and a symlink elsewhere, where Node
 * ignores the type. On Windows the tests then cover the junctions that npm and pnpm create.
 * @param {string} target  absolute path of the folder to link to
 * @param {string} link  path of the new link
 */
export const linkFolder = (target, link) => {
  symlinkSync(target, link, 'junction');
};

/**
 * Why tests that need a file symlink are skipped, or false when this machine allows one. Windows allows
 * file symlinks only with Developer Mode or administrator rights.
 * @type {string | false}
 */
export const FILE_LINK_SKIP = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'devkit-link-probe-'));

  try {
    writeFileSync(join(dir, 'file'), '');
    symlinkSync(join(dir, 'file'), join(dir, 'link'));

    return false;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EPERM') {
      throw err;
    }

    return 'file symlinks need Developer Mode or administrator rights on this machine';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
