// @ts-check
// lib/commands/index.mjs - the list of commands that index.mjs can start.
// To add a command: put its file in this folder, exporting `main(argv, context)`, and add one line below.

import { main as devclean } from './devclean.mjs';
import { main as gpall } from './gpall.mjs';
import { main as nmclean } from './nmclean.mjs';
import { main as nminstall } from './nminstall.mjs';
import { main as npmrctoken } from './npmrctoken.mjs';

/**
 * A command's work: takes the arguments after the command name, returns the exit code.
 * @typedef {(argv: string[], context: import('../shared/index.mjs').RunContext) => Promise<number>} Main
 */

/**
 * Every command by name, with the one-line summary that `devkit --help` shows.
 * @type {Readonly<Record<string, { main: Main, summary: string }>>}
 */
export const COMMANDS = Object.freeze({
  gpall: { main: gpall, summary: 'pull every repo (git pull --ff-only --prune)' },
  nmclean: { main: nmclean, summary: 'delete node_modules in every repo' },
  nminstall: { main: nminstall, summary: 'lockfile-exact install in every repo' },
  devclean: { main: devclean, summary: 'periodic cleanup: old node_modules, build outputs, temp entries, caches' },
  npmrctoken: { main: npmrctoken, summary: 'put a new registry token into every .npmrc' },
});
