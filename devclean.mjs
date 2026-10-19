#!/usr/bin/env node
// @ts-check
// devclean.mjs - periodic cleanup of a dev machine, plus a review-only report of agent files.
// Dry run by default; run it from your repos folder. See HELP below for usage and defaults.
//
// Sections (pick with --only):
//   node_modules  in repos whose working tree has not changed for --days
//   build         git-ignored build outputs (BUILD_DIRS) not rebuilt for --build-days
//   temp          your own temp-folder entries with nothing newer than --temp-days
//   cache         the npm cache and the Yarn 1 cache, cleaned only through their own commands
// Files from Claude Code and other agents (untracked files in repos, ~/.claude) are reported, never deleted.
// After an applied run, --due stays quiet for DUE_AFTER_DAYS; put "node devclean.mjs --due" in .bashrc.

import { lstat, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  ageInDays, assertSafeRoot, DAY_MS, DEFAULT_JOBS, EXIT_OK, exists, findRepos, formatBytes, git, GIT_FOLDER,
  HOST_RULES, lastLine, measure, NODE_MODULES, NUL, parseArgs, planAndRun, planFolders, readState, resolveTempDir,
  runMain, runShell, safeRemoveOldFile, safeRemoveTree, skippedItem, TEXT_ENCODING, writeState, YARN_BERRY_MAJOR,
  yarnMajor,
} from './devkit-core.mjs';

export const SECTIONS = Object.freeze(['node_modules', 'build', 'temp', 'cache']);
export const BUILD_DIRS = Object.freeze(['.next', '.turbo', '.parcel-cache', 'coverage', 'dist', 'build']);

const DEFAULT_STALE_DAYS = 30;
const DEFAULT_BUILD_DAYS = 7;
const DEFAULT_TEMP_DAYS = 7;
const DUE_AFTER_DAYS = 7;
const ACTIVITY_MAX_FILES = 200_000; // a bigger working tree is treated as active (kept)
const CACHE_TIMEOUT_MS = 10 * 60 * 1000;
const UNTRACKED_SHOWN_PER_REPO = 10;
const AGE_COLUMN_WIDTH = 5;
const SIZE_COLUMN_WIDTH = 9;

const CLAUDE_FOLDER = '.claude';
const CLAUDE_SETTINGS = 'settings.json';
const CLAUDE_DEFAULT_CLEANUP_DAYS = 30; // Claude Code's documented default for cleanupPeriodDays

const UNTRACKED_PREFIX = '?? '; // `git status --porcelain` marks untracked files this way
const SECRET_FILE = /(^|\/)\.env/;

const CACHE_COMMANDS = Object.freeze({
  npmLocation: 'npm config get cache',
  npmClean: 'npm cache clean --force',
  yarnLocation: 'yarn cache dir',
  yarnClean: 'yarn cache clean',
});

const HELP = `Periodic cleanup for the repos under the current folder (dry run by default).

  node devclean.mjs [jobs] [--apply] [--yes] [--days N] [--build-days N] [--temp-days N] [--only LIST]
  node devclean.mjs --due

  jobs            parallel deletions (default ${DEFAULT_JOBS})
  --days N        ${NODE_MODULES} in repos unchanged for N days (default ${DEFAULT_STALE_DAYS})
  --build-days N  ${BUILD_DIRS.join(', ')} not rebuilt for N days (default ${DEFAULT_BUILD_DAYS})
  --temp-days N   temp-folder entries with nothing newer than N days (default ${DEFAULT_TEMP_DAYS})
  --only LIST     comma-separated subset of: ${SECTIONS.join(',')}
  --apply         actually clean (otherwise only the plan is printed)
  --yes           skip the confirmation prompt (needed without an interactive terminal)
  --due           print a reminder if the last applied cleanup is ${DUE_AFTER_DAYS}+ days old
`;

/** @typedef {import('./devkit-core.mjs').Repo} Repo */
/** @typedef {import('./devkit-core.mjs').PlanItem} PlanItem */
/** @typedef {import('./devkit-core.mjs').PlanSection} PlanSection */
/** @typedef {import('./devkit-core.mjs').RunContext} RunContext */

/**
 * Newest file change in a repo's working tree; node_modules, .git and build outputs are ignored.
 * @param {Repo} repo  the repo to look at
 * @returns {Promise<number>} mtime in ms; the current time when the tree is too big to scan
 */
export async function repoActivity(repo) {
  const skipNames = new Set([NODE_MODULES, GIT_FOLDER, ...BUILD_DIRS]);
  const tree = await measure(repo.real, { skipNames, maxFiles: ACTIVITY_MAX_FILES });

  return tree.truncated ? Date.now() : tree.newest;
}

/**
 * node_modules in repos whose working tree has not changed for `staleDays`.
 * @param {Repo[]} repos  repos to search
 * @param {{ staleDays: number, jobs?: number, now?: number }} options
 *   days without a change, parallel repos, and the time to measure ages from
 * @returns {Promise<PlanItem[]>} one plan line per node_modules found
 */
export function planStaleNodeModules(repos, { staleDays, jobs = DEFAULT_JOBS, now = Date.now() }) {
  /** @type {Map<string, number>} */
  const activity = new Map();

  /**
   * Keep node_modules of a repo that changed recently.
   * @type {import('./devkit-core.mjs').KeepRule}
   */
  const keepIfActive = async (_tree, repo, { fresh }) => {
    const cached = activity.get(repo.name);
    const changed = fresh || cached === undefined ? await repoActivity(repo) : cached;

    activity.set(repo.name, changed);

    const days = ageInDays(changed, now);

    return days < staleDays ? `repo changed ${days} day(s) ago (< ${staleDays})` : null;
  };

  return planFolders(repos, [NODE_MODULES], { jobs, keepIf: keepIfActive });
}

/**
 * Git-ignored build output folders not rebuilt for `buildDays`.
 * @param {Repo[]} repos  repos to search
 * @param {{ buildDays: number, jobs?: number, now?: number }} options
 *   days without a rebuild, parallel repos, and the time to measure ages from
 * @returns {Promise<PlanItem[]>} one plan line per build folder found
 */
export function planBuildOutputs(repos, { buildDays, jobs = DEFAULT_JOBS, now = Date.now() }) {
  /**
   * Keep a build folder that was rebuilt recently.
   * @type {import('./devkit-core.mjs').KeepRule}
   */
  const keepIfRecent = async (tree) => {
    const days = ageInDays(tree.newest, now);

    return days < buildDays ? `built ${days} day(s) ago (< ${buildDays})` : null;
  };

  return planFolders(repos, BUILD_DIRS, { jobs, keepIf: keepIfRecent });
}

/**
 * True when the current user owns the entry. On a shared temp folder (Linux /tmp) other users' entries
 * are kept. Windows reports no owner here; its temp folder is per user anyway.
 * @param {import('node:fs').Stats} info  the entry's lstat result
 * @returns {boolean} whether it may be deleted on ownership grounds
 */
const ownedByMe = (info) => !HOST_RULES.fileOwners || info.uid === process.getuid?.();

/**
 * Top-level temp-folder entries with nothing newer than `tempDays`. Links and other users' entries are
 * left alone. Each entry is re-checked right before deletion and kept if anything inside changed meanwhile.
 * @param {string} tempReal  resolved temp folder
 * @param {{ tempDays: number, now?: number }} options  age threshold, and the time to measure ages from
 * @returns {Promise<{ items: PlanItem[], keptCount: number }>} entries to delete, and how many were kept
 */
export async function planTemp(tempReal, { tempDays, now = Date.now() }) {
  const cutoff = now - tempDays * DAY_MS;
  /** @type {PlanItem[]} */
  const items = [];
  let keptCount = 0;

  for (const name of await readdir(tempReal)) {
    const full = path.join(tempReal, name);
    let info;

    try {
      info = await lstat(full);
    } catch {
      continue;
    }

    if (info.isSymbolicLink() || !ownedByMe(info)) {
      keptCount += 1;
      continue;
    }

    const isFolder = info.isDirectory();
    const tree = isFolder ? await measure(full) : { bytes: info.size, newest: info.mtimeMs };

    if (tree.newest >= cutoff) {
      keptCount += 1;
      continue;
    }

    /**
     * Delete the entry unless something in it changed since planning.
     * @returns {Promise<import('./devkit-core.mjs').RunResult>} ok, or why it was kept
     */
    const removeIfStillOld = async () => {
      if (!isFolder) {
        return safeRemoveOldFile(full, tempReal, cutoff);
      }

      const newest = await measure(full).then((current) => current.newest, () => Infinity);

      if (newest >= cutoff) {
        return { ok: false, output: 'modified since planning (kept)' };
      }

      return safeRemoveTree(full, tempReal);
    };

    items.push({ name, bytes: tree.bytes, skip: null, run: removeIfStillOld });
  }

  return { items, keptCount };
}

/**
 * Package manager caches, cleaned only through their own commands. Commands run from your home
 * folder, never from the temp folder, where anyone can drop files.
 * @param {string} [cwd]  folder to run the cache commands from
 * @returns {Promise<PlanItem[]>} one plan line per cache
 */
export async function planCaches(cwd = homedir()) {
  /**
   * Plan line for one cache.
   * @param {string} name  label in the plan
   * @param {string} dir  where the cache lives, for its size
   * @param {string} command  the package manager's own clean command
   * @returns {Promise<PlanItem>} the plan line
   */
  const cacheItem = async (name, dir, command) => ({
    name,
    detail: `${dir} -> ${command}`,
    bytes: await measure(dir).then((tree) => tree.bytes, () => null),
    skip: null,
    run: () => runShell(command, { cwd, timeout: CACHE_TIMEOUT_MS }),
  });

  const npmCache = await runShell(CACHE_COMMANDS.npmLocation, { cwd });
  const items = [
    npmCache.ok
      ? await cacheItem('npm cache', lastLine(npmCache.output), CACHE_COMMANDS.npmClean)
      : skippedItem('npm cache', 'npm not found'),
  ];
  const major = await yarnMajor(cwd);

  if (major === null) {
    items.push(skippedItem('yarn cache', 'yarn not found'));
  } else if (major < YARN_BERRY_MAJOR) {
    const yarnCache = await runShell(CACHE_COMMANDS.yarnLocation, { cwd });

    items.push(await cacheItem('yarn cache', lastLine(yarnCache.output), CACHE_COMMANDS.yarnClean));
  } else {
    // Yarn 2+ keeps a per-project cache (.yarn/cache) that may be committed (zero-installs): never clean it from here.
    items.push(skippedItem(`yarn ${major} cache`, 'per-project and possibly committed; left alone'));
  }

  return items;
}

/**
 * Untracked files in a repo, newest first. This is where scratch files from agents show up.
 * @param {Repo} repo  the repo to look at
 * @returns {Promise<{ relativePath: string, bytes: number, mtime: number }[]>} the files, newest first
 */
async function untrackedFiles(repo) {
  const status = await git(['-C', repo.real, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);

  if (!status.ok) {
    return [];
  }

  const files = [];

  for (const entry of status.stdout.split(NUL)) {
    if (!entry.startsWith(UNTRACKED_PREFIX)) {
      continue;
    }

    const relativePath = entry.slice(UNTRACKED_PREFIX.length);

    try {
      const info = await lstat(path.join(repo.real, relativePath));

      files.push({ relativePath, bytes: info.size, mtime: info.mtimeMs });
    } catch {
      // removed meanwhile
    }
  }

  return files.sort((left, right) => right.mtime - left.mtime);
}

/**
 * Claude Code's cleanupPeriodDays from ~/.claude/settings.json.
 * @param {string} claudeDir  the ~/.claude folder
 * @returns {Promise<string>} the configured number of days, or the default with a note
 */
async function claudeCleanupDays(claudeDir) {
  try {
    const settings = JSON.parse(await readFile(path.join(claudeDir, CLAUDE_SETTINGS), TEXT_ENCODING));

    if (Number.isInteger(settings.cleanupPeriodDays)) {
      return String(settings.cleanupPeriodDays);
    }
  } catch {
    // no settings file: the default applies
  }

  return `${CLAUDE_DEFAULT_CLEANUP_DAYS}, the default`;
}

/**
 * Print what Claude Code and other agents left behind. Review only: nothing is deleted.
 * @param {Repo[]} repos  repos whose untracked files are listed
 * @param {RunContext['print']} print  where output goes
 * @param {{ now?: number, home?: string }} [options]  the time to measure ages from, and the home folder
 */
export async function reportAgentFiles(repos, print, { now = Date.now(), home = homedir() } = {}) {
  print('\nFiles from Claude Code and other agents (review only, never deleted)');

  const claudeDir = path.join(home, CLAUDE_FOLDER);

  if (await exists(claudeDir)) {
    const size = formatBytes((await measure(claudeDir)).bytes);

    print(`  ~/.claude is ${size}. Claude Code deletes its own transcripts and`);
    print(`  session files after cleanupPeriodDays (${await claudeCleanupDays(claudeDir)}); `
      + 'lower it in ~/.claude/settings.json to keep less.');
    print('  For a project folder you no longer use: claude project purge <path> --dry-run');
  }

  for (const repo of repos) {
    const files = await untrackedFiles(repo);

    if (!files.length) {
      continue;
    }

    print(`  ${repo.name}: ${files.length} untracked file(s), newest first`);

    for (const file of files.slice(0, UNTRACKED_SHOWN_PER_REPO)) {
      const warning = SECRET_FILE.test(file.relativePath) ? '  (may hold secrets: review by hand)' : '';
      const age = `${ageInDays(file.mtime, now)}d`.padStart(AGE_COLUMN_WIDTH);

      print(`    ${age}  ${formatBytes(file.bytes).padStart(SIZE_COLUMN_WIDTH)}  ${file.relativePath}${warning}`);
    }

    if (files.length > UNTRACKED_SHOWN_PER_REPO) {
      print(`    ... and ${files.length - UNTRACKED_SHOWN_PER_REPO} more (git status in ${repo.name})`);
    }
  }
}

/**
 * One line when the last applied cleanup is overdue, nothing otherwise. Never throws, so it is safe in .bashrc.
 * @param {RunContext} context  where the saved state is and where output goes
 * @param {{ dueDays?: number, now?: number }} [options]  days between cleanups, and the current time
 */
export async function printIfDue({ stateDir, print }, { dueDays = DUE_AFTER_DAYS, now = Date.now() } = {}) {
  try {
    const last = Date.parse((await readState(stateDir)).lastCleanup ?? '');

    if (Number.isNaN(last)) {
      print('devclean: no cleanup recorded yet. Run "devclean" in your repos folder to review (dry run).');
    } else if (now - last >= dueDays * DAY_MS) {
      print(`devclean: last cleanup ${ageInDays(last, now)} days ago. Run "devclean" to review (dry run).`);
    }
  } catch {
    // never break a shell startup
  }
}

/**
 * The temp section, or null with a printed reason when the temp folder is not where it should be.
 * @param {RunContext} context  the temp folder, and where output goes
 * @param {{ tempDays: number, now: number }} options  age threshold, and the time to measure ages from
 * @returns {Promise<PlanSection | null>} the section, or null when skipped
 */
async function tempSection({ tempDir, print }, { tempDays, now }) {
  try {
    const tempReal = await resolveTempDir({ temp: tempDir });
    const { items, keptCount } = await planTemp(tempReal, { tempDays, now });
    const title = `Temp-folder entries with nothing newer than ${tempDays} days (${tempReal}); `
      + `${keptCount} kept (newer, a link, or another user's)`;

    return { title, items };
  } catch (err) {
    print(`\nTemp folder: ${err instanceof Error ? err.message : err}`);

    return null;
  }
}

/**
 * Plan, and with --apply run, the periodic cleanup; or print the --due reminder.
 * @param {string[]} argv  command-line arguments after the script name
 * @param {RunContext} context  the folders, output and confirmation to use
 * @returns {Promise<number>} exit code
 */
export async function main(argv, context) {
  const options = parseArgs(argv, {
    defaults: {
      due: false,
      staleDays: DEFAULT_STALE_DAYS,
      buildDays: DEFAULT_BUILD_DAYS,
      tempDays: DEFAULT_TEMP_DAYS,
      only: new Set(SECTIONS),
    },
    booleans: { '--due': ['due', true] },
    numbers: { '--days': 'staleDays', '--build-days': 'buildDays', '--temp-days': 'tempDays' },
    lists: { '--only': { key: 'only', allowed: SECTIONS } },
  });

  if (options.help) {
    context.print(HELP);

    return EXIT_OK;
  }

  if (options.due) {
    await printIfDue(context);

    return EXIT_OK;
  }

  const root = await assertSafeRoot(context.cwd);
  const repos = await findRepos(root);
  const now = Date.now();

  await reportAgentFiles(repos, context.print, { now });

  /** @type {PlanSection[]} */
  const sections = [];

  if (options.only.has('node_modules')) {
    sections.push({
      title: `Stale ${NODE_MODULES} (repo unchanged for ${options.staleDays}+ days)`,
      items: await planStaleNodeModules(repos, { ...options, now }),
    });
  }

  if (options.only.has('build')) {
    sections.push({
      title: `Build outputs (git-ignored, not rebuilt for ${options.buildDays}+ days)`,
      items: await planBuildOutputs(repos, { ...options, now }),
    });
  }

  if (options.only.has('temp')) {
    const section = await tempSection(context, { tempDays: options.tempDays, now });

    if (section) {
      sections.push(section);
    }
  }

  if (options.only.has('cache')) {
    sections.push({ title: 'Package manager caches (cleaned through their own commands)', items: await planCaches() });
  }

  const { code, applied } = await planAndRun({ sections, options, verb: 'clean', logName: 'devclean', context });

  if (applied) {
    await writeState(context.stateDir, { lastCleanup: new Date(now).toISOString() });
  }

  return code;
}

runMain(import.meta.url, main);
