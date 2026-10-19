// @ts-check
// Tests for core/run.mjs.  Run:  node --test core/run.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { NODE_MODULES } from './constants.mjs';
import { findRepos } from './discovery.mjs';
import { planAndRun, planFolders, runItems, skippedItem } from './run.mjs';
import { git, makeRepo, tempWorkspace, testContext, write } from '../test-helpers.mjs';

const { root: workspace, cleanup } = tempWorkspace('core-run');

after(cleanup);

/**
 * Map of plan line name to its skip reason, for asserting on a whole plan.
 * @param {import('./run.mjs').PlanItem[]} items  plan lines
 * @returns {Record<string, string | null>} skip reason per name; null means "will run"
 */
const skipByName = (items) => Object.fromEntries(items.map((item) => [item.name, item.skip]));

test('planFolders applies the git guards and finds nested workspaces', async () => {
  const root = join(workspace, 'plan');
  const good = makeRepo(root, 'good');

  write(join(good, NODE_MODULES, 'a.js'));
  write(join(good, 'packages', 'web', 'package.json'), '{}');
  write(join(good, 'packages', 'web', NODE_MODULES, 'b.js'));
  write(join(makeRepo(root, 'not-ignored', { ignore: '' }), NODE_MODULES, 'a.js'));

  const tracked = makeRepo(root, 'tracked', { ignore: '' });

  write(join(tracked, NODE_MODULES, 'vendored.js'));
  git(tracked, 'add', '.');
  git(tracked, 'commit', '-q', '-m', 'vendor');
  write(join(tracked, '.gitignore'), `${NODE_MODULES}/\n`);

  const skips = skipByName(await planFolders(await findRepos(root), [NODE_MODULES], { jobs: 2 }));

  assert.equal(skips['good/node_modules'], null);
  assert.equal(skips['good/packages/web/node_modules'], null);
  assert.match(String(skips['not-ignored/node_modules']), /not ignored/);
  assert.match(String(skips['tracked/node_modules']), /tracked/);
});

test('runItems attempts every item and returns failures as data', async () => {
  /** @type {import('./run.mjs').PlanItem[]} */
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
