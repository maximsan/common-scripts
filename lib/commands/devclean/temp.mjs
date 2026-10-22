// @ts-check
// lib/commands/devclean/temp.mjs - the temp section: old temp entries (see docs/GLOSSARY.md).

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { checkTempEntry, DAY_MS, removeTempEntry, resolveTempDir } from '../../shared/index.mjs';

/** @typedef {import('../../shared/index.mjs').PlanItem} PlanItem */
/** @typedef {import('../../shared/index.mjs').PlanSection} PlanSection */
/** @typedef {import('../../shared/index.mjs').RunContext} RunContext */

/**
 * Temp entries (see docs/GLOSSARY.md) that checkTempEntry allows to delete. Each is checked again right before
 * deletion.
 * @param {string} tempReal  resolved temp folder
 * @param {{ tempDays: number, now?: number }} options  age threshold, and the time to measure ages from
 * @returns {Promise<{ items: PlanItem[], keptCount: number }>} entries to delete, and how many were kept
 */
export async function planTemp(tempReal, { tempDays, now = Date.now() }) {
  const cutoff = now - tempDays * DAY_MS;

  /** @type {PlanItem[]} */
  const items = [];
  let keptCount = 0;

  for (const name of await readdir(tempReal)) {
    const entry = path.join(tempReal, name);
    const { reason, bytes } = await checkTempEntry(tempReal, entry, cutoff);

    if (reason) {
      keptCount += 1;
    } else {
      items.push({ name, bytes, skip: null, run: () => removeTempEntry(tempReal, entry, cutoff) });
    }
  }

  return { items, keptCount };
}

/**
 * The temp section, or null with a printed reason when the temp folder is not where it should be.
 * @param {RunContext} context  the temp and home folders, and where output goes
 * @param {{ tempDays: number, now: number }} options  age threshold, and the time to measure ages from
 * @returns {Promise<PlanSection | null>} the section, or null when skipped
 */
export async function tempSection({ tempDir, home, print }, { tempDays, now }) {
  try {
    const tempReal = await resolveTempDir({ temp: tempDir, home });
    const { items, keptCount } = await planTemp(tempReal, { tempDays, now });
    const title = `Temp-folder entries with nothing newer than ${tempDays} days (${tempReal}); `
      + `${keptCount} kept (newer, in use, a link, another user's, or not a file or folder)`;

    return { title, items };
  } catch (err) {
    print(`\nTemp folder: ${err instanceof Error ? err.message : err}`);

    return null;
  }
}
