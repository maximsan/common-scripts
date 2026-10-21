// @ts-check
// lib/shared/run.mjs - plan items, running them in a pool, and the shared plan -> confirm -> run flow with its output.

import { EXIT_FAILED, EXIT_OK } from './constants.mjs';
import { errorText } from './errors.mjs';
import { capitalize, formatBytes, indent } from './format.mjs';
import { createLog, withLock } from './state.mjs';

/** @typedef {import('./state.mjs').RunContext} RunContext */

/**
 * Outcome of one action. `summary` replaces the plan detail on the ok line, e.g. a value read back after writing.
 * @typedef {{ ok: boolean, output: string, summary?: string }} RunResult
 */

/** @typedef {RunResult & { name: string }} Result  one finished plan item */

/**
 * One line of a plan. `skip` holds the reason it is kept; `run` performs it and never rejects. `group` is
 * the item's line in the pick list, e.g. its repo; items without one get a line each.
 * @typedef {{
 *   name: string, detail?: string, bytes?: number | null, skip: string | null, run: () => Promise<RunResult>,
 *   group?: string,
 * }} PlanItem
 */

/** @typedef {{ title: string, items: PlanItem[] }} PlanSection */

/**
 * Flags every script accepts. `dryRun` only prints the plan; `apply` acts even without a terminal, which
 * there also needs `yes`; `yes` takes every item without the pick list and the confirmation.
 * @typedef {{ apply: boolean, yes: boolean, dryRun: boolean, help: boolean, jobs: number }} BaseOptions
 */

const WHITESPACE_RUNS = /\s+/g;

// One group leaves nothing to pick between.
const MIN_GROUPS_TO_PICK = 2;

/**
 * Run `worker` over `items` with at most `limit` running at once. Keep in sync with gpall.mjs.
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
 * The item's line in the pick list.
 * @param {PlanItem} item  plan line
 * @returns {string} its group, or its name without one
 */
const groupOf = (item) => item.group ?? item.name;

/**
 * Let the person pick which groups of items to run. With fewer than two groups there is nothing to pick.
 * @param {PlanSection[]} sections  the plan
 * @param {string} verb  the action word, e.g. "delete"
 * @param {RunContext['pick']} pick  asks the person
 * @returns {Promise<PlanSection[] | null>} the plan with only the picked groups, or null when none was picked
 */
async function pickGroups(sections, verb, pick) {
  /** @type {Map<string, PlanItem[]>} */
  const groups = new Map();

  for (const item of sections.flatMap((section) => section.items).filter((planned) => !planned.skip)) {
    groups.set(groupOf(item), [...(groups.get(groupOf(item)) ?? []), item]);
  }

  if (groups.size < MIN_GROUPS_TO_PICK) {
    return sections;
  }

  const names = [...groups.keys()];
  const width = Math.max(...names.map((name) => name.length));
  const labels = names.map((name) => {
    const items = groups.get(name) ?? [];
    const size = totalBytes(items) ? formatBytes(totalBytes(items)) : '';
    const count = items.length > 1 ? `${items.length} item(s)` : '';

    return `${name.padEnd(width)}  ${[count, size].filter(Boolean).join(', ')}`.trimEnd();
  });
  const picked = new Set((await pick(`Pick what to ${verb}:`, labels)).map((index) => names[index]));

  if (!picked.size) {
    return null;
  }

  return sections
    .map((section) => ({ ...section, items: section.items.filter((item) => picked.has(groupOf(item))) }))
    .filter((section) => section.items.length);
}

/**
 * Print one plan section: a title and a "do" or "keep" line per item.
 * @param {PlanSection} section  the section to print
 * @param {number} width  the name column's width
 * @param {RunContext['print']} print  where output goes
 */
function printSection({ title, items }, width, print) {
  print(`\n${title}`);

  if (!items.length) {
    print('  (nothing found)');
  }

  for (const item of items) {
    const action = item.skip ? 'keep' : 'do  ';

    print(`  ${action}  ${item.name.padEnd(width)}  ${item.skip ?? describe(item)}`);
  }
}

/**
 * Run plan items in a pool. Every item is attempted; failures are returned as data.
 * @param {PlanItem[]} items  plan lines to run
 * @param {{
 *   jobs: number,
 *   log?: (line: string) => Promise<void>,
 *   onResult?: (result: Result, item: PlanItem) => void,
 * }} options  parallel items, a log writer, and a callback per finished item
 * @returns {Promise<Result[]>} in input order
 */
async function runItems(items, { jobs, log = async () => {}, onResult = () => {} }) {
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
 * The shared flow: print the plan -> stop when it only looks -> pick groups and confirm (unless --yes) ->
 * lock -> runItems, printing ok/FAIL per item as it finishes -> list failures with details at the end.
 * A run only looks with --dry-run, or without --apply where no person can answer (docs/adr/0003).
 * @param {{
 *   sections: PlanSection[], options: BaseOptions, verb: string, command: string, args: string[],
 *   context: RunContext,
 * }} args  the plan; the parsed flags; the action word for messages ("delete"); the command's name, which
 *   also names the log file; its arguments as the hints repeat them; and the run context
 * @returns {Promise<{ code: number, applied: boolean, results: Result[] }>}
 *   exit code, whether the items ran to the end, and each item's result (none without a run)
 */
export async function planAndRun({ sections, options, verb, command, args, context }) {
  const { print, progress } = context;

  progress.stop();

  // The longest name sets the column width, so the sizes line up. Keep in sync with gpall.mjs.
  const width = Math.max(0, ...sections.flatMap((section) => section.items).map((item) => item.name.length));

  for (const section of sections) {
    printSection(section, width, print);
  }

  const planned = sections.flatMap((section) => section.items).filter((item) => !item.skip);

  if (!planned.length) {
    print('\nNothing to do.');

    return { code: EXIT_OK, applied: false, results: [] };
  }

  if (options.dryRun || !(options.apply || context.interactive)) {
    const shown = args.filter((arg) => arg !== '--dry-run');
    const size = totalBytes(planned) ? ` (${formatBytes(totalBytes(planned))})` : '';

    const asking = `devkit ${[command, ...shown].join(' ')}`;
    const unasked = `devkit ${[command, ...shown, '--apply', '--yes'].join(' ')}`;

    print(`\nDry run: nothing changed. To ${verb} ${planned.length} item(s)${size}:`);
    print(`  ${asking.padEnd(unasked.length)}  pick and confirm, in a terminal`);
    print(`  ${unasked}  everything, without questions`);

    return { code: EXIT_OK, applied: false, results: [] };
  }

  const picked = options.yes ? sections : await pickGroups(sections, verb, context.pick);

  if (!picked) {
    print('Nothing picked. Nothing was changed.');

    return { code: EXIT_OK, applied: false, results: [] };
  }

  const todo = picked.flatMap((section) => section.items).filter((item) => !item.skip);
  const size = totalBytes(todo) ? ` (${formatBytes(totalBytes(todo))})` : '';
  const question = `\n${capitalize(verb)} ${todo.length} item(s)${size}?`;

  if (!options.yes && !(await context.confirm(question))) {
    print('Cancelled. Nothing was changed.');

    return { code: EXIT_OK, applied: false, results: [] };
  }

  return withLock(context.stateDir, async () => {
    const { file, log } = await createLog(context.stateDir, command);

    print();
    progress.start(capitalize(verb), todo.length);

    const results = await runItems(todo, {
      jobs: options.jobs,
      log,
      onResult: (result, item) => {
        const detail = result.summary ?? describe(item);

        print(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.name.padEnd(width)}  ${detail}`);
        progress.advance();
      },
    });

    progress.stop();

    const failed = results.filter((result) => !result.ok);
    const summary = failed.length ? `${failed.length} failed` : 'all ok';

    print(`\nDone: ${results.length} item(s), ${summary}. Log: ${file}`);

    for (const result of failed) {
      print(`\n--- ${result.name}\n${indent(result.output)}`);
    }

    return { code: failed.length ? EXIT_FAILED : EXIT_OK, applied: true, results };
  });
}
