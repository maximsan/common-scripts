// @ts-check
// Tests for lib/shared/paths.mjs.  Run:  node --test tests/shared/paths.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NODE_MODULES } from '../../lib/shared/constants.mjs';
import { isInside, samePath, trashBase } from '../../lib/shared/paths.mjs';
import { platformRules } from '../../lib/shared/platform.mjs';

const WINDOWS = platformRules('win32');
const MACOS = platformRules('darwin');

test('isInside: strict containment only', () => {
  assert.equal(isInside('/a/b', '/a/b/c'), true);
  assert.equal(isInside('/a/b', '/a/b'), false);
  assert.equal(isInside('/a/b', '/a/bc'), false);
  assert.equal(isInside('/a/b', '/a/b/../x'), false);

  // A folder literally named "..foo".
  assert.equal(isInside('/a/b', '/a/b/..foo'), true);
});

test('Windows rules: paths ignore letter case and drives differ', () => {
  assert.equal(samePath('C:\\Repos\\App', 'c:\\repos\\app', WINDOWS), true);
  assert.equal(isInside('C:\\Repos', 'c:\\repos\\app', WINDOWS), true);
  assert.equal(isInside('C:\\Repos', 'D:\\Repos\\app', WINDOWS), false);
  assert.equal(samePath('/Users/me/App', '/users/me/app', MACOS), false);
});

test('only devkit-made leftovers count as leftovers', () => {
  assert.equal(trashBase('node_modules.devkit-deleting-1712345678901'), NODE_MODULES);
  assert.equal(trashBase('node_modules.devkit-deleting-mine'), null);
});
