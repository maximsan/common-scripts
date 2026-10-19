// @ts-check
// Tests for core/paths.mjs.  Run:  node --test core/paths.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { NODE_MODULES } from './constants.mjs';
import { SafetyError } from './errors.mjs';
import {
  assertSafeRoot, isInside, protectedFolders, resolveTempDir, rootProblems, samePath, trashBase,
} from './paths.mjs';
import { HOST_RULES, platformRules } from './platform.mjs';
import { tempWorkspace } from '../test-helpers.mjs';

const { root: workspace, cleanup } = tempWorkspace('core-paths');
const WINDOWS = platformRules('win32');
const MACOS = platformRules('darwin');
const ON_WINDOWS = HOST_RULES.name === 'win32';

after(cleanup);

test('isInside: strict containment only', () => {
  assert.equal(isInside('/a/b', '/a/b/c'), true);
  assert.equal(isInside('/a/b', '/a/b'), false);
  assert.equal(isInside('/a/b', '/a/bc'), false);
  assert.equal(isInside('/a/b', '/a/b/../x'), false);
  assert.equal(isInside('/a/b', '/a/b/..foo'), true); // a folder literally named "..foo"
});

test('Windows rules: paths ignore letter case and drives differ', () => {
  assert.equal(samePath('C:\\Repos\\App', 'c:\\repos\\app', WINDOWS), true);
  assert.equal(isInside('C:\\Repos', 'c:\\repos\\app', WINDOWS), true);
  assert.equal(isInside('C:\\Repos', 'D:\\Repos\\app', WINDOWS), false);
  assert.equal(samePath('/Users/me/App', '/users/me/app', MACOS), false);
});

test('Windows rules: drive roots, network paths, home and protected folders are refused', () => {
  const env = { SystemRoot: 'C:\\Windows', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' };
  const folders = protectedFolders(WINDOWS, { home: 'C:\\Users\\me', env });
  const where = { homeReal: 'C:\\Users\\me', folders, rules: WINDOWS };

  assert.deepEqual(folders, [['SystemRoot', 'C:\\Windows'], ['APPDATA', 'C:\\Users\\me\\AppData\\Roaming']]);
  assert.match(rootProblems('C:\\', where).join(), /drive or filesystem root/);
  assert.match(rootProblems('\\\\server\\share\\repos', where).join(), /network/);
  assert.match(rootProblems('c:\\users\\ME', where).join(), /home folder/);
  assert.match(rootProblems('c:\\windows\\system32', where).join(), /inside SystemRoot/);
  assert.deepEqual(rootProblems('C:\\Users\\me\\repos', where), []);
});

test('assertSafeRoot refuses filesystem root, home and AppData', async () => {
  await assert.rejects(assertSafeRoot('/'), SafetyError);

  const home = join(workspace, 'home');
  const appdata = join(workspace, 'appdata');
  const work = join(workspace, 'work');
  const windowsEnv = { home, env: { LOCALAPPDATA: appdata }, rules: WINDOWS };

  for (const dir of [home, join(appdata, 'x'), work]) {
    mkdirSync(dir, { recursive: true });
  }

  await assert.rejects(assertSafeRoot(home, { home, env: {} }), /home folder/);
  await assert.rejects(assertSafeRoot(join(appdata, 'x'), windowsEnv), /LOCALAPPDATA/);
  assert.ok(await assertSafeRoot(work, windowsEnv));
});

test('assertSafeRoot on macOS and Linux refuses system folders and app data in the home folder', {
  skip: ON_WINDOWS,
}, async () => {
  const home = join(workspace, 'unix-home');

  mkdirSync(join(home, '.config', 'app'), { recursive: true });
  mkdirSync(join(home, 'projects'), { recursive: true });
  await assert.rejects(assertSafeRoot('/usr', { home }), /inside \/usr/);
  await assert.rejects(assertSafeRoot(join(home, '.config', 'app'), { home }), /~\/\.config/);
  assert.ok(await assertSafeRoot(join(home, 'projects'), { home }));
});

test('resolveTempDir accepts the system temp folder and refuses anything else', async () => {
  assert.ok(await resolveTempDir());
  await assert.rejects(resolveTempDir({ temp: workspace, home: workspace, rules: WINDOWS }), /expected/);
  await assert.rejects(
    resolveTempDir({ temp: join(workspace, '..'), rules: platformRules('freebsd') }),
    /no known temp folder on freebsd/,
  );

  if (!ON_WINDOWS) {
    await assert.rejects(resolveTempDir({ temp: '/usr' }), /expected/);
  }
});

test('only devkit-made leftovers count as leftovers', () => {
  assert.equal(trashBase('node_modules.devkit-deleting-1712345678901'), NODE_MODULES);
  assert.equal(trashBase('node_modules.devkit-deleting-mine'), null);
});
