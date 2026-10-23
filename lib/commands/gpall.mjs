// @ts-check
// lib/commands/gpall.mjs - pull every git repo directly under the current folder, in parallel.
// Standalone on purpose: it deletes nothing, so it needs none of the safety checks in lib/shared/ and imports
// nothing from there. It takes its folder, output and progress line from the run context it is given.

import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_JOBS = 8;
const PULL_TIMEOUT_MS = 2 * 60 * 1000;
const DETACHED_HEAD = 'detached';
const NO_UPSTREAM = 'no upstream branch';

// Copies from lib/shared/ (constants.mjs, cli.mjs, format.mjs). Keep in sync with them.
const DETAIL_INDENT = '    ';
const GIT_FOLDER = '.git';
const HELP_FLAGS = ['--help', '-h'];
const WHOLE_NUMBER = /^\d+$/;
const LINE_STARTS = /^/gm;
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_REFUSED = 2;

const HELP = `Pull every git repo under the current folder (git pull --ff-only --prune).
A repo whose branch has no upstream branch is skipped, so a read-only clone can stay as it is.

  devkit pull [jobs]

  jobs  parallel pulls (default ${DEFAULT_JOBS})
`;

/** A bad command line: printed without a stack trace, exit code 2. */
class UsageError extends Error {}

/**
 * Run one git command in `cwd`. Never rejects: failures are returned as data.
 * @param {string} cwd  the repo folder
 * @param {string[]} args  git arguments
 * @returns {Promise<{ ok: boolean, output: string }>} whether git succeeded, and its output
 */
function git(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      {
        // Fail instead of hanging on a credential prompt.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },

        timeout: PULL_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim() || (error ? error.message : '');

        resolve({ ok: !error, output });
      },
    );
  });
}

/**
 * Direct subfolders of `root` that contain a .git folder (or a .git file, for worktrees).
 * @param {string} root  the folder holding the repos
 * @returns {Promise<string[]>} folder names, sorted
 */
async function findRepos(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const checks = entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      try {
        await stat(join(root, entry.name, GIT_FOLDER));

        return entry.name;
      } catch {
        return null;
      }
    });

  return (await Promise.all(checks)).filter((name) => name !== null).sort();
}

/**
 * One repo's pull: its branch, why it was skipped (null: it was pulled), and whether the pull succeeded
 * with git's output. A skipped repo counts as ok.
 * @typedef {{ name: string, branch: string, skip: string | null, ok: boolean, output: string }} PullResult
 */

/**
 * Fast-forward-only pull of one repository. A branch without an upstream branch, or a detached HEAD, is
 * skipped: there is nothing to pull from.
 * @param {string} root  the folder holding the repos
 * @param {string} name  the repo's folder name
 * @returns {Promise<PullResult>} the branch, and whether it was skipped or the pull succeeded
 */
async function pullRepo(root, name) {
  const dir = join(root, name);
  const head = await git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']);
  const branch = head.ok ? head.output : DETACHED_HEAD;
  const upstream = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);

  if (!upstream.ok) {
    return { name, branch, skip: NO_UPSTREAM, ok: true, output: '' };
  }

  const pull = await git(dir, ['pull', '--ff-only', '--prune', '--quiet']);

  return { name, branch, skip: null, ok: pull.ok, output: pull.output };
}

/**
 * The status word of a result line, padded to one width.
 * @param {PullResult} result  one repo's result
 * @returns {string} "skip", "ok" or "FAIL"
 */
function statusWord(result) {
  if (result.skip) {
    return 'skip';
  }

  return result.ok ? 'ok  ' : 'FAIL';
}

/**
 * Run `worker` over `items` with at most `limit` running at once. Keep in sync with run.mjs.
 * @template T, R
 * @param {readonly T[]} items  inputs
 * @param {number} limit  most workers running at once
 * @param {(item: T) => Promise<R>} worker  handles one input
 * @returns {Promise<R[]>} results in input order
 */
async function mapPool(items, limit, worker) {
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

/**
 * Pull every repo under `root`. Every repo is attempted regardless of failures.
 * @param {string} root  the folder holding the repos
 * @param {{ jobs?: number, onFound?: (names: string[]) => void, onResult?: (result: PullResult) => void }} [options]
 *   parallel pulls, a callback with the names of the repos found, and a callback per finished repo
 * @returns {Promise<PullResult[]>} one result per repo, sorted by name
 */
export async function pullAll(root, { jobs = DEFAULT_JOBS, onFound = () => {}, onResult = () => {} } = {}) {
  const repos = await findRepos(root);

  onFound(repos);

  return mapPool(repos, jobs, async (name) => {
    const result = await pullRepo(root, name);

    onResult(result);

    return result;
  });
}

/**
 * Arguments: nothing, a job count, or --help. Anything else is refused rather than guessed.
 * @param {string[]} argv  command-line arguments after the script name
 * @returns {{ help: boolean, jobs: number }} the parsed options
 */
export function parseArgs(argv) {
  if (argv.length === 1 && HELP_FLAGS.includes(argv[0])) {
    return { help: true, jobs: DEFAULT_JOBS };
  }

  if (argv.length === 0) {
    return { help: false, jobs: DEFAULT_JOBS };
  }

  const jobs = Number(argv[0]);

  if (argv.length > 1 || !WHOLE_NUMBER.test(argv[0]) || jobs < 1) {
    throw new UsageError(`Expected an optional job count (a whole number >= 1), got "${argv.join(' ')}".\n\n${HELP}`);
  }

  return { help: false, jobs };
}

/**
 * Pull all repos under the current folder and print the results.
 * @param {string[]} argv  command-line arguments after the command name
 * @param {import('../shared/index.mjs').RunContext} context  the folder to run in, where output and the progress
 *   line go
 * @returns {Promise<number>} exit code: 0 all pulled, 1 some failed, 2 a bad command line
 */
export async function main(argv, context) {
  let options;

  try {
    options = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) {
      throw err;
    }

    console.error(err.message);

    return EXIT_REFUSED;
  }

  const { help, jobs } = options;
  const { cwd: root, print, progress } = context;

  if (help) {
    print(HELP);

    return EXIT_OK;
  }

  progress.start('Finding repos');

  // The longest repo name sets the column width, so the branches line up. Keep in sync with run.mjs.
  let width = 0;

  const results = await pullAll(root, {
    jobs,
    onFound: (names) => {
      width = Math.max(0, ...names.map((name) => name.length));
      progress.start('Pull', names.length);
    },
    onResult: (result) => {
      const reason = result.skip ? `  ${result.skip}` : '';

      print(`${statusWord(result)}  ${result.name.padEnd(width)}  ${result.branch}${reason}`);
      progress.advance();
    },
  }).finally(progress.stop);

  if (results.length === 0) {
    print(`No git repositories found under ${root}`);

    return EXIT_OK;
  }

  const failed = results.filter((result) => !result.ok);
  const skipped = results.filter((result) => result.skip).length;
  const counts = `Done: ${results.length} repos${skipped ? `, ${skipped} skipped` : ''}`;

  print();

  if (failed.length === 0) {
    print(`${counts}, all up to date.`);

    return EXIT_OK;
  }

  print(`${counts}, ${failed.length} failed:`);

  for (const result of failed) {
    print(`\n--- ${result.name}`);
    print(result.output.replace(LINE_STARTS, DETAIL_INDENT));
  }

  return EXIT_FAILED;
}
