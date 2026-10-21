// @ts-check
// lib/shared/state.mjs - the run context, saved state, the shared lock, run logs and the confirmation prompt.

import { appendFile, mkdir, open, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { TEXT_ENCODING } from './constants.mjs';
import { SafetyError, errorCode } from './errors.mjs';

/**
 * Where a script run takes its surroundings from (see "run context" in docs/GLOSSARY.md). runCommand builds it
 * from the process; tests pass their own. `env` holds the environment variables that name protected
 * folders, such as LOCALAPPDATA on Windows.
 * @typedef {{
 *   cwd: string,
 *   env: NodeJS.ProcessEnv,
 *   stateDir: string,
 *   tempDir: string,
 *   print: (line?: string) => void,
 *   confirm: (question: string) => Promise<boolean>,
 * }} RunContext
 */

// A lock not refreshed for this long belongs to a dead run.
const LOCK_STALE_MS = 30 * 60 * 1000;

// A live run touches its lock this often.
const LOCK_REFRESH_MS = 5 * 60 * 1000;

const STATE_FOLDER = 'devkit';
const STATE_FILE = 'state.json';
const STATE_JSON_INDENT = 2;
const LOCK_FILE = 'devkit.lock';
const LOGS_FOLDER = 'logs';

// The state folder's parent: %LOCALAPPDATA% on Windows, ~/.local/state elsewhere.
const STATE_PARENT_ENV = 'LOCALAPPDATA';
const UNIX_STATE_PARENT = ['.local', 'state'];

// ":" and "." are not allowed or confusing in Windows file names.
const TIMESTAMP_UNSAFE_CHARS = /[:.]/g;

const CONFIRM_WORD = 'yes';

/**
 * Read the saved state.
 * @param {string} stateDir  the run context's state folder
 * @returns {Promise<{ lastCleanup?: string }>} the state, or an empty object when none is saved
 */
export async function readState(stateDir) {
  try {
    return JSON.parse(await readFile(path.join(stateDir, STATE_FILE), TEXT_ENCODING));
  } catch {
    return {};
  }
}

/**
 * Merge fields into the saved state.
 * @param {string} stateDir  the run context's state folder
 * @param {{ lastCleanup?: string }} patch  fields to set
 */
export async function writeState(stateDir, patch) {
  const merged = { ...(await readState(stateDir)), ...patch };

  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, STATE_FILE), JSON.stringify(merged, null, STATE_JSON_INDENT));
}

/**
 * Run `task` holding the one lock shared by all devkit scripts, so for example nmclean and nminstall
 * never overlap. A live run refreshes the lock; only a lock untouched for LOCK_STALE_MS is taken over,
 * and a run only removes the lock if it still holds its own process id.
 * @template T
 * @param {string} stateDir  the run context's state folder, where the lock lives
 * @param {() => Promise<T>} task  the work to do while holding the lock
 * @returns {Promise<T>} what `task` returned
 */
export async function withLock(stateDir, task) {
  await mkdir(stateDir, { recursive: true });

  const lockPath = path.join(stateDir, LOCK_FILE);
  const owner = `${process.pid}\n`;
  let handle;

  try {
    handle = await open(lockPath, 'wx');
  } catch (err) {
    if (errorCode(err) !== 'EEXIST') {
      throw err;
    }

    if (Date.now() - (await stat(lockPath)).mtimeMs < LOCK_STALE_MS) {
      throw new SafetyError(
        `Another devkit script is running (${lockPath}). If it is not, delete that file. Nothing was changed.`,
      );
    }

    await unlink(lockPath);
    handle = await open(lockPath, 'wx');
  }

  await handle.writeFile(owner);
  await handle.close();

  const heartbeat = setInterval(() => {
    const now = new Date();

    utimes(lockPath, now, now).catch(() => {});
  }, LOCK_REFRESH_MS);

  heartbeat.unref();

  try {
    return await task();
  } finally {
    clearInterval(heartbeat);

    if ((await readFile(lockPath, TEXT_ENCODING).catch(() => '')) === owner) {
      await unlink(lockPath).catch(() => {});
    }
  }
}

/**
 * Open a new log file for one run.
 * @param {string} stateDir  the run context's state folder, where logs go
 * @param {string} name  script name, part of the file name
 * @returns {Promise<{ file: string, log: (line: string) => Promise<void> }>} the log's path and a writer
 */
export async function createLog(stateDir, name) {
  const dir = path.join(stateDir, LOGS_FOLDER);

  await mkdir(dir, { recursive: true });

  const file = path.join(dir, `${new Date().toISOString().replace(TIMESTAMP_UNSAFE_CHARS, '-')}-${name}.log`);

  /**
   * Append one timestamped line; a failed write never stops the run.
   * @param {string} line  text to log
   * @returns {Promise<void>} settles when written
   */
  const log = (line) => appendFile(file, `${new Date().toISOString()} ${line}\n`).catch(() => {});

  return { file, log };
}

/**
 * Ask in the terminal for a typed "yes". Refuses when there is no interactive terminal to ask in.
 * @param {string} question  the prompt text
 * @returns {Promise<boolean>} whether to go ahead
 */
async function askInTerminal(question) {
  if (!process.stdin.isTTY) {
    throw new SafetyError('No interactive terminal to confirm in: re-run with --yes. Nothing was changed.');
  }

  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = await prompt.question(`${question} Type "${CONFIRM_WORD}" to continue: `);

    return answer.trim().toLowerCase() === CONFIRM_WORD;
  } finally {
    prompt.close();
  }
}

/**
 * The run context of a real run: the process's folder, the per-user state and temp folders, the terminal.
 * State goes to %LOCALAPPDATA%\devkit on Windows and ~/.local/state/devkit elsewhere; a set LOCALAPPDATA
 * wins on every platform.
 * @returns {RunContext} the context
 */
export function processContext() {
  const stateParent = process.env[STATE_PARENT_ENV] || path.join(homedir(), ...UNIX_STATE_PARENT);

  return {
    cwd: process.cwd(),
    env: process.env,
    stateDir: path.join(stateParent, STATE_FOLDER),
    tempDir: tmpdir(),
    print: (line = '') => {
      console.log(line);
    },
    confirm: askInTerminal,
  };
}
