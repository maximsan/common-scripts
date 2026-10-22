// @ts-check

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SafetyError } from '../../lib/shared/errors.mjs';
import { HOST_RULES, platformRules } from '../../lib/shared/platform.mjs';
import { assertSafeRoot, protectedFolders, resolveTempDir, rootProblems } from '../../lib/shared/safe-root.mjs';
import { tempWorkspace } from '../setup.mjs';

const { root: workspace, cleanup } = tempWorkspace('shared-safe-root');
const WINDOWS = platformRules('win32');
const ON_WINDOWS = HOST_RULES.name === 'win32';

after(cleanup);

test('Windows rules: drive roots, network paths, home and protected folders are refused', () => {
  const env = {
    SystemRoot: 'C:\\Windows',
    APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
    OneDriveCommercial: 'C:\\Users\\me\\OneDrive - Company',
  };
  const folders = protectedFolders(WINDOWS, { home: 'C:\\Users\\me', env });
  const where = { homeReal: 'C:\\Users\\me', folders, rules: WINDOWS };

  assert.deepEqual(folders, [
    ['SystemRoot', 'C:\\Windows'],
    ['APPDATA', 'C:\\Users\\me\\AppData\\Roaming'],
    ['OneDriveCommercial', 'C:\\Users\\me\\OneDrive - Company'],
  ]);
  assert.match(rootProblems('C:\\', where).join(), /drive or filesystem root/);
  assert.match(rootProblems('\\\\server\\share\\repos', where).join(), /network/);
  assert.match(rootProblems('c:\\users\\ME', where).join(), /home folder/);
  assert.match(rootProblems('c:\\windows\\system32', where).join(), /inside SystemRoot/);
  assert.match(rootProblems('C:\\Users\\me\\OneDrive - Company\\repos', where).join(), /inside OneDriveCommercial/);
  assert.deepEqual(rootProblems('C:\\Users\\me\\repos', where), []);
});

test('assertSafeRoot refuses filesystem root, home and AppData', async () => {
  await assert.rejects(assertSafeRoot('/', { home: join(workspace, 'home') }), SafetyError);

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
  assert.ok(await resolveTempDir({ home: homedir() }));
  await assert.rejects(resolveTempDir({ temp: workspace, home: workspace, rules: WINDOWS }), /expected/);
  await assert.rejects(
    resolveTempDir({ temp: join(workspace, '..'), home: workspace, rules: platformRules('freebsd') }),
    /no known temp folder on freebsd/,
  );

  if (!ON_WINDOWS) {
    await assert.rejects(resolveTempDir({ temp: '/usr', home: homedir() }), /expected/);
  }
});
