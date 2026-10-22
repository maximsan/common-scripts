// @ts-check
// lib/shared/safe-root.mjs - where a script may run, and where the temp folder may be.

import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { SafetyError } from './errors.mjs';
import { isAtOrInside, realpathOrResolve, samePath } from './paths.mjs';
import { HOST_RULES } from './platform.mjs';

/** @typedef {import('./platform.mjs').PlatformRules} PlatformRules */

/**
 * Folders the scripts must never run inside, as the rules name them (not yet resolved).
 * @param {PlatformRules} rules  the system's rules
 * @param {{ home: string, env: NodeJS.ProcessEnv }} where  the home folder and the environment
 * @returns {[string, string][]} [label for the message, path] pairs
 */
export function protectedFolders(rules, { home, env }) {
  /** @type {[string, string][]} */
  const named = [];

  for (const name of rules.protectedEnvVars) {
    const value = env[name];

    if (value) {
      named.push([name, value]);
    }
  }

  for (const dir of rules.protectedSystemFolders) {
    named.push([dir, dir]);
  }

  for (const name of rules.protectedHomeFolders) {
    named.push([`~/${name}`, rules.paths.join(home, name)]);
  }

  return named;
}

/**
 * Why a resolved folder is a dangerous place to run in. Touches no disk, so tests can pass another
 * system's rules.
 * @param {string} rootReal  the resolved folder
 * @param {{ homeReal: string, folders: [string, string][], rules?: PlatformRules }} context
 *   the resolved home folder, the resolved protected folders, and the system's rules
 * @returns {string[]} the problems; empty when it is safe
 */
export function rootProblems(rootReal, { homeReal, folders, rules = HOST_RULES }) {
  const problems = [];

  if (rules.networkPrefixes.some((prefix) => rootReal.startsWith(prefix))) {
    problems.push('it is a network (UNC) path');
  }

  if (rules.paths.parse(rootReal).root === rootReal) {
    problems.push('it is a drive or filesystem root');
  }

  if (samePath(rootReal, homeReal, rules)) {
    problems.push('it is your home folder');
  }

  for (const [label, folder] of folders) {
    if (isAtOrInside(folder, rootReal, rules)) {
      problems.push(`it is inside ${label}${label === folder ? '' : ` (${folder})`}`);
    }
  }

  return problems;
}

/**
 * Resolve the folder a script runs in. Throws SafetyError when it is a dangerous place.
 * @param {string} root  the folder to check, usually the current folder
 * @param {{ home: string, env?: NodeJS.ProcessEnv, rules?: PlatformRules }} options
 *   the run context's home folder; the environment and rules are injectable for tests
 * @returns {Promise<string>} resolved root
 */
export async function assertSafeRoot(root, { home, env = process.env, rules = HOST_RULES }) {
  const real = await realpath(root);
  const homeReal = await realpathOrResolve(home);

  /** @type {[string, string][]} */
  const folders = [];

  for (const [label, dir] of protectedFolders(rules, { home: homeReal, env })) {
    folders.push([label, await realpathOrResolve(dir)]);
  }

  const problems = rootProblems(real, { homeReal, folders, rules });

  if (problems.length) {
    throw new SafetyError(`Refusing to run in ${real}: ${problems.join('; ')}.`);
  }

  return real;
}

/**
 * The user temp folder, accepted only where the rules' tempHomes put it, or in a subfolder.
 * @param {{ home: string, temp?: string, rules?: PlatformRules }} options
 *   the run context's home folder; the temp folder and rules are injectable for tests
 * @returns {Promise<string>} resolved temp folder
 */
export async function resolveTempDir({ home, temp = tmpdir(), rules = HOST_RULES }) {
  const real = await realpath(temp);
  const allowed = await Promise.all(rules.tempHomes(home).map(realpathOrResolve));

  if (allowed.some((folder) => isAtOrInside(folder, real, rules))) {
    return real;
  }

  const expected = allowed.length
    ? `expected ${allowed.join(' or ')} or a subfolder`
    : `no known temp folder on ${rules.name}`;

  throw new SafetyError(`TEMP is ${real}, ${expected}; temp cleanup skipped.`);
}
