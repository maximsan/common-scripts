// @ts-check
// lib/commands/nminstall.mjs - lockfile-exact install in every git repo directly under the current folder
// (docs/adr/0004-lockfile-exact-installs.md). An existing node_modules is checked as in docs/safety-model.md.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  checkRepoFolder, errorCode, EXIT_OK, exists, findReposHere, LINE_BREAK, NODE_MODULES, PACKAGE_JSON,
  parseArgs, planAndRun, removeRepoFolder, runShell, skippedItem, TEXT_ENCODING, YARN_BERRY_MAJOR, yarnMajor,
} from '../shared/index.mjs';

// Installs compete for disk and network; one at a time by default.
const DEFAULT_INSTALL_JOBS = 1;

const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const MS_PER_SECOND = 1000;
const OUTPUT_TAIL_LINES = 25;
const YARN_CONFIG = '.yarnrc.yml';

// "yarn@4.5.0+sha512..." -> name "yarn", major "4".
const PACKAGE_MANAGER_FIELD = /^([a-z]+)@(\d+)/;

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

const HELP = `Lockfile-exact install in every git repo under the current folder. In a terminal: the plan,
then a list to pick from, then a typed "yes"; elsewhere only the plan.

  devkit install [jobs] [--dry-run | --yes]

  jobs       parallel installs (default ${DEFAULT_INSTALL_JOBS})
  --dry-run  only print the plan
  --yes      take every repo without the pick list and the confirmation; the only way without a terminal

The lockfile picks the command:
  ${LOCKFILES.npm.join(' or ')}  ->  ${COMMANDS.npm}
  ${LOCKFILES.yarn.join(' or ')}, Yarn 1  ->  ${COMMANDS.yarnClassic}
  ${LOCKFILES.yarn.join(' or ')}, Yarn ${YARN_BERRY_MAJOR}+  ->  ${COMMANDS.yarnBerry}
The Yarn version comes from the packageManager field in ${PACKAGE_JSON}; without that field, a ${YARN_CONFIG}
means Yarn ${YARN_BERRY_MAJOR}+.

A repo is skipped, with the reason in the plan, when it has no lockfile, both an npm and a Yarn lockfile,
a packageManager field that names another manager than the lockfile, or uses pnpm or bun.
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
  if (plan.manager !== 'npm') {
    return nodeModulesProblem(repoReal);
  }

  const target = path.join(repoReal, NODE_MODULES);

  if (!(await exists(target))) {
    return null;
  }

  const removal = await removeRepoFolder(repoReal, target);

  return removal.ok ? null : `existing ${NODE_MODULES} ${removal.output}`;
}

/**
 * Install one repo. Never rejects.
 * @param {string} repoReal  resolved repo folder
 * @param {InstallPlan} plan  how to install it
 * @returns {Promise<import('../shared/index.mjs').RunResult>} ok, or the reason and the end of the install output
 */
async function installRepo(repoReal, plan) {
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
 * The plan line of one repo: the install command, or why the repo is skipped.
 * @param {import('../shared/index.mjs').Repo} repo  the repo to install
 * @returns {Promise<import('../shared/index.mjs').PlanItem>} the plan line
 */
async function planInstall(repo) {
  const plan = await detectPackageManager(repo.real);

  if ('skip' in plan) {
    return skippedItem(repo.name, plan.skip);
  }

  const problem = await nodeModulesProblem(repo.real);

  return problem
    ? skippedItem(repo.name, problem)
    : { name: repo.name, detail: plan.command, skip: null, run: () => installRepo(repo.real, plan) };
}

/**
 * Plan, and after the person picks and confirms, run a lockfile-exact install in every repo under the current folder.
 * @param {string[]} argv  command-line arguments after the script name
 * @param {import('../shared/index.mjs').RunContext} context  the folder, state folder, output and confirmation to use
 * @returns {Promise<number>} exit code
 */
export async function main(argv, context) {
  const options = parseArgs(argv, { defaults: { jobs: DEFAULT_INSTALL_JOBS } });

  if (options.help) {
    context.print(HELP);

    return EXIT_OK;
  }

  const { root, repos } = await findReposHere(context);

  context.progress.start('Checking lockfiles', repos.length);

  const items = [];

  for (const repo of repos) {
    items.push(await planInstall(repo));
    context.progress.advance();
  }

  const title = `Installs for repos under ${root} (replaces ${NODE_MODULES}, runs install scripts)`;
  const { code } = await planAndRun({
    sections: [{ title, items }],
    options,
    verb: 'install',
    command: 'install',
    args: argv,
    context,
  });

  return code;
}
