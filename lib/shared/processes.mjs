// @ts-check
// lib/shared/processes.mjs - child processes (git, shell commands). They never reject, and on timeout they are
// killed together with everything they started.

import { exec, execFile } from 'node:child_process';
import path from 'node:path';
import { EXIT_OK, LINE_BREAK, TEXT_ENCODING } from './constants.mjs';
import { HOST_RULES, childEnv } from './platform.mjs';

/** @typedef {import('./run.mjs').RunResult} RunResult */

/**
 * Outcome of a child process.
 * @typedef {RunResult & { code: number, stdout: string, timedOut: boolean }} CommandResult
 */

const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const WHITESPACE = /\s+/;
const YARN_VERSION_COMMAND = 'yarn --version';

// Git must not run fsmonitor hooks from a repo's config or take optional locks while we only look.
const GIT_SAFE_FLAGS = ['--no-optional-locks', '-c', 'core.fsmonitor=false'];

// Ending a process tree (see treeKill in the platform rules).
const TASKKILL = 'taskkill';
const PROCESS_LIST = ['ps', ['-A', '-o', 'pid=', '-o', 'ppid=']];
const KILL_SIGNAL = 'SIGKILL';

// Neutral working directory for git (repo paths go through -C): Node's own install folder.
const NEUTRAL_CWD = path.dirname(process.execPath);

/**
 * Error passed to an exec or execFile callback.
 * @typedef {import('node:child_process').ExecException
 *   | import('node:child_process').ExecFileException
 *   | null} ChildError
 */
/** @typedef {(error: ChildError, stdout: string, stderr: string) => void} ChildCallback */

/**
 * Options shared by every child process: the cleaned environment, no window, text output.
 * @param {string | undefined} cwd  working folder of the child
 * @returns {import('node:child_process').ExecOptionsWithStringEncoding} options for exec and execFile
 */
const childOptions = (cwd) => ({
  cwd, env: childEnv(process.env), windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, encoding: TEXT_ENCODING,
});

/**
 * Process ids of `rootPid` and everything it started, read from `ps -A -o pid= -o ppid=` output.
 * @param {number} rootPid  the process whose tree is wanted
 * @param {string} psOutput  one "pid parent-pid" pair per line
 * @returns {number[]} parents before their children
 */
export function processTree(rootPid, psOutput) {
  /** @type {Map<number, number[]>} */
  const children = new Map();

  for (const line of psOutput.split(LINE_BREAK)) {
    const [pid, parentPid] = line.trim().split(WHITESPACE).map(Number);

    if (Number.isInteger(pid) && Number.isInteger(parentPid) && pid !== parentPid) {
      children.set(parentPid, [...(children.get(parentPid) ?? []), pid]);
    }
  }

  const tree = [rootPid];

  for (let index = 0; index < tree.length; index += 1) {
    tree.push(...(children.get(tree[index]) ?? []));
  }

  return tree;
}

/**
 * Kill a child and everything it started. A plain kill would only stop the shell (cmd.exe or sh)
 * and leave npm/node running: Windows ends the tree with taskkill, macOS and Linux find it with ps.
 * @param {import('node:child_process').ChildProcess} child  the process to end
 */
function killTree(child) {
  const { pid } = child;

  if (pid === undefined) {
    return;
  }

  if (HOST_RULES.treeKill === 'taskkill') {
    execFile(TASKKILL, ['/pid', String(pid), '/T', '/F'], () => {});

    return;
  }

  const [program, args] = PROCESS_LIST;

  execFile(String(program), /** @type {string[]} */ (args), (error, stdout) => {
    for (const processId of error ? [pid] : processTree(pid, stdout)) {
      try {
        process.kill(processId, KILL_SIGNAL);
      } catch {
        // already gone
      }
    }
  });
}

/**
 * Start a child, close its stdin (a prompt fails instead of waiting), and collect its result.
 * Never rejects.
 * @param {(done: ChildCallback) => import('node:child_process').ChildProcess} start  starts the child
 * @param {number} timeout  milliseconds before the child and its tree are killed
 * @returns {Promise<CommandResult>} exit status and output
 */
function collect(start, timeout) {
  return new Promise((resolve) => {
    let timedOut = false;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;

    const child = start((error, stdout, stderr) => {
      clearTimeout(timer);

      const numericCode = typeof error?.code === 'number' ? error.code : -1;

      resolve({
        ok: !error && !timedOut,
        code: error ? numericCode : EXIT_OK,
        stdout,
        output: `${stdout}${stderr}`.trim() || (error ? error.message : ''),
        timedOut,
      });
    });

    child.stdin?.end();
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeout);
  });
}

/**
 * Run git without a shell, from a neutral folder; repo paths are passed with -C. Never rejects.
 * @param {string[]} args  git arguments, e.g. ['-C', repo, 'status']
 * @returns {Promise<CommandResult>} exit status and output
 */
export function git(args) {
  return collect(
    (done) => execFile('git', [...GIT_SAFE_FLAGS, ...args], childOptions(NEUTRAL_CWD), done),
    COMMAND_TIMEOUT_MS,
  );
}

/**
 * Run a fixed command line through the shell (cmd.exe on Windows). Needed for npm/yarn, which are
 * .cmd shims: Node refuses to spawn .cmd files without a shell since the CVE-2024-27980 fix.
 * Only constant strings from these scripts are passed here, never user input. Never rejects.
 * @param {string} command  the whole command line
 * @param {{ cwd?: string, timeout?: number }} [options]  working folder, and milliseconds before the tree is killed
 * @returns {Promise<CommandResult>} exit status and output
 */
export function runShell(command, { cwd, timeout = COMMAND_TIMEOUT_MS } = {}) {
  return collect((done) => exec(command, childOptions(cwd), done), timeout);
}

/**
 * Last line of command output, e.g. the version printed by `yarn --version`.
 * @param {string} text  command output
 * @returns {string} its last line, trimmed
 */
export const lastLine = (text) => (text.split(LINE_BREAK).pop() ?? '').trim();

/**
 * Major version of the yarn that runs in `cwd` (Corepack may pick a per-project version).
 * @param {string} cwd  folder to ask from
 * @returns {Promise<number | null>} the major version, or null when yarn is not available
 */
export async function yarnMajor(cwd) {
  const version = await runShell(YARN_VERSION_COMMAND, { cwd });
  const major = Number.parseInt(lastLine(version.output)); // "4.5.0" -> 4; base 10 is the default

  return version.ok && !Number.isNaN(major) ? major : null;
}
