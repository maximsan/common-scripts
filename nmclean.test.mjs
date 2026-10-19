// @ts-check
// Tests for nmclean.mjs.  Run:  node --test nmclean.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { SafetyError } from './devkit-core.mjs';
import { main } from './nmclean.mjs';
import { makeRepo, runScript, scriptPath, testContext, tempWorkspace, write } from './test-helpers.mjs';

const { root: workspace, cleanup } = tempWorkspace('nmclean');
const stateDir = join(workspace, 'state');

after(cleanup);

test('dry run changes nothing; typos are refused; a "no" cancels; a "yes" deletes', async () => {
  const root = join(workspace, 'repos');
  const app = makeRepo(root, 'app');
  const lib = makeRepo(root, 'lib');

  write(join(app, 'node_modules', 'big.js'), 'x'.repeat(1000));
  write(join(lib, 'packages', 'ui', 'package.json'), '{}');
  write(join(lib, 'packages', 'ui', 'node_modules', 'a.js'));

  const dryRun = testContext({ cwd: root, stateDir });

  assert.equal(await main([], dryRun.context), 0);
  assert.match(dryRun.output(), /Dry run: nothing changed/);
  assert.match(dryRun.output(), /lib\/packages\/ui\/node_modules/);
  assert.equal(existsSync(join(app, 'node_modules', 'big.js')), true);

  await assert.rejects(main(['--aply'], dryRun.context), SafetyError);

  const declined = testContext({ cwd: root, stateDir, answer: false });

  assert.equal(await main(['--apply'], declined.context), 0);
  assert.match(declined.output(), /Cancelled/);
  assert.equal(existsSync(join(app, 'node_modules')), true);

  const confirmed = testContext({ cwd: root, stateDir });

  assert.equal(await main(['2', '--apply'], confirmed.context), 0, confirmed.output());
  assert.match(confirmed.output(), /Done: 2 item\(s\), all ok/);
  assert.equal(existsSync(join(app, 'node_modules')), false);
  assert.equal(existsSync(join(lib, 'packages', 'ui', 'node_modules')), false);
  assert.equal(existsSync(join(app, 'index.js')), true);
});

test('as a process: refuses --apply without a terminal, deletes with --apply --yes', () => {
  const root = join(workspace, 'process');
  const app = makeRepo(root, 'app');

  write(join(app, 'node_modules', 'a.js'));

  const refused = runScript('nmclean.mjs', ['--apply'], { cwd: root, stateDir });

  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /No interactive terminal/);
  assert.equal(existsSync(join(app, 'node_modules')), true);

  const applied = runScript('nmclean.mjs', ['--apply', '--yes'], { cwd: root, stateDir });

  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.match(applied.stdout, /^ok {4}app\/node_modules/m);
  assert.equal(existsSync(join(app, 'node_modules')), false);
});

test('runs when started through a symlink (e.g. an alias in ~/bin)', () => {
  const root = join(workspace, 'via-link');

  makeRepo(root, 'app');

  const link = join(workspace, 'nmclean-link.mjs');

  symlinkSync(scriptPath('nmclean.mjs'), link);

  const result = runScript(link, [], { cwd: root, stateDir });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /node_modules in 1 repo/);
});

test('refuses to run in the home folder', () => {
  const env = { HOME: workspace, USERPROFILE: workspace };
  const result = runScript('nmclean.mjs', [], { cwd: workspace, stateDir, env });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /home folder/);
});
