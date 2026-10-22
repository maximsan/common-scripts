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
const BUILD_DAYS = 7;
const TEMP_DAYS = 7;
const DUE_AFTER_DAYS = 7;

const HELP = `Periodic cleanup for the repos under the current folder. In a terminal: the plan,
then a list of sections to pick from, then a typed "yes"; elsewhere only the plan.

  devkit devclean [jobs] [--dry-run | --yes] [--days N] [--only LIST]
  devkit devclean --due

  jobs            parallel deletions (default ${DEFAULT_JOBS})
  --days N        ${NODE_MODULES} in repos unchanged for N days (default ${DEFAULT_STALE_DAYS})
  --only LIST     comma-separated subset of: ${SECTIONS.join(',')}
  --dry-run       only print the plan
  --yes           take every section without the pick list and the confirmation; the only way without
                  a terminal
  --due           print a reminder if the last applied cleanup is ${DUE_AFTER_DAYS}+ days old

Build outputs (${BUILD_DIRS.join(', ')}) count as old after ${BUILD_DAYS} days without a rebuild, and temp-folder
entries after ${TEMP_DAYS} days with nothing newer.

Examples:
  devkit devclean                                 the plan with the defaults, then pick and confirm
  devkit devclean --dry-run                       only the plan
  devkit devclean --days 60 --only node_modules   node_modules of repos unchanged for 60+ days
  devkit devclean --only temp,cache --yes         clean the temp folder and caches without asking
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
      print('devclean: no cleanup recorded yet. Run "devclean" in your repos folder to review and pick.');
    } else if (now - last >= DUE_AFTER_DAYS * DAY_MS) {
      print(`devclean: last cleanup ${ageInDays(last, now)} days ago. Run "devclean" to review and pick.`);
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
 * Plan, and after the person picks and confirms, run the periodic cleanup; or print the --due reminder.
 * @param {string[]} argv  command-line arguments after the script name
 * @param {RunContext} context  the folders, output and confirmation to use
 * @returns {Promise<number>} exit code
 */
export async function main(argv, context) {
  const options = parseArgs(argv, {
    defaults: {
      due: false,
      staleDays: DEFAULT_STALE_DAYS,
      only: new Set(SECTIONS),
    },
    booleans: { '--due': ['due', true] },
    numbers: { '--days': 'staleDays' },
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
  await reportAgentFiles(repos, context, now);

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
      title: `Build outputs (git-ignored, not rebuilt for ${BUILD_DAYS}+ days)`,
      items: inGroup('build', await planBuildOutputs(repos, { ...options, buildDays: BUILD_DAYS, now, onRepoDone })),
    });
  }

  if (options.only.has('temp')) {
    progress.start('Checking the temp folder');

    const section = await tempSection(context, { tempDays: TEMP_DAYS, now });

    if (section) {
      sections.push({ ...section, items: inGroup('temp', section.items) });
    }
  }

  if (options.only.has('cache')) {
    progress.start('Measuring caches');
    sections.push({
      title: 'Package manager caches (cleaned through their own commands)',
      items: inGroup('cache', await planCaches(context.home)),
    });
  }

  const { code, applied } = await planAndRun({
    sections,
    options,
    verb: 'clean',
    args: argv,
    context,
  });

  if (applied) {
    await writeState(context.stateDir, { lastCleanup: new Date(now).toISOString() });
  }

  return code;
}
