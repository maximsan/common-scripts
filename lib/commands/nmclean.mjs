// @ts-check
// lib/commands/nmclean.mjs - delete node_modules in every git repo directly under the current folder,
// including nested workspace packages. Dry run by default; see HELP below for usage.
//
// Each folder is deleted only if it passes every check in lib/shared/repo-folder.mjs (git-ignored, no tracked
// files, no links followed, ...). A failed folder never stops the run: every folder is attempted,
// failures are listed at the end, and the exit code is 1 if any failed (2 if the run was refused).

import {
  assertSafeRoot, DEFAULT_JOBS, EXIT_OK, findRepos, NODE_MODULES, parseArgs, planAndRun, planFolders,
} from '../shared/index.mjs';

const HELP = `Delete ${NODE_MODULES} in every git repo under the current folder (dry run by default).

  devkit nmclean [jobs] [--apply] [--yes]

  jobs     parallel deletions (default ${DEFAULT_JOBS})
  --apply  actually delete (otherwise only the plan is printed)
  --yes    skip the confirmation prompt (needed without an interactive terminal)
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

  const root = await assertSafeRoot(context.cwd, { env: context.env });
  const repos = await findRepos(root);
  const items = await planFolders(repos, [NODE_MODULES], options);
  const { code } = await planAndRun({
    sections: [{ title: `${NODE_MODULES} in ${repos.length} repo(s) under ${root}`, items }],
    options,
    verb: 'delete',
    logName: 'nmclean',
    context,
  });

  return code;
}
