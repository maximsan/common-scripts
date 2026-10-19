#!/usr/bin/env node
// @ts-check
// nminstall.mjs - lockfile-exact install in every git repo directly under the current folder.
// Dry run by default; see HELP below for usage.
//
//   npm             -> npm ci                          (package-lock.json or npm-shrinkwrap.json)
//   Yarn 1          -> yarn install --frozen-lockfile  (yarn.lock)
//   Yarn 2 or later -> yarn install --immutable        (yarn.lock + packageManager yarn@2+, or no
//                                                       packageManager and a .yarnrc.yml)
//
// Lockfiles are never modified. Repos without a lockfile, with both lockfiles, with a packageManager
// field that contradicts the lockfile, or using pnpm/bun are skipped with the reason. An existing
// node_modules must pass the same checks as nmclean (checkRepoFolder), in the plan and again before the
// install, or the repo is not installed. A failed install never stops the run; failures are listed at the end.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  assertSafeRoot, checkRepoFolder, errorCode, EXIT_OK, exists, findRepos, NODE_MODULES, PACKAGE_JSON, parseArgs,
  planAndRun, removeRepoFolder, runMain, runShell, skippedItem, YARN_BERRY_MAJOR, yarnMajor,
} from './devkit-core.mjs';

const DEFAULT_INSTALL_JOBS = 1; // installs compete for disk and network; one at a time by default
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const MS_PER_SECOND = 1000;
const OUTPUT_TAIL_LINES = 25;
const YARN_CONFIG = '.yarnrc.yml';
const TEXT_ENCODING = 'utf8';
const LINE_BREAK = /\r?\n/;
const PACKAGE_MANAGER_FIELD = /^([a-z]+)@(\d+)/; // "yarn@4.5.0+sha512..." -> name "yarn", major "4"
const SUPPORTED_MANAGERS = ['npm', 'yarn'];

const LOCKFILES = Object.freeze({
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  yarn: ['yarn.lock'],
  unsupported: ['pnpm-lock.yaml', 'bun.lockb', 'bun.lock'],
});

const COMMANDS = Object.freeze({
  npm: 'npm ci',
  yarnClassic: 'yarn install --frozen-lockfile',
  yarnBerry: 'yarn install --immutable',
});

const HELP = `Lockfile-exact install in every git repo under the current folder (dry run by default).

  node nminstall.mjs [jobs] [--apply] [--yes]

  jobs     parallel installs (default ${DEFAULT_INSTALL_JOBS})
  --apply  actually install (otherwise only the plan is printed)
  --yes    skip the confirmation prompt (needed without an interactive terminal)
`;

/**
 * How to install a repo: the package manager, its generation, and the exact command.
 * @typedef {{ manager: 'npm' | 'yarn', berry: boolean, command: string }} InstallPlan
 */
/**
 * Why a repo is not installed.
 * @typedef {{ skip: string }} InstallSkip
 */

/**
 * Read a repo's package.json.
 * @param {string} repoReal  resolved repo folder
 * @returns {Promise<{ manifest: { packageManager?: unknown } } | InstallSkip>}
 *   the parsed file, or why it can't be used
 */
async function readManifest(repoReal) {
  try {
    return { manifest: JSON.parse(await readFile(path.join(repoReal, PACKAGE_JSON), TEXT_ENCODING)) };
  } catch (err) {
    const missing = errorCode(err) === 'ENOENT';

    return { skip: missing ? `no ${PACKAGE_JSON} (not a Node project)` : `${PACKAGE_JSON} is not valid JSON` };
  }
}

/**
 * Decide how to install one repo, lockfile-exact only.
 * @param {string} repoReal  resolved repo folder
 * @returns {Promise<InstallPlan | InstallSkip>} the install plan, or why the repo is skipped
 */
export async function detectPackageManager(repoReal) {
  const read = await readManifest(repoReal);

  if ('skip' in read) {
    return read;
  }

  /**
   * True when any of the named files exists in the repo.
   * @param {readonly string[]} names  file names
   * @returns {Promise<boolean>} whether at least one exists
   */
  const hasAny = async (names) => {
    const found = await Promise.all(names.map((name) => exists(path.join(repoReal, name))));

    return found.some(Boolean);
  };

  const [hasNpmLock, hasYarnLock, hasOtherLock] = await Promise.all([
    hasAny(LOCKFILES.npm), hasAny(LOCKFILES.yarn), hasAny(LOCKFILES.unsupported),
  ]);
  const { packageManager } = read.manifest;
  const declared = typeof packageManager === 'string' ? packageManager.match(PACKAGE_MANAGER_FIELD) : null;
  const [, declaredName, declaredMajor] = declared ?? [];

  if (declaredName && !SUPPORTED_MANAGERS.includes(declaredName)) {
    return { skip: `uses ${declaredName} (only npm and yarn are supported)` };
  }

  if (hasNpmLock && hasYarnLock) {
    return { skip: 'both package-lock.json and yarn.lock exist; remove the wrong one first' };
  }

  if (!hasNpmLock && !hasYarnLock) {
    return {
      skip: hasOtherLock
        ? 'uses pnpm or bun (only npm and yarn are supported)'
        : 'no lockfile; run npm install or yarn install by hand once',
    };
  }

  const lockName = hasNpmLock ? 'npm' : 'yarn';

  if (declaredName && declaredName !== lockName) {
    return { skip: `packageManager says ${declaredName} but the lockfile is ${lockName}` };
  }

  if (lockName === 'npm') {
    return { manager: 'npm', berry: false, command: COMMANDS.npm };
  }

  // A declared version decides; .yarnrc.yml (read only by Yarn 2+) is the fallback signal.
  const berry = declaredMajor
    ? Number(declaredMajor) >= YARN_BERRY_MAJOR
    : await exists(path.join(repoReal, YARN_CONFIG));

  return { manager: 'yarn', berry, command: berry ? COMMANDS.yarnBerry : COMMANDS.yarnClassic };
}

/**
 * Check that the yarn that would run in this repo is the generation the repo expects.
 * @param {string} repoReal  resolved repo folder
 * @param {boolean} berry  true when the repo needs Yarn 2+
 * @returns {Promise<string | null>} problem, or null when it matches
 */
async function checkYarnVersion(repoReal, berry) {
  const major = await yarnMajor(repoReal);

  if (major !== null && (major >= YARN_BERRY_MAJOR) === berry) {
    return null;
  }

  const needed = berry ? `Yarn ${YARN_BERRY_MAJOR}+` : 'Yarn 1';
  const found = major === null ? 'no yarn' : `Yarn ${major}`;

  return `needs ${needed} but found ${found}; enable Corepack or install the matching Yarn`;
}

/**
 * Why an existing node_modules must not be rewritten by an install (Yarn changes it in place, npm ci
 * deletes it). Absent is fine.
 * @param {string} repoReal  resolved repo folder
 * @returns {Promise<string | null>} problem, or null when the install may proceed
 */
async function nodeModulesProblem(repoReal) {
  const target = path.join(repoReal, NODE_MODULES);

  if (!(await exists(target))) {
    return null;
  }

  const { reason } = await checkRepoFolder(repoReal, target);

  return reason && `existing ${NODE_MODULES} ${reason}`;
}

/**
 * Get an existing node_modules ready right before the install, checking it again. For npm it is deleted
 * through the safe path, so npm ci finds none to delete itself.
 * @param {string} repoReal  resolved repo folder
 * @param {InstallPlan} plan  how the repo will be installed
 * @returns {Promise<string | null>} problem, or null when the install may proceed
 */
async function prepareNodeModules(repoReal, plan) {
  const target = path.join(repoReal, NODE_MODULES);

  if (plan.manager !== 'npm' || !(await exists(target))) {
    return nodeModulesProblem(repoReal);
  }

  const removal = await removeRepoFolder(repoReal, target);

  return removal.ok ? null : `existing ${NODE_MODULES}: ${removal.output}`;
}

/**
 * Install one repo. Never rejects.
 * @param {string} repoReal  resolved repo folder
 * @param {InstallPlan} plan  how to install it
 * @returns {Promise<import('./devkit-core.mjs').RunResult>} ok, or the reason and the end of the install output
 */
export async function installRepo(repoReal, plan) {
  const yarnProblem = plan.manager === 'yarn' ? await checkYarnVersion(repoReal, plan.berry) : null;
  const blocked = yarnProblem ?? (await prepareNodeModules(repoReal, plan));

  if (blocked) {
    return { ok: false, output: `${blocked}; install skipped` };
  }

  const started = Date.now();
  const outcome = await runShell(plan.command, { cwd: repoReal, timeout: INSTALL_TIMEOUT_MS });

  if (outcome.ok) {
    return { ok: true, output: '' };
  }

  const seconds = Math.round((Date.now() - started) / MS_PER_SECOND);
  const reason = outcome.timedOut ? `timed out after ${seconds}s` : `exit ${outcome.code} after ${seconds}s`;
  const tail = outcome.output.split(LINE_BREAK).slice(-OUTPUT_TAIL_LINES).join('\n');

  return { ok: false, output: `${reason}. Last lines:\n${tail}` };
}

/**
 * One plan line per repo: the install command, or why the repo is skipped.
 * @param {import('./devkit-core.mjs').Repo[]} repos  repos to install
 * @returns {Promise<import('./devkit-core.mjs').PlanItem[]>} the plan
 */
export async function planInstalls(repos) {
  const items = [];

  for (const repo of repos) {
    const plan = await detectPackageManager(repo.real);

    if ('skip' in plan) {
      items.push(skippedItem(repo.name, plan.skip));
      continue;
    }

    const problem = await nodeModulesProblem(repo.real);

    items.push(problem
      ? skippedItem(repo.name, problem)
      : { name: repo.name, detail: plan.command, skip: null, run: () => installRepo(repo.real, plan) });
  }

  return items;
}

/**
 * Plan, and with --apply run, a lockfile-exact install in every repo under the current folder.
 * @param {string[]} argv  command-line arguments after the script name
 * @param {import('./devkit-core.mjs').RunContext} context  the folder, state folder, output and confirmation to use
 * @returns {Promise<number>} exit code
 */
export async function main(argv, context) {
  const options = parseArgs(argv, { defaults: { jobs: DEFAULT_INSTALL_JOBS } });

  if (options.help) {
    context.print(HELP);

    return EXIT_OK;
  }

  const root = await assertSafeRoot(context.cwd);
  const repos = await findRepos(root);
  const title = `Installs for ${repos.length} repo(s) under ${root} (replaces ${NODE_MODULES}, runs install scripts)`;
  const { code } = await planAndRun({
    sections: [{ title, items: await planInstalls(repos) }],
    options,
    verb: 'install',
    logName: 'nminstall',
    context,
  });

  return code;
}

runMain(import.meta.url, main);
