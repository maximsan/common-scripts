// @ts-check
// lib/commands/devclean/index.mjs - periodic cleanup of a dev machine, plus a review-only report of agent files.
// Dry run by default; run it from your repos folder. See HELP below for usage and defaults.
//
// Sections (pick with --only):
//   node_modules  in repos whose working tree has not changed for --days
//   build         git-ignored build outputs (BUILD_DIRS) not rebuilt for --build-days
//   temp          your own temp-folder entries with nothing newer than --temp-days
//   cache         the npm cache and the Yarn 1 cache, cleaned only through their own commands
// Files from Claude Code and other agents (untracked files in repos, ~/.claude) are reported, never deleted.
// After an applied run, --due stays quiet for DUE_AFTER_DAYS; put "devkit devclean --due" in .bashrc.
// Each section has its own file in this folder.

import {
  ageInDays, DAY_MS, DEFAULT_JOBS, EXIT_OK, findReposHere, NODE_MODULES, parseArgs, planAndRun,
  readState, writeState,
} from '../../shared/index.mjs';
import { reportAgentFiles } from './agent-files.mjs';
import { planCaches } from './caches.mjs';
import { BUILD_DIRS, planBuildOutputs, planStaleNodeModules } from './repo-folders.mjs';
import { tempSection } from './temp.mjs';

const SECTIONS = Object.freeze(['node_modules', 'build', 'temp', 'cache']);

const DEFAULT_STALE_DAYS = 30;
const DEFAULT_BUILD_DAYS = 7;
const DEFAULT_TEMP_DAYS = 7;
const DUE_AFTER_DAYS = 7;

const HELP = `Periodic cleanup for the repos under the current folder (dry run by default).

  devkit devclean [jobs] [--apply] [--yes] [--days N] [--build-days N] [--temp-days N] [--only LIST]
  devkit devclean --due

  jobs            parallel deletions (default ${DEFAULT_JOBS})
  --days N        ${NODE_MODULES} in repos unchanged for N days (default ${DEFAULT_STALE_DAYS})
  --build-days N  ${BUILD_DIRS.join(', ')} not rebuilt for N days (default ${DEFAULT_BUILD_DAYS})
  --temp-days N   temp-folder entries with nothing newer than N days (default ${DEFAULT_TEMP_DAYS})
  --only LIST     comma-separated subset of: ${SECTIONS.join(',')}
  --apply         actually clean (otherwise only the plan is printed)
  --yes           skip the confirmation prompt (needed without an interactive terminal)
  --due           print a reminder if the last applied cleanup is ${DUE_AFTER_DAYS}+ days old
`;

/** @typedef {import('../../shared/index.mjs').PlanSection} PlanSection */
/** @typedef {import('../../shared/index.mjs').RunContext} RunContext */

/**
 * One line when the last applied cleanup is overdue, nothing otherwise. Never throws, so it is safe in .bashrc.
 * @param {RunContext} context  where the saved state is and where output goes
 */
async function printIfDue({ stateDir, print }) {
  const now = Date.now();

  try {
    const last = Date.parse((await readState(stateDir)).lastCleanup ?? '');

    if (Number.isNaN(last)) {
      print('devclean: no cleanup recorded yet. Run "devclean" in your repos folder to review (dry run).');
    } else if (now - last >= DUE_AFTER_DAYS * DAY_MS) {
      print(`devclean: last cleanup ${ageInDays(last, now)} days ago. Run "devclean" to review (dry run).`);
    }
  } catch {
    // never break a shell startup
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

  const { repos } = await findReposHere(context);
  const now = Date.now();

  await reportAgentFiles(repos, context.print, now);

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
