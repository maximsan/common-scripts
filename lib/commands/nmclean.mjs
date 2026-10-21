// @ts-check
// lib/commands/nmclean.mjs - delete node_modules in every git repo directly under the current folder,
// workspace packages included. What may be deleted: docs/safety-model.md.

import {
  DEFAULT_JOBS, EXIT_OK, findReposHere, NODE_MODULES, parseArgs, planAndRun, planFolders,
} from '../shared/index.mjs';

const HELP = `Delete ${NODE_MODULES} in every git repo under the current folder (dry run by default).

  devkit nmclean [jobs] [--apply] [--yes]

  jobs     parallel deletions (default ${DEFAULT_JOBS})
  --apply  pick folders from a list, then delete (otherwise only the plan is printed)
  --yes    take every item: skip the pick list and the confirmation prompt
           (needed without an interactive terminal)
`;

/**
 * Plan, and with --apply delete, every node_modules under the current folder.
 * @param {string[]} argv  command-line arguments after the script name
 * @param {import('../shared/index.mjs').RunContext} context  the folder, state folder, output and confirmation to use
 * @returns {Promise<number>} exit code
 */
export async function main(argv, context) {
  const options = parseArgs(argv, { defaults: {} });

  if (options.help) {
    context.print(HELP);

    return EXIT_OK;
  }

  const { root, repos } = await findReposHere(context);

  context.progress.start(`Checking ${NODE_MODULES}`, repos.length);

  const items = await planFolders(repos, [NODE_MODULES], { ...options, onRepoDone: context.progress.advance });
  const { code } = await planAndRun({
    sections: [{ title: `${NODE_MODULES} in repos under ${root}`, items }],
    options,
    verb: 'delete',
    command: 'nmclean',
    args: argv,
    context,
  });

  return code;
}
