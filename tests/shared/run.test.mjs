// @ts-check
// Tests for lib/shared/run.mjs.  Run:  node --test tests/shared/run.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { planAndRun, runItems, skippedItem } from '../../lib/shared/run.mjs';
import { tempWorkspace, testContext } from '../setup.mjs';
import { write } from '../utils.mjs';

const { root: workspace, cleanup } = tempWorkspace('shared-run');

after(cleanup);

test('runItems attempts every item and returns failures as data', async () => {
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
  ];
  const results = await runItems(items, { jobs: 2 });

  assert.deepEqual(
    results.map((result) => [result.name, result.ok, result.output]),
    [['good', true, ''], ['bad', false, 'boom'], ['throws', false, 'crash']],
  );
});

test('planAndRun returns exit code 1 on a failure and refuses while another run holds the lock', async () => {
  const stateDir = join(workspace, 'state');
  const { context } = testContext({ cwd: workspace, stateDir });
  const options = { apply: true, yes: false, help: false, jobs: 1 };
  const failing = { name: 'bad', skip: null, run: async () => ({ ok: false, output: 'boom' }) };
  const sections = [{ title: 'test', items: [failing, skippedItem('kept', 'reason')] }];
  const run = await planAndRun({ sections, options, verb: 'run', logName: 'test', context });

  assert.equal(run.code, 1);
  assert.equal(run.applied, true);
  assert.deepEqual(run.results.map((result) => [result.name, result.ok, result.output]), [['bad', false, 'boom']]);

  write(join(stateDir, 'devkit.lock'), '999999\n');

  const whileLocked = planAndRun({ sections, options, verb: 'run', logName: 'test', context });

  await assert.rejects(whileLocked, /Another devkit script is running/);
});
