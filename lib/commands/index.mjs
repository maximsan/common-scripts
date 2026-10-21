// @ts-check
// lib/commands/index.mjs - the list of commands that index.mjs can start.
// To add a command: put its file in this folder, exporting `main(argv, context)`, and add one line below.

import { main as devclean } from './devclean/index.mjs';
import { main as gpall } from './gpall.mjs';
import { main as nmclean } from './nmclean.mjs';
import { main as nminstall } from './nminstall.mjs';
import { main as npmrctoken } from './npmrctoken.mjs';

/**
 * A command's work: takes the arguments after the command name, returns the exit code.
 * @typedef {(argv: string[], context: import('../shared/index.mjs').RunContext) => Promise<number>} Main
 */

/**
 * A command: its work, the one-line summary that `devkit --help` shows, and other names that also start it.
 * @typedef {{ main: Main, summary: string, aliases: string[] }} Command
 */

/**
 * Every command by name.
 * @type {Readonly<Record<string, Command>>}
 */
export const COMMANDS = Object.freeze({
  pull: { main: gpall, summary: 'pull every repo (git pull --ff-only --prune)', aliases: ['gpall'] },
  nmclean: { main: nmclean, summary: 'delete node_modules in every repo under the current folder', aliases: [] },
  install: { main: nminstall, summary: 'lockfile-exact install in every repo', aliases: ['nminstall'] },
  devclean: {
    main: devclean,
    summary: 'periodic cleanup: old node_modules, build outputs, temp entries, caches',
    aliases: [],
  },
  token: { main: npmrctoken, summary: 'put a new registry token into every .npmrc', aliases: ['npmrctoken'] },
});

/**
 * Find a command by its name or one of its aliases.
 * @param {string} name  what was typed after devkit
 * @returns {Command | undefined} the command, or undefined when no command has that name
 */
export function findCommand(name) {
  return Object.entries(COMMANDS).find(([key, { aliases }]) => key === name || aliases.includes(name))?.[1];
}
