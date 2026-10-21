// @ts-check

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { planAndRun, skippedItem } from '../../lib/shared/run.mjs';
import { tempWorkspace, testContext } from '../setup.mjs';
import { write } from '../utils.mjs';

const { root: workspace, cleanup } = tempWorkspace('shared-run');

after(cleanup);

test('planAndRun attempts every item, returns exit code 1 on a failure, and refuses while locked', async () => {
  const stateDir = join(workspace, 'state');
  const { context } = testContext({ cwd: workspace, stateDir });
  const options = { apply: true, yes: false, dryRun: false, help: false, jobs: 2 };

  /** @type {import('../../lib/shared/run.mjs').PlanItem[]} */
  const items = [
    { name: 'good', skip: null, run: async () => ({ ok: true, output: '' }) },
    { name: 'bad', skip: null, run: async () => ({ ok: false, output: 'boom' }) },
    {
      name: 'throws',
      skip: null,
      run: async () => {
        throw new Error('crash');
      },
    },
    skippedItem('kept', 'reason'),
  ];
  const sections = [{ title: 'test', items }];
  const run = await planAndRun({ sections, options, verb: 'run', command: 'test', args: [], context });

  assert.equal(run.code, 1);
  assert.equal(run.applied, true);
  assert.deepEqual(
    run.results.map((result) => [result.name, result.ok, result.output]),
    [['good', true, ''], ['bad', false, 'boom'], ['throws', false, 'crash']],
  );

  write(join(stateDir, 'devkit.lock'), '999999\n');

  const whileLocked = planAndRun({ sections, options, verb: 'run', command: 'test', args: [], context });

  await assert.rejects(whileLocked, /Another devkit script is running/);
});

test('with --apply, only the picked groups run; nothing picked changes nothing; --yes skips the list', async () => {
  const stateDir = join(workspace, 'pick-state');

  /** @type {string[]} */
  const ran = [];

  /**
   * A plan item that records its name when it runs.
   * @param {string} name  the item's name
   * @param {string} group  its line in the pick list
   * @returns {import('../../lib/shared/run.mjs').PlanItem} the item
   */
  const item = (name, group) => ({
    name,
    group,
    skip: null,
    run: async () => {
      ran.push(name);

      return { ok: true, output: '' };
    },
  });
  const sections = [{ title: 'test', items: [item('a/1', 'a'), item('a/2', 'a'), item('b/1', 'b')] }];
  const options = { apply: true, yes: false, dryRun: false, help: false, jobs: 1 };

  /**
   * Run the plan with these picks.
   * @param {import('../../lib/shared/run.mjs').RunContext} context  the run context
   * @param {boolean} yes  whether --yes is given
   * @returns {ReturnType<typeof planAndRun>} the outcome
   */
  const runWith = (context, yes = false) => planAndRun({
    sections, options: { ...options, yes }, verb: 'run', command: 'test', args: [], context,
  });
  const picked = testContext({ cwd: workspace, stateDir, picks: [1] });

  await runWith(picked.context);
  assert.deepEqual(ran, ['b/1']);
  assert.match(picked.output(), /^a {2}2 item\(s\)$/m);

  const none = testContext({ cwd: workspace, stateDir, picks: [] });
  const cancelled = await runWith(none.context);

  assert.equal(cancelled.applied, false);
  assert.match(none.output(), /Nothing picked/);

  ran.length = 0;

  const all = testContext({ cwd: workspace, stateDir, picks: [] });

  await runWith(all.context, true);
  assert.deepEqual(ran, ['a/1', 'a/2', 'b/1']);
  assert.doesNotMatch(all.output(), /item\(s\)$/m);
});

test('a dry run ends with the commands that act on it', async () => {
  const { context, output } = testContext({ cwd: workspace, stateDir: join(workspace, 'hint-state') });
  const items = [{ name: 'one', skip: null, run: async () => ({ ok: true, output: '' }) }];
  const sections = [{ title: 'test', items }];
  const options = { apply: false, yes: false, dryRun: false, help: false, jobs: 1 };

  await planAndRun({ sections, options, verb: 'run', command: 'devclean', args: ['--days', '60'], context });
  assert.match(output(), /^ {2}devkit devclean --days 60 {16}pick and confirm, in a terminal$/m);
  assert.match(output(), /^ {2}devkit devclean --days 60 --apply --yes {2}everything, without questions$/m);
});
