// @ts-check
// Tests for lib/shared/discovery.mjs.  Run:  node --test tests/shared/discovery.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { findNamedDirs } from '../../lib/shared/discovery.mjs';
import { tempWorkspace } from '../setup.mjs';
import { makeRepo, write } from '../utils.mjs';

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
