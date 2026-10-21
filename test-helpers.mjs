// @ts-check
// test-helpers.mjs - fixtures shared by the devkit tests: real git repos and files in a temp folder.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAY_MS } from './devkit-core.mjs';

const GIT_IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
const DEFAULT_IGNORE = 'node_modules/\ndist/\n';
const DEFAULT_CONTENT = 'x';
const TEXT_ENCODING = 'utf8';
const HERE = dirname(fileURLToPath(import.meta.url));

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
 * A temp folder for one test file. Returned as a real path, like the scripts' own roots:
 * on macOS the temp folder sits behind the /var -> /private/var link.
 * @param {string} prefix  start of the folder name
 * @returns {{ root: string, cleanup: () => void }} the folder, and a function that deletes it
 */
export function tempWorkspace(prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));

  return {
    root,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
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

/**
 * Absolute path of a script next to this file.
 * @param {string} script  file name, e.g. "nmclean.mjs"
 * @returns {string} the absolute path
 */
export const scriptPath = (script) => join(HERE, script);

/**
 * Run one of the scripts as a child process, with its state (lock, logs) in `stateDir`.
 * @param {string} script  e.g. "nmclean.mjs", or an absolute path
 * @param {string[]} args  command-line arguments
 * @param {{ cwd: string, stateDir: string, env?: Record<string, string> }} options
 *   the folder to run in, where state goes, and extra environment variables
 * @returns {import('node:child_process').SpawnSyncReturns<string>} exit status and output
 */
export function runScript(script, args, { cwd, stateDir, env = {} }) {
  return spawnSync(process.execPath, [isAbsolute(script) ? script : scriptPath(script), ...args], {
    cwd,
    encoding: TEXT_ENCODING,
    env: { ...process.env, LOCALAPPDATA: stateDir, ...env },
  });
}

/**
 * A run context for calling a script's main in-process: printed lines are collected, and every
 * confirmation gets the same answer. LOCALAPPDATA points at `stateDir`, as in runScript: on Windows the
 * test folders sit in the system temp folder inside the real LOCALAPPDATA, where the scripts refuse to run.
 * @param {{ cwd: string, stateDir: string, tempDir?: string, answer?: boolean }} options
 *   the folder to run in, where state goes, the temp folder, and the answer to "continue?"
 * @returns {{ context: import('./devkit-core.mjs').RunContext, output: () => string }}
 *   the context, and everything printed so far as one text
 */
export function testContext({ cwd, stateDir, tempDir = tmpdir(), answer = true }) {
  /** @type {string[]} */
  const lines = [];
  const context = {
    cwd,
    env: { ...process.env, LOCALAPPDATA: stateDir },
    stateDir,
    tempDir,
    print: (line = '') => {
      lines.push(line);
    },
    confirm: async () => answer,
  };

  return { context, output: () => lines.join('\n') };
}
