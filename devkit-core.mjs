// @ts-check
// devkit-core.mjs - shared safety checks and the plan -> confirm -> run flow used by
// nmclean.mjs, nminstall.mjs, devclean.mjs and npmrctoken.mjs.
// Runs on Windows, macOS and Linux. Node 18+, no dependencies.
// The safety model these checks implement is described once, in README.md ("Safety model").

import { exec, execFile } from 'node:child_process';
import {
  appendFile, chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rmdir, stat, unlink, utimes, writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- types

/**
 * Outcome of one action. `summary` replaces the plan detail on the ok line, e.g. a value read back after writing.
 * @typedef {{ ok: boolean, output: string, summary?: string }} RunResult
 */
/**
 * Outcome of a child process.
 * @typedef {RunResult & { code: number, stdout: string, timedOut: boolean }} CommandResult
 */
/**
 * One finished plan item, reported like gpall's results.
 * @typedef {{ name: string, ok: boolean, output: string, summary?: string }} Result
 */
/** @typedef {{ name: string, real: string }} Repo  a repo folder name and its resolved path */
/** @typedef {{ bytes: number, files: number, newest: number, truncated: boolean, hasNestedRepo: boolean }} TreeInfo */
/**
 * One line of a plan. `skip` holds the reason it is kept; `run` performs it and never rejects.
 * @typedef {{
 *   name: string, detail?: string, bytes?: number | null, skip: string | null, run: () => Promise<RunResult>
 * }} PlanItem
 */
/** @typedef {{ title: string, items: PlanItem[] }} PlanSection */
/** @typedef {{ apply: boolean, yes: boolean, help: boolean, jobs: number }} BaseOptions  flags every script accepts */
/**
 * Decides whether a planned folder is kept: returns the reason to keep it, or null to delete it.
 * `fresh` is true on the re-check right before deletion, so cached values must be recomputed.
 * @typedef {(tree: TreeInfo, repo: Repo, context: { fresh: boolean }) => Promise<string | null>} KeepRule
 */

// ---------------------------------------------------------------- settings

export const IS_WINDOWS = process.platform === 'win32';
export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_JOBS = 4;
export const NODE_MODULES = 'node_modules';
export const PACKAGE_JSON = 'package.json';
export const GIT_FOLDER = '.git';
export const YARN_BERRY_MAJOR = 2; // Yarn 2+ ("Berry") behaves differently from Yarn 1 ("Classic")
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_REFUSED = 2;

const COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const LOCK_STALE_MS = 30 * 60 * 1000; // a lock not refreshed for this long belongs to a dead run
const LOCK_REFRESH_MS = 5 * 60 * 1000; // a live run touches its lock this often
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_SEARCH_DEPTH = 6;
const MAX_ERRORS_SHOWN = 5;
const NAME_COLUMN_WIDTH = 40; // same as gpall
const DETAIL_INDENT = '    ';
const DECIMAL = 10;
const TEXT_ENCODING = 'utf8';

const STATE_FOLDER = 'devkit';
const STATE_FILE = 'state.json';
const STATE_JSON_INDENT = 2;
const LOCK_FILE = 'devkit.lock';
const LOGS_FOLDER = 'logs';
const STATE_PARENT_ENV = 'LOCALAPPDATA'; // Windows; elsewhere the parent is ~/.local/state
const UNIX_STATE_PARENT = ['.local', 'state'];

// A folder being deleted is first renamed to "<name>.devkit-deleting-<Date.now()>".
const TRASH_TAG = '.devkit-deleting-';
const TRASH_STAMP = /^\d{13}$/;

// Folders the scripts must never run inside. Windows: named by environment variables.
const PROTECTED_FOLDER_VARS = [
  'SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'APPDATA', 'LOCALAPPDATA',
];
// macOS and Linux: system folders, and app data inside the home folder. /var is left out on purpose:
// macOS keeps each user's temp folder under it.
const PROTECTED_SYSTEM_FOLDERS = [
  '/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/opt', '/proc', '/run', '/sbin', '/sys', '/usr',
  '/Applications', '/Library', '/System',
];
const PROTECTED_HOME_FOLDERS = ['Library', '.cache', '.config', '.local'];
const NETWORK_PATH_PREFIXES = ['\\\\', '//'];

// Where the user temp folder may be, since devclean deletes its old entries. Subfolders also count.
const WINDOWS_TEMP_IN_HOME = ['AppData', 'Local', 'Temp'];
/** @type {Partial<Record<NodeJS.Platform, string[]>>} */
const UNIX_TEMP_HOMES = { darwin: ['/private/var/folders', '/private/tmp'], linux: ['/tmp', '/var/tmp'] };

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
const BYTES_PER_UNIT = 1024;
const DIRECTORY_LINK_CODES = ['EPERM', 'EISDIR', 'EACCES']; // unlink refused: it is a directory link, use rmdir
const READ_ONLY_CODES = ['EPERM', 'EACCES'];
const IN_USE_CODES = ['EBUSY', 'EPERM'];
const WRITABLE_FILE_MODE = 0o666;

const LINE_BREAK = /\r?\n/;
const WHITESPACE = /\s+/;
const WHITESPACE_RUNS = /\s+/g;
const LINE_STARTS = /^/gm;
const WHOLE_NUMBER = /^\d+$/;
const TIMESTAMP_UNSAFE_CHARS = /[:.]/g; // ":" and "." are not allowed or confusing in Windows file names

const CONFIRM_WORD = 'yes';
const LIST_SEPARATOR = ',';
const NUL = '\0';
const SCRIPT_ARGS_START = 2; // process.argv holds node and the script path first

// Git must not run fsmonitor hooks from a repo's config or take optional locks while we only look.
const GIT_SAFE_FLAGS = ['--no-optional-locks', '-c', 'core.fsmonitor=false'];
const GIT_ENV_PREFIX = 'GIT_';
const YARN_VERSION_COMMAND = 'yarn --version';
// Ending a process tree: Windows names the root, macOS and Linux list every process with its parent.
const TASKKILL = 'taskkill';
const PROCESS_LIST = ['ps', ['-A', '-o', 'pid=', '-o', 'ppid=']];
const KILL_SIGNAL = 'SIGKILL';

// No GIT_DIR / GIT_INDEX_FILE / ... overrides from the parent shell, no prompts, and no npm / yarn planted
// in the current folder: cmd.exe is told not to search it, and elsewhere PATH keeps only absolute folders
// (an empty entry or "." would mean the current folder).
const ABSOLUTE_PATH = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => path.isAbsolute(dir));
const CHILD_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith(GIT_ENV_PREFIX))),
  GIT_TERMINAL_PROMPT: '0',
  NoDefaultCurrentDirectoryInExePath: '1',
  ...(IS_WINDOWS ? {} : { PATH: ABSOLUTE_PATH.join(path.delimiter) }),
};
// Neutral working directory for git (repo paths go through -C): Node's own install folder.
const NEUTRAL_CWD = path.dirname(process.execPath);

/** A refusal: the run stops before changing anything, exit code 2. */
export class SafetyError extends Error {}

/**
 * Error code of a caught error, if any.
 * @param {unknown} err  anything a `catch` received
 * @returns {string | undefined} the code, e.g. "ENOENT"
 */
export const errorCode = (err) => /** @type {NodeJS.ErrnoException} */ (err)?.code;

/**
 * Short text for a caught error: its code when it has one, else its message.
 * @param {unknown} err  anything a `catch` received
 * @returns {string} text for the output and the log
 */
const errorText = (err) => errorCode(err) ?? (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------- paths

/**
 * Absolute form of a path, lower-cased on Windows where paths ignore case.
 * @param {string} anyPath  relative or absolute path
 * @returns {string} the path ready for comparing
 */
const normalize = (anyPath) => (IS_WINDOWS ? path.resolve(anyPath).toLowerCase() : path.resolve(anyPath));

/**
 * True when two paths name the same place after resolving; case-insensitive on Windows.
 * @param {string} first  one path
 * @param {string} second  the other path
 * @returns {boolean} whether they are the same
 */
export const samePath = (first, second) => normalize(first) === normalize(second);

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
const realpathOrResolve = (target) => realpath(target).catch(() => path.resolve(target));

/**
 * True when `child` is strictly inside `parent` (Windows: case-insensitive).
 * @param {string} parent  the outer folder
 * @param {string} child  the path to test
 * @returns {boolean} whether `child` is below `parent`
 */
export function isInside(parent, child) {
  const relativePath = path.relative(normalize(parent), normalize(child));

  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
}

/**
 * True when `child` is `folder` itself or inside it.
 * @param {string} folder  the outer folder
 * @param {string} child  the path to test
 * @returns {boolean} whether `child` is `folder` or below it
 */
const isAtOrInside = (folder, child) => samePath(folder, child) || isInside(folder, child);

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
 * Folders the scripts must never run inside.
 * @param {string} homeReal  the resolved home folder
 * @param {NodeJS.ProcessEnv} env  environment holding the Windows folder variables
 * @param {boolean} windows  which platform's list to use
 * @returns {Promise<[string, string][]>} [label for the message, resolved path] pairs
 */
async function protectedFolders(homeReal, env, windows) {
  /** @type {[string, string][]} */
  const named = [];

  if (windows) {
    for (const name of PROTECTED_FOLDER_VARS) {
      const value = env[name];

      if (value) {
        named.push([name, value]);
      }
    }
  } else {
    for (const dir of PROTECTED_SYSTEM_FOLDERS) {
      named.push([dir, dir]);
    }

    for (const name of PROTECTED_HOME_FOLDERS) {
      named.push([`~/${name}`, path.join(homeReal, name)]);
    }
  }

  /** @type {[string, string][]} */
  const resolved = [];

  for (const [label, dir] of named) {
    resolved.push([label, await realpathOrResolve(dir)]);
  }

  return resolved;
}

/**
 * Resolve the folder a script runs in. Throws SafetyError when it is a dangerous place.
 * @param {string} root  the folder to check, usually the current folder
 * @param {{ home?: string, env?: NodeJS.ProcessEnv, windows?: boolean }} [options]  injectable for tests
 * @returns {Promise<string>} resolved root
 */
export async function assertSafeRoot(root, { home = homedir(), env = process.env, windows = IS_WINDOWS } = {}) {
  const real = await realpath(root);
  const homeReal = await realpathOrResolve(home);
  const problems = [];

  if (NETWORK_PATH_PREFIXES.some((prefix) => real.startsWith(prefix))) {
    problems.push('it is a network (UNC) path');
  }

  if (path.parse(real).root === real) {
    problems.push('it is a drive or filesystem root');
  }

  if (samePath(real, homeReal)) {
    problems.push('it is your home folder');
  }

  for (const [label, folder] of await protectedFolders(homeReal, env, windows)) {
    if (isAtOrInside(folder, real)) {
      problems.push(`it is inside ${label}${label === folder ? '' : ` (${folder})`}`);
    }
  }

  if (problems.length) {
    throw new SafetyError(`Refusing to run in ${real}: ${problems.join('; ')}.`);
  }

  return real;
}

/**
 * The user temp folder, accepted only where the system normally keeps it: %USERPROFILE%\AppData\Local\Temp
 * on Windows, /private/var/folders or /private/tmp on macOS, /tmp or /var/tmp on Linux, or a subfolder.
 * @param {{ temp?: string, home?: string, platform?: NodeJS.Platform }} [options]  injectable for tests
 * @returns {Promise<string>} resolved temp folder
 */
export async function resolveTempDir({ temp = tmpdir(), home = homedir(), platform = process.platform } = {}) {
  const real = await realpath(temp);
  const homes = platform === 'win32' ? [path.join(home, ...WINDOWS_TEMP_IN_HOME)] : (UNIX_TEMP_HOMES[platform] ?? []);
  const allowed = await Promise.all(homes.map(realpathOrResolve));

  if (allowed.some((folder) => isAtOrInside(folder, real))) {
    return real;
  }

  const expected = allowed.length
    ? `expected ${allowed.join(' or ')} or a subfolder`
    : `no known temp folder on ${platform}`;

  throw new SafetyError(`TEMP is ${real}, ${expected}; temp cleanup skipped.`);
}

// ---------------------------------------------------------------- child processes (never reject)

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
  cwd, env: CHILD_ENV, windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES, encoding: TEXT_ENCODING,
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

  if (IS_WINDOWS) {
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
 * @param {{ timeout?: number }} [options]  milliseconds before git is killed
 * @returns {Promise<CommandResult>} exit status and output
 */
export function git(args, { timeout = COMMAND_TIMEOUT_MS } = {}) {
  return collect((done) => execFile('git', [...GIT_SAFE_FLAGS, ...args], childOptions(NEUTRAL_CWD), done), timeout);
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
  const major = Number.parseInt(lastLine(version.output), DECIMAL);

  return version.ok && !Number.isNaN(major) ? major : null;
}

/**
 * Run `worker` over `items` with at most `limit` running at once (same as gpall).
 * @template T, R
 * @param {readonly T[]} items  inputs
 * @param {number} limit  most workers running at once
 * @param {(item: T) => Promise<R>} worker  handles one input
 * @returns {Promise<R[]>} results in input order
 */
export async function mapPool(items, limit, worker) {
  /** @type {R[]} */
  const results = new Array(items.length);
  let next = 0;

  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;

      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(lanes);

  return results;
}

// ---------------------------------------------------------------- guards

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

/**
 * Checks that git allows deleting `target`: no tracked file inside and, optionally, git-ignored.
 * Tracked files are matched case-insensitively, so "Dist/a.js" in the index protects a "dist" folder
 * (a case-only rename on Windows would otherwise slip through).
 * @param {string} repoReal  resolved repo folder
 * @param {string} target  folder inside the repo
 * @param {{ requireIgnored?: boolean }} [options]  false skips the git-ignore check
 * @returns {Promise<string | null>} reason it must not be deleted, or null
 */
export async function gitGuard(repoReal, target, { requireIgnored = true } = {}) {
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

// ---------------------------------------------------------------- discovery

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
 * Visit a repo's folders breadth-first, starting with the repo folder itself. Never follows links and
 * never enters dot-folders (.venv, .yarn, .next, ...), node_modules, devkit leftovers or nested repos.
 * @param {string} repoReal  resolved repo folder
 * @param {(dir: string, entries: import('node:fs').Dirent[]) => Set<string>} visit
 *   called once per folder with its entries; returns the names of subfolders not to enter
 * @param {{ maxDepth?: number }} [options]  how many levels deep to search
 */
async function walkRepo(repoReal, visit, { maxDepth = MAX_SEARCH_DEPTH } = {}) {
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
        && depth + 1 < maxDepth
        && !(await exists(path.join(full, GIT_FOLDER))) // nested repo or submodule
        && (await validateTarget(repoReal, full)) === null; // plain folder, no link on the way

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
 * @param {{ maxDepth?: number }} [options]  how many levels deep to search
 * @returns {Promise<string[]>} sorted absolute paths
 */
export async function findNamedDirs(repoReal, names, options = {}) {
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
  }, options);

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
 * Size, file count and newest mtime of a tree, and whether a nested repo (.git) is inside. Never follows links.
 * @param {string} dir  folder to measure
 * @param {{ skipNames?: Set<string>, maxFiles?: number }} [options]  names to skip; stop early after maxFiles
 * @returns {Promise<TreeInfo>} the totals; `truncated` is true when it stopped early
 */
export async function measure(dir, { skipNames = new Set(), maxFiles = Infinity } = {}) {
  const tree = { bytes: 0, files: 0, newest: (await lstat(dir)).mtimeMs, truncated: false, hasNestedRepo: false };
  const stack = [dir];

  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    let names;

    try {
      names = await readdir(current);
    } catch {
      continue;
    }

    for (const name of names) {
      if (skipNames.has(name) || trashBase(name)) {
        continue;
      }

      if (name === GIT_FOLDER) {
        tree.hasNestedRepo = true;
      }

      const full = path.join(current, name);
      let info;

      try {
        info = await lstat(full);
      } catch {
        continue;
      }

      tree.newest = Math.max(tree.newest, info.mtimeMs);

      if (info.isSymbolicLink()) {
        continue;
      }

      if (info.isDirectory()) {
        stack.push(full);
      } else {
        tree.bytes += info.size;
        tree.files += 1;
      }

      if (tree.files >= maxFiles) {
        return { ...tree, truncated: true };
      }
    }
  }

  return tree;
}

// ---------------------------------------------------------------- deletion

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

// ---------------------------------------------------------------- planning

/**
 * A plan line that is shown as kept and never runs.
 * @param {string} name  what the line is about
 * @param {string} reason  why it is kept
 * @returns {PlanItem} the plan line
 */
export const skippedItem = (name, reason) => ({ name, skip: reason, run: async () => ({ ok: false, output: reason }) });

/**
 * Plan deletion of allow-listed folders in one repo. Each item re-runs every check right before it
 * deletes, because git state, age and links can change while the confirmation prompt is open.
 * @param {Repo} repo  the repo to search
 * @param {readonly string[]} names  folder names to delete, e.g. [NODE_MODULES]
 * @param {{ keepIf?: KeepRule | null }} [options]  extra reason to keep a folder, e.g. its age
 * @returns {Promise<PlanItem[]>} one plan line per folder found
 */
async function planRepoDirs(repo, names, { keepIf = null } = {}) {
  /** @type {PlanItem[]} */
  const items = [];

  for (const target of await findNamedDirs(repo.real, names)) {
    const leftover = trashBase(path.basename(target)) !== null;

    /**
     * Every check for this folder.
     * @param {boolean} fresh  true right before deleting: cached values are recomputed
     * @returns {Promise<{ reason: string | null, bytes: number | null }>} why to keep it, and its size
     */
    const check = async (fresh) => {
      const blocked = (await validateTarget(repo.real, target))
        ?? (await gitGuard(repo.real, target, { requireIgnored: !leftover }));

      if (blocked) {
        return { reason: blocked, bytes: null };
      }

      const tree = await measure(target);

      if (tree.hasNestedRepo) {
        return { reason: 'contains a nested git repo (left alone)', bytes: tree.bytes };
      }

      const reason = keepIf && !leftover ? await keepIf(tree, repo, { fresh }) : null;

      return { reason, bytes: tree.bytes };
    };

    const planned = await check(false);

    items.push({
      name: `${repo.name}/${toPosix(path.relative(repo.real, target))}`,
      detail: leftover ? 'leftover of an earlier run' : '',
      bytes: planned.bytes,
      skip: planned.reason,
      run: async () => {
        const recheck = await check(true);

        if (recheck.reason) {
          return { ok: false, output: `${recheck.reason} (re-checked before deleting; kept)` };
        }

        return safeRemoveTree(target, repo.real);
      },
    });
  }

  return items;
}

/**
 * Plan deletion of allow-listed folders across repos, `jobs` repos at a time.
 * @param {Repo[]} repos  repos to search
 * @param {readonly string[]} names  folder names to delete
 * @param {{ jobs?: number, keepIf?: KeepRule | null }} [options]  parallel repos, and an extra reason to keep
 * @returns {Promise<PlanItem[]>} plan lines of all repos
 */
export async function planFolders(repos, names, { jobs = DEFAULT_JOBS, keepIf = null } = {}) {
  return (await mapPool(repos, jobs, (repo) => planRepoDirs(repo, names, { keepIf }))).flat();
}

// ---------------------------------------------------------------- state, lock, log, confirm

/**
 * Folder for the lock, logs and saved state.
 * @returns {string} %LOCALAPPDATA%\devkit on Windows, ~/.local/state/devkit elsewhere
 */
const stateDir = () => {
  const parent = process.env[STATE_PARENT_ENV] || path.join(homedir(), ...UNIX_STATE_PARENT);

  return path.join(parent, STATE_FOLDER);
};

/**
 * Read the saved state.
 * @returns {Promise<{ lastCleanup?: string }>} the state, or an empty object when none is saved
 */
export async function readState() {
  try {
    return JSON.parse(await readFile(path.join(stateDir(), STATE_FILE), TEXT_ENCODING));
  } catch {
    return {};
  }
}

/**
 * Merge fields into the saved state.
 * @param {{ lastCleanup?: string }} patch  fields to set
 */
export async function writeState(patch) {
  const merged = { ...(await readState()), ...patch };

  await mkdir(stateDir(), { recursive: true });
  await writeFile(path.join(stateDir(), STATE_FILE), JSON.stringify(merged, null, STATE_JSON_INDENT));
}

/**
 * Run `task` holding the one lock shared by all devkit scripts, so for example nmclean and nminstall
 * never overlap. A live run refreshes the lock; only a lock untouched for LOCK_STALE_MS is taken over,
 * and a run only removes the lock if it still holds its own process id.
 * @template T
 * @param {() => Promise<T>} task  the work to do while holding the lock
 * @returns {Promise<T>} what `task` returned
 */
async function withLock(task) {
  await mkdir(stateDir(), { recursive: true });

  const lockPath = path.join(stateDir(), LOCK_FILE);
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
 * @param {string} name  script name, part of the file name
 * @returns {Promise<{ file: string, log: (line: string) => Promise<void> }>} the log's path and a writer
 */
async function createLog(name) {
  const dir = path.join(stateDir(), LOGS_FOLDER);

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
 * Ask for a typed "yes". Without an interactive terminal, refuse unless --yes was given.
 * @param {string} question  the prompt text
 * @param {{ yes: boolean }} options  true skips the prompt
 * @returns {Promise<boolean>} whether to go ahead
 */
async function confirm(question, { yes }) {
  if (yes) {
    return true;
  }

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

// ---------------------------------------------------------------- output

/**
 * Human-readable size, e.g. 1536 -> "1.5 KB".
 * @param {number | null | undefined} bytes  size, or nothing when unknown
 * @returns {string} the size with a unit, or an empty string when unknown
 */
export function formatBytes(bytes) {
  if (bytes == null) {
    return '';
  }

  let value = bytes;
  let unit = 0;

  while (value >= BYTES_PER_UNIT && unit < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unit += 1;
  }

  return `${value.toFixed(unit ? 1 : 0)} ${BYTE_UNITS[unit]}`;
}

/**
 * Whole days between `mtimeMs` and `now`.
 * @param {number} mtimeMs  an earlier time
 * @param {number} [now]  the later time, by default the current time
 * @returns {number} full days in between
 */
export const ageInDays = (mtimeMs, now = Date.now()) => Math.floor((now - mtimeMs) / DAY_MS);

/**
 * Total size of plan items whose size is known.
 * @param {PlanItem[]} items  plan lines
 * @returns {number} bytes
 */
const totalBytes = (items) => items.reduce((sum, item) => sum + (item.bytes ?? 0), 0);

/**
 * Size and detail of a plan line, for the output.
 * @param {PlanItem} item  plan line
 * @returns {string} e.g. "1.5 KB  leftover of an earlier run"
 */
const describe = (item) => [formatBytes(item.bytes), item.detail].filter(Boolean).join('  ');

/**
 * Indent every line of a text, for failure details under a heading.
 * @param {string} text  possibly multi-line text
 * @returns {string} the indented text
 */
const indent = (text) => text.replace(LINE_STARTS, DETAIL_INDENT);

/**
 * Upper-case the first letter.
 * @param {string} word  e.g. "delete"
 * @returns {string} e.g. "Delete"
 */
const capitalize = (word) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * Print one plan section: a title and a "do" or "keep" line per item.
 * @param {PlanSection} section  the section to print
 */
function printSection({ title, items }) {
  console.log(`\n${title}`);

  if (!items.length) {
    console.log('  (nothing found)');
  }

  for (const item of items) {
    const action = item.skip ? 'keep' : 'do  ';

    console.log(`  ${action}  ${item.name.padEnd(NAME_COLUMN_WIDTH)} ${item.skip ?? describe(item)}`);
  }
}

/**
 * Run plan items in a pool. Every item is attempted; failures are returned as data (gpall style).
 * @param {PlanItem[]} items  plan lines to run
 * @param {{
 *   jobs: number,
 *   log?: (line: string) => Promise<void>,
 *   onResult?: (result: Result, item: PlanItem) => void,
 * }} options  parallel items, a log writer, and a callback per finished item
 * @returns {Promise<Result[]>} in input order
 */
export async function runItems(items, { jobs, log = async () => {}, onResult = () => {} }) {
  return mapPool(items, jobs, async (item) => {
    /** @type {RunResult} */
    const outcome = await item.run().catch((err) => ({ ok: false, output: errorText(err) }));
    const failure = outcome.ok ? '' : ` | ${outcome.output.replace(WHITESPACE_RUNS, ' ')}`;

    await log(`${outcome.ok ? 'ok  ' : 'FAIL'} ${item.name}${failure}`);

    const result = { name: item.name, ok: outcome.ok, output: outcome.output, summary: outcome.summary };

    onResult(result, item);

    return result;
  });
}

/**
 * The shared flow: print the plan -> stop if dry run -> confirm -> lock -> runItems, printing ok/FAIL per
 * item as it finishes -> list failures with details at the end (like gpall).
 * @param {{ sections: PlanSection[], options: BaseOptions, verb: string, logName: string }} args
 *   the plan, the parsed flags, the action word for messages ("delete"), and the log file's name
 * @returns {Promise<{ code: number, applied: boolean }>} exit code, and whether --apply ran to the end
 */
export async function planAndRun({ sections, options, verb, logName }) {
  sections.forEach(printSection);

  const todo = sections.flatMap((section) => section.items).filter((item) => !item.skip);
  const size = totalBytes(todo) ? ` (${formatBytes(totalBytes(todo))})` : '';

  if (!todo.length) {
    console.log('\nNothing to do.');

    return { code: EXIT_OK, applied: options.apply };
  }

  if (!options.apply) {
    console.log(`\nDry run: nothing changed. Re-run with --apply to ${verb} ${todo.length} item(s)${size}.`);

    return { code: EXIT_OK, applied: false };
  }

  if (!(await confirm(`\n${capitalize(verb)} ${todo.length} item(s)${size}?`, options))) {
    console.log('Cancelled. Nothing was changed.');

    return { code: EXIT_OK, applied: false };
  }

  return withLock(async () => {
    const { file, log } = await createLog(logName);

    console.log();

    const results = await runItems(todo, {
      jobs: options.jobs,
      log,
      onResult: (result, item) => {
        const detail = result.summary ?? describe(item);

        console.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.name.padEnd(NAME_COLUMN_WIDTH)} ${detail}`);
      },
    });
    const failed = results.filter((result) => !result.ok);
    const summary = failed.length ? `${failed.length} failed` : 'all ok';

    console.log(`\nDone: ${results.length} item(s), ${summary}. Log: ${file}`);

    for (const result of failed) {
      console.log(`\n--- ${result.name}\n${indent(result.output)}`);
    }

    return { code: failed.length ? EXIT_FAILED : EXIT_OK, applied: true };
  });
}

// ---------------------------------------------------------------- CLI

/**
 * Parse a whole number of at least 1. Throws SafetyError otherwise.
 * @param {string | undefined} value  the text after the flag
 * @param {string} flag  used in the error message
 * @returns {number} the number
 */
function positiveInt(value, flag) {
  const number = Number(value);

  if (!Number.isInteger(number) || number < 1) {
    throw new SafetyError(`${flag} needs a whole number >= 1. Nothing was changed.`);
  }

  return number;
}

/**
 * gpall-style arguments: an optional bare number is the parallel job count; everything else must be a
 * known flag. Unknown flags stop the run, so a typo like --aply can never be mistaken for --apply.
 * @template {object} Defaults
 * @param {string[]} argv  command-line arguments after the script name
 * @param {{ defaults: Defaults,
 *           booleans?: Record<string, [keyof Defaults, boolean]>,
 *           numbers?: Record<string, keyof Defaults>,
 *           lists?: Record<string, { key: keyof Defaults, allowed: readonly string[] }> }} spec
 *   the script's own flags: which option each sets, and the default values
 * @returns {BaseOptions & Defaults} the parsed options
 */
export function parseArgs(argv, { defaults, booleans = {}, numbers = {}, lists = {} }) {
  const options = { apply: false, yes: false, help: false, jobs: DEFAULT_JOBS, ...defaults };
  /** @type {Record<string, unknown>} */
  const fields = options;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (WHOLE_NUMBER.test(arg)) {
      options.jobs = positiveInt(arg, 'jobs');
    } else if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--yes') {
      options.yes = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (Object.hasOwn(booleans, arg)) {
      const [key, value] = booleans[arg];

      fields[String(key)] = value;
    } else if (Object.hasOwn(numbers, arg)) {
      index += 1;
      fields[String(numbers[arg])] = positiveInt(argv[index], arg);
    } else if (Object.hasOwn(lists, arg)) {
      const { key, allowed } = lists[arg];

      index += 1;

      const values = (argv[index] ?? '').split(LIST_SEPARATOR).filter(Boolean);

      if (!values.length || values.some((value) => !allowed.includes(value))) {
        throw new SafetyError(`${arg} accepts: ${allowed.join(LIST_SEPARATOR)}. Nothing was changed.`);
      }

      fields[String(key)] = new Set(values);
    } else {
      throw new SafetyError(`Unknown option "${arg}". Nothing was changed.`);
    }
  }

  return options;
}

/**
 * True when the module at `importMetaUrl` is the script node was started with. Compares real paths,
 * so a symlink, an 8.3 short path or a different letter case still counts. Never rejects.
 * @param {string} importMetaUrl  the module's import.meta.url
 * @returns {Promise<boolean>} whether node was started with it
 */
async function isEntryPoint(importMetaUrl) {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return samePath(await realpath(process.argv[1]), await realpath(fileURLToPath(importMetaUrl)));
  } catch {
    return false;
  }
}

/**
 * Run `main` only when the calling file is executed directly (not when tests import it).
 * Exit codes: what `main` returns (0 ok, 1 some items failed), 2 refused by a safety check.
 * @param {string} importMetaUrl  the caller's import.meta.url
 * @param {(argv: string[]) => Promise<number>} main  the script's work; returns the exit code
 */
export async function runMain(importMetaUrl, main) {
  if (!(await isEntryPoint(importMetaUrl))) {
    return;
  }

  try {
    process.exitCode = await main(process.argv.slice(SCRIPT_ARGS_START));
  } catch (err) {
    console.error(err instanceof SafetyError ? err.message : err);
    process.exitCode = EXIT_REFUSED;
  }
}
