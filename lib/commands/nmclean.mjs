// @ts-check
// lib/commands/nmclean.mjs - delete node_modules in every git repo directly under the current folder,
// workspace packages included. What may be deleted: docs/safety-model.md.

import {
  DEFAULT_JOBS, EXIT_OK, findReposHere, NODE_MODULES, parseArgs, planAndRun, planFolders, SafetyError,
} from '../shared/index.mjs';

// Plan names use "/" on every system; a typed "\\" or a trailing "/" means the same folder.
const BACKSLASHES = /\\/g;
const TRAILING_SLASHES = /\/+$/;

const HELP = `Delete ${NODE_MODULES} in every git repo under the current folder. In a terminal: the plan,
then a list to pick from, then a y/N question; elsewhere only the plan.

  devkit nmclean [jobs] [--dry-run | --yes] [--only LIST]

  jobs         parallel deletions (default ${DEFAULT_JOBS})
  --only LIST  comma-separated repo names (all their ${NODE_MODULES}) or folder paths as the plan shows them;
               a name that matches nothing stops the run
  --dry-run    only print the plan
  --yes        take every item without the pick list and the confirmation; the only way without a terminal

Examples:
  devkit nmclean --only ue-shared,ue-wof               pick from two repos' folders
  devkit nmclean --only ue-shared/node_modules --yes   delete one folder without asking
`;

/**
 * The repo a plan name belongs to: the part before the first "/".
 * @param {string} name  a repo name or a folder path such as "app/packages/ui/node_modules"
 * @returns {string} the repo name
 */
const repoOf = (name) => name.split('/')[0];

/**
 * Plan, and after the person picks and confirms, delete every node_modules under the current folder.
 * @param {string[]} argv  command-line arguments after the script name
 * @param {import('../shared/index.mjs').RunContext} context  the folder, state folder, output and confirmation to use
 * @returns {Promise<number>} exit code
 */
export async function main(argv, context) {
  const options = parseArgs(argv, {
    defaults: { only: /** @type {Set<string> | null} */ (null) },
    lists: { '--only': { key: 'only' } },
  });

  if (options.help) {
    context.print(HELP);

    return EXIT_OK;
  }

  const { root, repos: found } = await findReposHere(context);
  const only = options.only
    && new Set([...options.only].map((name) => name.replace(BACKSLASHES, '/').replace(TRAILING_SLASHES, '')));

  // Only the named repos are searched, so --only also saves the time of measuring the others.
  const repos = only ? found.filter((repo) => [...only].some((name) => repoOf(name) === repo.name)) : found;

  context.progress.start(`Checking ${NODE_MODULES}`, repos.length);

  const planned = await planFolders(repos, [NODE_MODULES], { ...options, onRepoDone: context.progress.advance });
  const items = only ? planned.filter((item) => only.has(item.name) || only.has(repoOf(item.name))) : planned;
  const unknown = only && [...only].filter((name) => !found.some((repo) => repo.name === name)
    && !planned.some((item) => item.name === name));

  if (unknown?.length) {
    throw new SafetyError(`--only names no repo and no ${NODE_MODULES} folder here: ${unknown.join(', ')}. `
      + 'Nothing was changed.');
  }

  const { code } = await planAndRun({
    sections: [{ title: `${NODE_MODULES} in repos under ${root}`, items }],
    options,
    verb: 'delete',
    args: argv,
    context,
  });

  return code;
}
