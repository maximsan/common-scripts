// @ts-check
// core/cli.mjs - command-line parsing and starting a script.

import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DEFAULT_JOBS, EXIT_REFUSED } from './constants.mjs';
import { SafetyError } from './errors.mjs';
import { samePath } from './paths.mjs';
import { processContext } from './state.mjs';

/** @typedef {import('./run.mjs').BaseOptions} BaseOptions */
/** @typedef {import('./state.mjs').RunContext} RunContext */

const WHOLE_NUMBER = /^\d+$/;
const LIST_SEPARATOR = ',';
const SCRIPT_ARGS_START = 2; // process.argv holds node and the script path first

/**
 * Parse a whole number of at least 1. Throws SafetyError otherwise.
 * @param {string | undefined} value  the text after the flag
 * @param {string} flag  used in the error message
 * @returns {number} the number
 */
function positiveInt(value, flag) {
  const number = Number(value);

  if (!Number.isInteger(number) || number < 1) {
    throw new SafetyError(`${flag} needs a whole number >= 1. Nothing was changed.`);
  }

  return number;
}

/**
 * gpall-style arguments: an optional bare number is the parallel job count; everything else must be a
 * known flag. Unknown flags stop the run, so a typo like --aply can never be mistaken for --apply.
 * @template {object} Defaults
 * @param {string[]} argv  command-line arguments after the script name
 * @param {{ defaults: Defaults,
 *           booleans?: Record<string, [keyof Defaults, boolean]>,
 *           numbers?: Record<string, keyof Defaults>,
 *           lists?: Record<string, { key: keyof Defaults, allowed: readonly string[] }> }} spec
 *   the script's own flags: which option each sets, and the default values
 * @returns {BaseOptions & Defaults} the parsed options
 */
export function parseArgs(argv, { defaults, booleans = {}, numbers = {}, lists = {} }) {
  const options = { apply: false, yes: false, help: false, jobs: DEFAULT_JOBS, ...defaults };
  /** @type {Record<string, unknown>} */
  const fields = options;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (WHOLE_NUMBER.test(arg)) {
      options.jobs = positiveInt(arg, 'jobs');
    } else if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--yes') {
      options.yes = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (Object.hasOwn(booleans, arg)) {
      const [key, value] = booleans[arg];

      fields[String(key)] = value;
    } else if (Object.hasOwn(numbers, arg)) {
      index += 1;
      fields[String(numbers[arg])] = positiveInt(argv[index], arg);
    } else if (Object.hasOwn(lists, arg)) {
      const { key, allowed } = lists[arg];

      index += 1;

      const values = (argv[index] ?? '').split(LIST_SEPARATOR).filter(Boolean);

      if (!values.length || values.some((value) => !allowed.includes(value))) {
        throw new SafetyError(`${arg} accepts: ${allowed.join(LIST_SEPARATOR)}. Nothing was changed.`);
      }

      fields[String(key)] = new Set(values);
    } else {
      throw new SafetyError(`Unknown option "${arg}". Nothing was changed.`);
    }
  }

  return options;
}

/**
 * True when the module at `importMetaUrl` is the script node was started with. Compares real paths,
 * so a symlink, an 8.3 short path or a different letter case still counts. Never rejects.
 * @param {string} importMetaUrl  the module's import.meta.url
 * @returns {Promise<boolean>} whether node was started with it
 */
async function isEntryPoint(importMetaUrl) {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return samePath(await realpath(process.argv[1]), await realpath(fileURLToPath(importMetaUrl)));
  } catch {
    return false;
  }
}

/**
 * Run `main` with the process's run context, only when the calling file is executed directly (not when
 * tests import it). Exit codes: what `main` returns (0 ok, 1 some items failed), 2 refused by a safety check.
 * @param {string} importMetaUrl  the caller's import.meta.url
 * @param {(argv: string[], context: RunContext) => Promise<number>} main  the script's work; returns the exit code
 */
export async function runMain(importMetaUrl, main) {
  if (!(await isEntryPoint(importMetaUrl))) {
    return;
  }

  try {
    process.exitCode = await main(process.argv.slice(SCRIPT_ARGS_START), processContext());
  } catch (err) {
    console.error(err instanceof SafetyError ? err.message : err);
    process.exitCode = EXIT_REFUSED;
  }
}
