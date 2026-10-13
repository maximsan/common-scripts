// @ts-check
// Tests for devclean.mjs.  Run:  node --test devclean.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRepos } from './devkit-core.mjs';
import { main, planBuildOutputs, planStaleNodeModules, planTemp } from './devclean.mjs';
import { backdate, git, makeRepo, runScript, tempWorkspace, write } from './test-helpers.mjs';

const { root: workspace, cleanup } = tempWorkspace('devclean');

after(cleanup);

/**
 * Skip reason of the plan line with the given name.
 * @param {import('./devkit-core.mjs').PlanItem[]} items  plan lines
 * @param {string} name  the line's name
 * @returns {string | null | undefined} its skip reason; null means "will run", undefined "not in the plan"
 */
const skipOf = (items, name) => items.find((item) => item.name === name)?.skip;

test('stale node_modules and build outputs respect the age thresholds', async () => {
  const root = join(workspace, 'age');
  const old = makeRepo(root, 'old');

  write(join(old, 'node_modules', 'a.js'));

  for (const file of ['index.js', 'package.json', '.gitignore', '']) {
    backdate(join(old, file), 60);
  }

  const fresh = makeRepo(root, 'fresh');

  write(join(fresh, 'node_modules', 'a.js'));
  write(join(fresh, 'dist', 'bundle.js'));

  const repos = await findRepos(root);
  const modules = await planStaleNodeModules(repos, { staleDays: 30 });

  assert.equal(skipOf(modules, 'old/node_modules'), null);
  assert.match(String(skipOf(modules, 'fresh/node_modules')), /changed 0 day/);

  assert.match(String(skipOf(await planBuildOutputs(repos, { buildDays: 7 }), 'fresh/dist')), /built 0 day/);
  backdate(join(fresh, 'dist', 'bundle.js'), 10);
  backdate(join(fresh, 'dist'), 10);
  assert.equal(skipOf(await planBuildOutputs(repos, { buildDays: 7 }), 'fresh/dist'), null);
});

test('a build folder holding a tracked file is kept', async () => {
  const root = join(workspace, 'tracked');
  const repo = makeRepo(root, 'repo', { ignore: '' });

  write(join(repo, 'dist', 'committed.js'));
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'dist');
  write(join(repo, '.gitignore'), 'dist/\n');
  backdate(join(repo, 'dist', 'committed.js'), 30);
  backdate(join(repo, 'dist'), 30);

  const [item] = await planBuildOutputs(await findRepos(root), { buildDays: 7 });

  assert.match(String(item.skip), /tracked/);
});

test('planTemp only selects entries with nothing newer than the cutoff', async () => {
  const temp = join(workspace, 'temp');

  write(join(temp, 'old.log'));
  backdate(join(temp, 'old.log'), 20);
  write(join(temp, 'new.log'));
  write(join(temp, 'mixed', 'old.txt'));
  backdate(join(temp, 'mixed', 'old.txt'), 20);
  write(join(temp, 'mixed', 'new.txt'));
  write(join(temp, 'old-dir', 'x.txt'));
  backdate(join(temp, 'old-dir', 'x.txt'), 20);
  backdate(join(temp, 'old-dir'), 20);

  const { items, keptCount } = await planTemp(temp, { tempDays: 7 });

  assert.deepEqual(items.map((item) => item.name).sort(), ['old-dir', 'old.log']);
  assert.equal(keptCount, 2);
});

test('applied cleanup removes old temp entries, records the run, and --due goes quiet', async () => {
  const root = join(workspace, 'cli');

  makeRepo(root, 'app');

  const temp = join(workspace, 'cli-temp');

  write(join(temp, 'old.tmp'));
  backdate(join(temp, 'old.tmp'), 30);
  write(join(temp, 'new.tmp'));

  const stateDir = join(workspace, 'state');

  /**
   * Run devclean as a child process in the test's repos folder.
   * @param {...string} args  command-line arguments
   * @returns {import('node:child_process').SpawnSyncReturns<string>} exit status and output
   */
  const devclean = (...args) => runScript('devclean.mjs', args, { cwd: root, stateDir });

  assert.match(devclean('--due').stdout, /no cleanup recorded/);
  assert.equal(devclean('--only', 'temp,home').status, 2);

  // In-process, so the test can point the temp section at its own folder.
  const previousCwd = process.cwd();

  process.env.LOCALAPPDATA = stateDir;
  process.chdir(root);

  try {
    assert.equal(await main(['--only', 'temp', '--apply', '--yes'], { tempDir: temp }), 0);
  } finally {
    process.chdir(previousCwd);
  }

  assert.equal(existsSync(join(temp, 'old.tmp')), false);
  assert.equal(existsSync(join(temp, 'new.tmp')), true);
  assert.equal(devclean('--due').stdout, '');
});
