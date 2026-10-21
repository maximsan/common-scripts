// @ts-check
// lib/commands/devclean/caches.mjs - the cache section: the npm cache and the Yarn 1 cache, cleaned only through
// their own commands.

import { homedir } from 'node:os';
import {
  lastLine, measure, runShell, skippedItem, YARN_BERRY_MAJOR, yarnMajor,
} from '../../shared/index.mjs';

/** @typedef {import('../../shared/index.mjs').PlanItem} PlanItem */

const CACHE_TIMEOUT_MS = 10 * 60 * 1000;

const CACHE_COMMANDS = Object.freeze({
  npmLocation: 'npm config get cache',
  npmClean: 'npm cache clean --force',
  yarnLocation: 'yarn cache dir',
  yarnClean: 'yarn cache clean',
});

/**
 * Package manager caches, cleaned only through their own commands. Commands run from your home
 * folder, never from the temp folder, where anyone can drop files.
 * @param {string} [cwd]  folder to run the cache commands from
 * @returns {Promise<PlanItem[]>} one plan line per cache
 */
export async function planCaches(cwd = homedir()) {
  /**
   * Plan line for one cache.
   * @param {string} name  label in the plan
   * @param {string} dir  where the cache lives, for its size
   * @param {string} command  the package manager's own clean command
   * @returns {Promise<PlanItem>} the plan line
   */
  const cacheItem = async (name, dir, command) => ({
    name,
    detail: `${dir} -> ${command}`,
    bytes: await measure(dir).then((tree) => tree.bytes, () => null),
    skip: null,
    run: () => runShell(command, { cwd, timeout: CACHE_TIMEOUT_MS }),
  });

  const npmCache = await runShell(CACHE_COMMANDS.npmLocation, { cwd });
  const items = [
    npmCache.ok
      ? await cacheItem('npm cache', lastLine(npmCache.output), CACHE_COMMANDS.npmClean)
      : skippedItem('npm cache', 'npm not found'),
  ];
  const major = await yarnMajor(cwd);

  if (major === null) {
    items.push(skippedItem('yarn cache', 'yarn not found'));
  } else if (major < YARN_BERRY_MAJOR) {
    const yarnCache = await runShell(CACHE_COMMANDS.yarnLocation, { cwd });

    items.push(await cacheItem('yarn cache', lastLine(yarnCache.output), CACHE_COMMANDS.yarnClean));
  } else {
    // Yarn 2+ keeps a per-project cache (.yarn/cache) that may be committed (zero-installs): never clean it from here.
    items.push(skippedItem(`yarn ${major} cache`, 'per-project and possibly committed; left alone'));
  }

  return items;
}
