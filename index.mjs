#!/usr/bin/env node
// @ts-check
// index.mjs - the one entry point: runs a command from lib/commands/ by name.

import { COMMANDS } from './lib/commands/index.mjs';
import { EXIT_OK, EXIT_REFUSED, HELP_FLAGS, runCommand } from './lib/shared/index.mjs';

// `process.argv` holds node and this file first.
const ARGS_START = 2;

const NAME_WIDTH = Math.max(...Object.keys(COMMANDS).map((name) => name.length));

const HELP = `Repo maintenance commands. Run them from the folder that holds your git repos.

  devkit <command> [options]      (without npm link: node index.mjs <command> [options])

${Object.entries(COMMANDS).map(([name, { summary }]) => `  ${name.padEnd(NAME_WIDTH)}  ${summary}`).join('\n')}

All except gpall only print a plan (a dry run) until you add --apply. Each command has --help.
`;

const [command, ...argv] = process.argv.slice(ARGS_START);

if (command === undefined || HELP_FLAGS.includes(command)) {
  console.log(HELP);
  process.exitCode = EXIT_OK;
} else if (Object.hasOwn(COMMANDS, command)) {
  await runCommand(COMMANDS[command].main, argv);
} else {
  // The text is not repeated: a token pasted in the wrong place must not end up in the output.
  console.error(`Unknown command. Nothing was changed.\n\n${HELP}`);
  process.exitCode = EXIT_REFUSED;
}
