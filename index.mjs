#!/usr/bin/env node
// @ts-check
// index.mjs - the one entry point: runs a command from lib/commands/ by name.
//   devkit <command> [options]      e.g.  devkit nmclean --apply
// `npm link` in this folder installs the devkit command (package.json "bin"); `node index.mjs` works the same.
// Runs on Windows, macOS and Linux. Node 18+, no dependencies. See README.md.

import { main as devclean } from './lib/commands/devclean.mjs';
import { main as gpall } from './lib/commands/gpall.mjs';
import { main as nmclean } from './lib/commands/nmclean.mjs';
import { main as nminstall } from './lib/commands/nminstall.mjs';
import { main as npmrctoken } from './lib/commands/npmrctoken.mjs';
import { runCommand } from './lib/shared/index.mjs';

const ARGS_START = 2; // process.argv holds node and this file first
const HELP_FLAGS = ['--help', '-h'];
const EXIT_OK = 0;
const EXIT_REFUSED = 2;

/** @typedef {(argv: string[], context: import('./lib/shared/index.mjs').RunContext) => Promise<number>} Main */

/** @type {Readonly<Record<string, { main: Main, summary: string }>>} */
const COMMANDS = Object.freeze({
  gpall: { main: gpall, summary: 'pull every repo (git pull --ff-only --prune)' },
  nmclean: { main: nmclean, summary: 'delete node_modules in every repo' },
  nminstall: { main: nminstall, summary: 'lockfile-exact install in every repo' },
  devclean: { main: devclean, summary: 'periodic cleanup: old node_modules, build outputs, temp entries, caches' },
  npmrctoken: { main: npmrctoken, summary: 'put a new registry token into every .npmrc' },
});

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
