// @ts-check
// Tests for lib/shared/platform.mjs.  Run:  node --test tests/shared/platform.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childEnv, platformRules } from '../../lib/shared/platform.mjs';

const WINDOWS = platformRules('win32');
const MACOS = platformRules('darwin');

test('platform rules: temp folder locations and the child PATH', () => {
  assert.deepEqual(WINDOWS.tempHomes('C:\\Users\\me'), ['C:\\Users\\me\\AppData\\Local\\Temp']);
  assert.deepEqual(MACOS.tempHomes('/Users/me'), ['/private/var/folders', '/private/tmp']);

  const env = { PATH: `.${MACOS.paths.delimiter}/usr/bin`, GIT_DIR: '/elsewhere/.git' };

  assert.equal(childEnv(env, MACOS).PATH, '/usr/bin');
  assert.equal(childEnv(env, MACOS).GIT_DIR, undefined);
  assert.equal(childEnv({ PATH: '.;C:\\Tools' }, WINDOWS).PATH, '.;C:\\Tools');
});
