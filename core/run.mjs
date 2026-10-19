// @ts-check
// core/run.mjs - plan items, running them in a pool, and the shared plan -> confirm -> run flow with its output.

import path from 'node:path';
import { DAY_MS, DEFAULT_JOBS, EXIT_FAILED, EXIT_OK } from './constants.mjs';
import { checkRepoFolder, removeRepoFolder } from './deletion.mjs';
import { findNamedDirs } from './discovery.mjs';
import { errorText } from './errors.mjs';
import { toPosix, trashBase } from './paths.mjs';
import { createLog, withLock } from './state.mjs';

/** @typedef {import('./discovery.mjs').Repo} Repo */
/** @typedef {import('./discovery.mjs').TreeInfo} TreeInfo */
/** @typedef {import('./state.mjs').RunContext} RunContext */

/**
 * Outcome of one action. `summary` replaces the plan detail on the ok line, e.g. a value read back after writing.
 * @typedef {{ ok: boolean, output: string, summary?: string }} RunResult
 */

/**
 * One finished plan item, reported like gpall's results.
 * @typedef {{ name: string, ok: boolean, output: string, summary?: string }} Result
 */

/**
 * One line of a plan. `skip` holds the reason it is kept; `run` performs it and never rejects.
 * @typedef {{
 *   name: string, detail?: string, bytes?: number | null, skip: string | null, run: () => Promise<RunResult>
 * }} PlanItem
 */

/** @typedef {{ title: string, items: PlanItem[] }} PlanSection */

/** @typedef {{ apply: boolean, yes: boolean, help: boolean, jobs: number }} BaseOptions  flags every script accepts */

/**
 * Decides whether a planned folder is kept: returns the reason to keep it, or null to delete it.
 * `fresh` is true on the re-check right before deletion, so cached values must be recomputed.
 * @typedef {(tree: TreeInfo, repo: Repo, context: { fresh: boolean }) => Promise<string | null>} KeepRule
 */

const NAME_COLUMN_WIDTH = 40; // same as gpall
const DETAIL_INDENT = '    ';
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
const BYTES_PER_UNIT = 1024;
const WHITESPACE_RUNS = /\s+/g;
const LINE_STARTS = /^/gm;

/**
 * Run `worker` over `items` with at most `limit` running at once (same as gpall).
 * @template T, R
 * @param {readonly T[]} items  inputs
 * @param {number} limit  most workers running at once
 * @param {(item: T) => Promise<R>} worker  handles one input
 * @returns {Promise<R[]>} results in input order
 */
export async function mapPool(items, limit, worker) {
  /** @type {R[]} */
  const results = new Array(items.length);
  let next = 0;

  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;

      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(lanes);

  return results;
}

/**
 * A plan line that is shown as kept and never runs.
 * @param {string} name  what the line is about
 * @param {string} reason  why it is kept
 * @returns {PlanItem} the plan line
 */
export const skippedItem = (name, reason) => ({ name, skip: reason, run: async () => ({ ok: false, output: reason }) });

/**
 * Plan deletion of allow-listed folders in one repo. Each item deletes through removeRepoFolder, which
 * checks the folder again first.
 * @param {Repo} repo  the repo to search
 * @param {readonly string[]} names  folder names to delete, e.g. [NODE_MODULES]
 * @param {{ keepIf?: KeepRule | null }} [options]  extra reason to keep a folder, e.g. its age
 * @returns {Promise<PlanItem[]>} one plan line per folder found
 */
async function planRepoDirs(repo, names, { keepIf = null } = {}) {
  /** @type {PlanItem[]} */
  const items = [];

  /**
   * The keep rule for one phase of the run.
   * @param {boolean} fresh  true right before deleting: cached values are recomputed
   * @returns {((tree: TreeInfo) => Promise<string | null>) | null} the rule, or null without one
   */
  const keepIfFor = (fresh) => keepIf && ((tree) => keepIf(tree, repo, { fresh }));

  for (const target of await findNamedDirs(repo.real, names)) {
    const planned = await checkRepoFolder(repo.real, target, { keepIf: keepIfFor(false) });
    const leftover = trashBase(path.basename(target)) !== null;

    items.push({
      name: `${repo.name}/${toPosix(path.relative(repo.real, target))}`,
      detail: leftover ? 'leftover of an earlier run' : '',
      bytes: planned.tree?.bytes ?? null,
      skip: planned.reason,
      run: () => removeRepoFolder(repo.real, target, { keepIf: keepIfFor(true) }),
    });
  }

  return items;
}

/**
 * Plan deletion of allow-listed folders across repos, `jobs` repos at a time.
 * @param {Repo[]} repos  repos to search
 * @param {readonly string[]} names  folder names to delete
 * @param {{ jobs?: number, keepIf?: KeepRule | null }} [options]  parallel repos, and an extra reason to keep
 * @returns {Promise<PlanItem[]>} plan lines of all repos
 */
export async function planFolders(repos, names, { jobs = DEFAULT_JOBS, keepIf = null } = {}) {
  return (await mapPool(repos, jobs, (repo) => planRepoDirs(repo, names, { keepIf }))).flat();
}

/**
 * Human-readable size, e.g. 1536 -> "1.5 KB".
 * @param {number | null | undefined} bytes  size, or nothing when unknown
 * @returns {string} the size with a unit, or an empty string when unknown
 */
export function formatBytes(bytes) {
  if (bytes == null) {
    return '';
  }

  let value = bytes;
  let unit = 0;

  while (value >= BYTES_PER_UNIT && unit < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unit += 1;
  }

  return `${value.toFixed(unit ? 1 : 0)} ${BYTE_UNITS[unit]}`;
}

/**
 * Whole days between `mtimeMs` and `now`.
 * @param {number} mtimeMs  an earlier time
 * @param {number} [now]  the later time, by default the current time
 * @returns {number} full days in between
 */
export const ageInDays = (mtimeMs, now = Date.now()) => Math.floor((now - mtimeMs) / DAY_MS);

/**
 * Total size of plan items whose size is known.
 * @param {PlanItem[]} items  plan lines
 * @returns {number} bytes
 */
const totalBytes = (items) => items.reduce((sum, item) => sum + (item.bytes ?? 0), 0);

/**
 * Size and detail of a plan line, for the output.
 * @param {PlanItem} item  plan line
 * @returns {string} e.g. "1.5 KB  leftover of an earlier run"
 */
const describe = (item) => [formatBytes(item.bytes), item.detail].filter(Boolean).join('  ');

/**
 * Indent every line of a text, for failure details under a heading.
 * @param {string} text  possibly multi-line text
 * @returns {string} the indented text
 */
const indent = (text) => text.replace(LINE_STARTS, DETAIL_INDENT);

/**
 * Upper-case the first letter.
 * @param {string} word  e.g. "delete"
 * @returns {string} e.g. "Delete"
 */
const capitalize = (word) => word.charAt(0).toUpperCase() + word.slice(1);

/**
 * Print one plan section: a title and a "do" or "keep" line per item.
 * @param {PlanSection} section  the section to print
 * @param {RunContext['print']} print  where output goes
 */
function printSection({ title, items }, print) {
  print(`\n${title}`);

  if (!items.length) {
    print('  (nothing found)');
  }

  for (const item of items) {
    const action = item.skip ? 'keep' : 'do  ';

    print(`  ${action}  ${item.name.padEnd(NAME_COLUMN_WIDTH)} ${item.skip ?? describe(item)}`);
  }
}

/**
 * Run plan items in a pool. Every item is attempted; failures are returned as data (gpall style).
 * @param {PlanItem[]} items  plan lines to run
 * @param {{
 *   jobs: number,
 *   log?: (line: string) => Promise<void>,
 *   onResult?: (result: Result, item: PlanItem) => void,
 * }} options  parallel items, a log writer, and a callback per finished item
 * @returns {Promise<Result[]>} in input order
 */
export async function runItems(items, { jobs, log = async () => {}, onResult = () => {} }) {
  return mapPool(items, jobs, async (item) => {
    /** @type {RunResult} */
    const outcome = await item.run().catch((err) => ({ ok: false, output: errorText(err) }));
    const failure = outcome.ok ? '' : ` | ${outcome.output.replace(WHITESPACE_RUNS, ' ')}`;

    await log(`${outcome.ok ? 'ok  ' : 'FAIL'} ${item.name}${failure}`);

    const result = { name: item.name, ok: outcome.ok, output: outcome.output, summary: outcome.summary };

    onResult(result, item);

    return result;
  });
}

/**
 * The shared flow: print the plan -> stop if dry run -> confirm (unless --yes) -> lock -> runItems, printing
 * ok/FAIL per item as it finishes -> list failures with details at the end (like gpall).
 * @param {{ sections: PlanSection[], options: BaseOptions, verb: string, logName: string, context: RunContext }} args
 *   the plan, the parsed flags, the action word for messages ("delete"), the log file's name, and the run context
 * @returns {Promise<{ code: number, applied: boolean, results: Result[] }>}
 *   exit code, whether --apply ran to the end, and each item's result (none without a run)
 */
export async function planAndRun({ sections, options, verb, logName, context }) {
  const { print } = context;

  for (const section of sections) {
    printSection(section, print);
  }

  const todo = sections.flatMap((section) => section.items).filter((item) => !item.skip);
  const size = totalBytes(todo) ? ` (${formatBytes(totalBytes(todo))})` : '';

  if (!todo.length) {
    print('\nNothing to do.');

    return { code: EXIT_OK, applied: options.apply, results: [] };
  }

  if (!options.apply) {
    print(`\nDry run: nothing changed. Re-run with --apply to ${verb} ${todo.length} item(s)${size}.`);

    return { code: EXIT_OK, applied: false, results: [] };
  }

  const question = `\n${capitalize(verb)} ${todo.length} item(s)${size}?`;

  if (!options.yes && !(await context.confirm(question))) {
    print('Cancelled. Nothing was changed.');

    return { code: EXIT_OK, applied: false, results: [] };
  }

  return withLock(context.stateDir, async () => {
    const { file, log } = await createLog(context.stateDir, logName);

    print();

    const results = await runItems(todo, {
      jobs: options.jobs,
      log,
      onResult: (result, item) => {
        const detail = result.summary ?? describe(item);

        print(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.name.padEnd(NAME_COLUMN_WIDTH)} ${detail}`);
      },
    });
    const failed = results.filter((result) => !result.ok);
    const summary = failed.length ? `${failed.length} failed` : 'all ok';

    print(`\nDone: ${results.length} item(s), ${summary}. Log: ${file}`);

    for (const result of failed) {
      print(`\n--- ${result.name}\n${indent(result.output)}`);
    }

    return { code: failed.length ? EXIT_FAILED : EXIT_OK, applied: true, results };
  });
}
