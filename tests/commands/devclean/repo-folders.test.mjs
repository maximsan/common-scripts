// @ts-check
// Tests for lib/commands/devclean/repo-folders.mjs.  Run:  node --test tests/commands/devclean/repo-folders.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRepos } from '../../../lib/shared/index.mjs';
import { planBuildOutputs, planStaleNodeModules } from '../../../lib/commands/devclean/repo-folders.mjs';
import { tempWorkspace } from '../../setup.mjs';
import { backdate, git, makeRepo, write } from '../../utils.mjs';

const { root: workspace, cleanup } = tempWorkspace('devclean-repo-folders');

after(cleanup);

/**
 * Skip reason of the plan line with the given name.
 * @param {import('../../../lib/shared/index.mjs').PlanItem[]} items  plan lines
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

test('node_modules of a repo that changed after planning is kept', async () => {
  const root = join(workspace, 'recheck');
  const repo = makeRepo(root, 'repo');

  write(join(repo, 'node_modules', 'a.js'));

  for (const file of ['index.js', 'package.json', '.gitignore', '']) {
    backdate(join(repo, file), 60);
  }

  const [item] = await planStaleNodeModules(await findRepos(root), { staleDays: 30 });

  assert.equal(item.skip, null);
  write(join(repo, 'index.js'), 'changed');

  const result = await item.run();

  assert.equal(result.ok, false);
  assert.match(result.output, /changed 0 day.*re-checked before deleting; kept/);
  assert.equal(existsSync(join(repo, 'node_modules', 'a.js')), true);
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
