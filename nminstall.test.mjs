// @ts-check
// Tests for nminstall.mjs.  Run:  node --test nminstall.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { detectPackageManager, main } from './nminstall.mjs';
import { makeRepo, runScript, tempWorkspace, testContext, write } from './test-helpers.mjs';

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

test('install runs npm ci after confirmation and leaves the lockfile unchanged', async () => {
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

  const dryRun = testContext({ cwd: root, stateDir });

  assert.equal(await main([], dryRun.context), 0);
  assert.match(dryRun.output(), /npm ci/);
  assert.equal(existsSync(join(app, 'node_modules', 'stale.js')), true);

  const applied = testContext({ cwd: root, stateDir });

  assert.equal(await main(['--apply'], applied.context), 0, applied.output());
  assert.equal(existsSync(join(app, 'node_modules', 'stale.js')), false);
  assert.equal(readFileSync(lockfile, 'utf8'), lockBefore);
});

test('an existing node_modules that is a link or holds a nested repo is kept in the plan, not installed', async () => {
  const root = join(workspace, 'blocked');
  const linked = makeRepo(root, 'linked');
  const nested = makeRepo(root, 'nested');
  const shared = join(workspace, 'shared-modules');

  write(join(linked, 'package-lock.json'), '{}');
  write(join(shared, 'keep.js'));
  symlinkSync(shared, join(linked, 'node_modules'), 'dir');
  write(join(nested, 'package-lock.json'), '{}');
  write(join(nested, 'node_modules', 'patched-lib', '.git', 'HEAD'));

  const { context, output } = testContext({ cwd: root, stateDir });

  assert.equal(await main(['--apply'], context), 0, output());
  assert.match(output(), /keep {2}linked .*existing node_modules is a symlink\/junction/);
  assert.match(output(), /keep {2}nested .*existing node_modules contains a nested git repo/);
  assert.match(output(), /Nothing to do/);
  assert.equal(existsSync(join(shared, 'keep.js')), true);
  assert.equal(existsSync(join(nested, 'node_modules', 'patched-lib', '.git', 'HEAD')), true);
});

test('as a process: prints the plan, and refuses --apply without a terminal', () => {
  const root = join(workspace, 'process');
  const app = makeRepo(root, 'app');

  write(join(app, 'package-lock.json'), '{}');

  const dryRun = runScript('nminstall.mjs', [], { cwd: root, stateDir });

  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /do {4}app .*npm ci/);

  const refused = runScript('nminstall.mjs', ['--apply'], { cwd: root, stateDir });

  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /No interactive terminal/);
});
