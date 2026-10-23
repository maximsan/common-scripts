// @ts-check

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { findNamedDirs, measure, scanTree } from '../../lib/shared/discovery.mjs';
import { tempWorkspace } from '../setup.mjs';
import { linkFolder, makeRepo, write } from '../utils.mjs';

const { root: workspace, cleanup } = tempWorkspace('discovery');

after(cleanup);

test('search skips dot-folders, folders without package.json, and nested repos', async () => {
  const repo = makeRepo(join(workspace, 'search'), 'repo', { ignore: 'dist/\n.venv/\nlib/\n' });

  write(join(repo, '.venv', 'Lib', 'site-packages', 'pkg', 'package.json'), '{}');
  write(join(repo, '.venv', 'Lib', 'site-packages', 'pkg', 'dist', 'x.py'));
  write(join(repo, 'lib', 'dist', 'not-a-package.txt'));
  makeRepo(repo, 'inner');
  write(join(repo, 'inner', 'dist', 'x.js'));
  assert.deepEqual(await findNamedDirs(repo, ['dist']), []);
});

test('scanTree finds a nested repo like measure does, and never enters a folder link', async () => {
  const outside = join(workspace, 'scan-outside');
  const tree = join(workspace, 'scan-tree');

  write(join(outside, '.git', 'HEAD'));
  write(join(tree, 'pkg', 'index.js'));
  linkFolder(outside, join(tree, 'pkg', 'linked'));
  assert.deepEqual(await scanTree(tree), { hasNestedRepo: false });
  assert.equal((await measure(tree)).hasNestedRepo, false);

  write(join(tree, 'pkg', 'vendored', '.git', 'HEAD'));
  assert.equal((await scanTree(tree)).hasNestedRepo, true);
  assert.equal((await measure(tree)).hasNestedRepo, true);
});
