#!/usr/bin/env node
// @ts-check
// index.mjs - the one entry point: runs a command from lib/commands/ by name.

import { COMMANDS, findCommand } from './lib/commands/index.mjs';
import { EXIT_OK, EXIT_REFUSED, HELP_FLAGS, runCommand } from './lib/shared/index.mjs';

// `process.argv` holds node and this file first.
const ARGS_START = 2;

const LABELS = Object.entries(COMMANDS).map(([name, { aliases, summary }]) => ({
  label: aliases.length ? `${name} (alias: ${aliases.join(', ')})` : name,
  summary,
}));
const LABEL_WIDTH = Math.max(...LABELS.map(({ label }) => label.length));

const HELP = `Repo maintenance commands. Run them from the folder that holds your git repos.

  devkit <command> [options]      (or: node index.mjs <command> [options])

${LABELS.map(({ label, summary }) => `  ${label.padEnd(LABEL_WIDTH)}  ${summary}`).join('\n')}

All except pull only print a plan (a dry run) until you add --apply. Each command has --help.
`;

const [name, ...argv] = process.argv.slice(ARGS_START);
const command = name === undefined ? undefined : findCommand(name);

if (name === undefined || HELP_FLAGS.includes(name)) {
  console.log(HELP);
  process.exitCode = EXIT_OK;
} else if (command) {
  await runCommand(command.main, argv);
} else {
  // The text is not repeated: a token pasted in the wrong place must not end up in the output.
  console.error(`Unknown command. Nothing was changed.\n\n${HELP}`);
  process.exitCode = EXIT_REFUSED;
}
