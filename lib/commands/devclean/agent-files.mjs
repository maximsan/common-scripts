// @ts-check
// lib/commands/devclean/agent-files.mjs - the review-only report of files from Claude Code and other agents:
// untracked files in repos and the size of ~/.claude. Nothing here is deleted.

import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  ageInDays, exists, formatBytes, git, measure, NUL, TEXT_ENCODING,
} from '../../shared/index.mjs';

/** @typedef {import('../../shared/index.mjs').Repo} Repo */
/** @typedef {import('../../shared/index.mjs').RunContext} RunContext */

const UNTRACKED_SHOWN_PER_REPO = 10;
const AGE_COLUMN_WIDTH = 5;
const SIZE_COLUMN_WIDTH = 9;

const CLAUDE_FOLDER = '.claude';
const CLAUDE_SETTINGS = 'settings.json';

// Claude Code's documented default for cleanupPeriodDays.
const CLAUDE_DEFAULT_CLEANUP_DAYS = 30;

// `git status --porcelain` marks untracked files this way.
const UNTRACKED_PREFIX = '?? ';

const SECRET_FILE = /(^|\/)\.env/;

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
      // Removed meanwhile.
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
 * @param {number} now  the time to measure ages from
 */
export async function reportAgentFiles(repos, print, now) {
  print('\nFiles from Claude Code and other agents (review only, never deleted)');

  const claudeDir = path.join(homedir(), CLAUDE_FOLDER);

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
