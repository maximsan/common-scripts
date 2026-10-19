// @ts-check
// Tests for nminstall.mjs.  Run:  node --test nminstall.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { detectPackageManager } from './nminstall.mjs';
import { makeRepo, runScript, tempWorkspace, write } from './test-helpers.mjs';

const { root: workspace, cleanup } = tempWorkspace('nminstall');
const stateDir = join(workspace, 'state');

after(cleanup);

/**
 * Each case: files in the repo, package.json fields, and the expected command or skip reason.
 * @type {[Record<string, string>, Record<string, string>, string | RegExp][]}
 */
const CASES = [
  [{ 'package-lock.json': '{}' }, {}, 'npm ci'],
  [{ 'yarn.lock': '' }, {}, 'yarn install --frozen-lockfile'],
  [{ 'yarn.lock': '', '.yarnrc.yml': '' }, {}, 'yarn install --immutable'],
  [{ 'yarn.lock': '' }, { packageManager: 'yarn@4.5.0' }, 'yarn install --immutable'],
  [{ 'yarn.lock': '', '.yarnrc.yml': '' }, { packageManager: 'yarn@1.22.22' }, 'yarn install --frozen-lockfile'],
  [{ 'yarn.lock': '', 'package-lock.json': '{}' }, {}, /both/],
  [{}, {}, /no lockfile/],
  [{ 'pnpm-lock.yaml': '' }, {}, /pnpm or bun/],
  [{ 'package-lock.json': '{}' }, { packageManager: 'yarn@1.22.22' }, /packageManager says yarn/],
  [{ 'package-lock.json': '{}' }, { packageManager: 'pnpm@9.0.0' }, /uses pnpm/],
];

test('detectPackageManager covers npm, Yarn 1, Yarn 2+ and every skip case', async () => {
  for (const [index, [files, fields, expected]] of CASES.entries()) {
    const dir = join(workspace, 'cases', String(index));

    write(join(dir, 'package.json'), JSON.stringify({ name: 'x', ...fields }));

    for (const [file, content] of Object.entries(files)) {
      write(join(dir, file), content);
    }

    const plan = await detectPackageManager(dir);

    if (typeof expected === 'string') {
      assert.equal('command' in plan && plan.command, expected, `case ${index}`);
    } else {
      assert.match('skip' in plan ? plan.skip : '', expected, `case ${index}`);
    }
  }

  mkdirSync(join(workspace, 'cases', 'none'), { recursive: true });

  const none = await detectPackageManager(join(workspace, 'cases', 'none'));

  assert.match('skip' in none ? none.skip : '', /no package.json/);
});

test('install needs confirmation, then runs npm ci and leaves the lockfile unchanged', () => {
  const root = join(workspace, 'repos');
  const app = makeRepo(root, 'app');
  const lockfile = join(app, 'package-lock.json');
  const emptyLock = {
    name: 'app',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'app', version: '1.0.0' } },
  };

  write(lockfile, JSON.stringify(emptyLock));

  const lockBefore = readFileSync(lockfile, 'utf8');

  write(join(app, 'node_modules', 'stale.js'));

  /**
   * Run nminstall as a child process in the test's repos folder.
   * @param {...string} args  command-line arguments
   * @returns {import('node:child_process').SpawnSyncReturns<string>} exit status and output
   */
  const nminstall = (...args) => runScript('nminstall.mjs', args, { cwd: root, stateDir });

  assert.match(nminstall().stdout, /npm ci/);
  assert.equal(nminstall('--apply').status, 2); // no terminal and no --yes
  assert.equal(existsSync(join(app, 'node_modules', 'stale.js')), true);

  const applied = nminstall('--apply', '--yes');

  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.equal(existsSync(join(app, 'node_modules', 'stale.js')), false);
  assert.equal(readFileSync(lockfile, 'utf8'), lockBefore);
});

test('an existing node_modules that is a link or holds a nested repo is kept in the plan, not installed', () => {
  const root = join(workspace, 'blocked');
  const linked = makeRepo(root, 'linked');
  const nested = makeRepo(root, 'nested');
  const shared = join(workspace, 'shared-modules');

  write(join(linked, 'package-lock.json'), '{}');
  write(join(shared, 'keep.js'));
  symlinkSync(shared, join(linked, 'node_modules'), 'dir');
  write(join(nested, 'package-lock.json'), '{}');
  write(join(nested, 'node_modules', 'patched-lib', '.git', 'HEAD'));

  const applied = runScript('nminstall.mjs', ['--apply', '--yes'], { cwd: root, stateDir });

  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.match(applied.stdout, /keep {2}linked .*existing node_modules is a symlink\/junction/);
  assert.match(applied.stdout, /keep {2}nested .*existing node_modules contains a nested git repo/);
  assert.match(applied.stdout, /Nothing to do/);
  assert.equal(existsSync(join(shared, 'keep.js')), true);
  assert.equal(existsSync(join(nested, 'node_modules', 'patched-lib', '.git', 'HEAD')), true);
});
