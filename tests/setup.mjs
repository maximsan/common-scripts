// @ts-check
// tests/setup.mjs - what a test run needs around it: a temp work folder, a run context for calling a
// command in-process, and starting index.mjs as a separate process.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT_ENCODING = 'utf8';

/** Absolute path of the entry point, index.mjs at the repo root. */
export const INDEX_PATH = fileURLToPath(new URL('../index.mjs', import.meta.url));

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
 * Run index.mjs as a child process, with its state (lock, logs) in `stateDir`.
 * @param {string[]} args  command-line arguments: the command, then its options, e.g. ["nmclean", "--apply"]
 * @param {{ cwd: string, stateDir: string, env?: Record<string, string>, entry?: string }} options
 *   the folder to run in, where state goes, extra environment variables, and the file node starts
 *   (index.mjs, or a link to it)
 * @returns {import('node:child_process').SpawnSyncReturns<string>} exit status and output
 */
export function runCli(args, { cwd, stateDir, env = {}, entry = INDEX_PATH }) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: TEXT_ENCODING,
    env: { ...process.env, LOCALAPPDATA: stateDir, ...env },
  });
}

/**
 * A run context for calling a command's main in-process: printed lines are collected, and every
 * confirmation gets the same answer. LOCALAPPDATA points at `stateDir`, as in runCli: on Windows the
 * test folders sit in the system temp folder inside the real LOCALAPPDATA, where the scripts refuse to run.
 * @param {{ cwd: string, stateDir: string, tempDir?: string, answer?: boolean }} options
 *   the folder to run in, where state goes, the temp folder, and the answer to "continue?"
 * @returns {{ context: import('../lib/shared/index.mjs').RunContext, output: () => string }}
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
