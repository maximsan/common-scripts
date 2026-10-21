// @ts-check
// lib/commands/devclean/index.mjs - periodic cleanup of a dev machine, plus a review-only report of agent files.
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
  --apply         pick sections from a list, then clean (otherwise only the plan is printed)
  --yes           take every section: skip the pick list and the confirmation prompt
                  (needed without an interactive terminal)
  --due           print a reminder if the last applied cleanup is ${DUE_AFTER_DAYS}+ days old

Examples:
  devkit devclean                                 dry run with the defaults
  devkit devclean --apply                         pick sections, then clean them
  devkit devclean --days 60 --only node_modules   dry run: node_modules of repos unchanged for 60+ days
  devkit devclean --only temp,cache --apply --yes clean the temp folder and caches without asking
`;

/** @typedef {import('../../shared/index.mjs').PlanItem} PlanItem */
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
    // Never break a shell startup.
  }
}

/**
 * Put a section's items on one line of the pick list, named as in --only.
 * @param {typeof SECTIONS[number]} name  the section's --only name
 * @param {PlanItem[]} items  the section's items
 * @returns {PlanItem[]} the items, with that group
 */
const inGroup = (name, items) => items.map((item) => ({ ...item, group: name }));

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
  const { progress } = context;
  const onRepoDone = progress.advance;

  progress.start('Listing untracked files');
  await reportAgentFiles(repos, context.print, now);

  /** @type {PlanSection[]} */
  const sections = [];

  if (options.only.has('node_modules')) {
    progress.start(`Checking ${NODE_MODULES}`, repos.length);
    sections.push({
      title: `Stale ${NODE_MODULES} (repo unchanged for ${options.staleDays}+ days)`,
      items: inGroup('node_modules', await planStaleNodeModules(repos, { ...options, now, onRepoDone })),
    });
  }

  if (options.only.has('build')) {
    progress.start('Checking build outputs', repos.length);
    sections.push({
      title: `Build outputs (git-ignored, not rebuilt for ${options.buildDays}+ days)`,
      items: inGroup('build', await planBuildOutputs(repos, { ...options, now, onRepoDone })),
    });
  }

  if (options.only.has('temp')) {
    progress.start('Checking the temp folder');

    const section = await tempSection(context, { tempDays: options.tempDays, now });

    if (section) {
      sections.push({ ...section, items: inGroup('temp', section.items) });
    }
  }

  if (options.only.has('cache')) {
    progress.start('Measuring caches');
    sections.push({
      title: 'Package manager caches (cleaned through their own commands)',
      items: inGroup('cache', await planCaches()),
    });
  }

  const { code, applied } = await planAndRun({
    sections,
    options,
    verb: 'clean',
    command: 'devclean',
    args: argv,
    context,
  });

  if (applied) {
    await writeState(context.stateDir, { lastCleanup: new Date(now).toISOString() });
  }

  return code;
}
