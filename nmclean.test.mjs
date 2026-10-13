// @ts-check
// Tests for nmclean.mjs.  Run:  node --test nmclean.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { makeRepo, runScript, scriptPath, tempWorkspace, write } from './test-helpers.mjs';

const { root: workspace, cleanup } = tempWorkspace('nmclean');
const stateDir = join(workspace, 'state');

after(cleanup);

test('dry run changes nothing; typos and missing confirmation are refused; --apply --yes deletes', () => {
  const root = join(workspace, 'repos');
  const app = makeRepo(root, 'app');
  const lib = makeRepo(root, 'lib');

  write(join(app, 'node_modules', 'big.js'), 'x'.repeat(1000));
  write(join(lib, 'packages', 'ui', 'package.json'), '{}');
  write(join(lib, 'packages', 'ui', 'node_modules', 'a.js'));

  /**
   * Run nmclean as a child process in the test's repos folder.
   * @param {...string} args  command-line arguments
   * @returns {import('node:child_process').SpawnSyncReturns<string>} exit status and output
   */
  const nmclean = (...args) => runScript('nmclean.mjs', args, { cwd: root, stateDir });

  const dryRun = nmclean();

  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /Dry run: nothing changed/);
  assert.match(dryRun.stdout, /lib\/packages\/ui\/node_modules/);
  assert.equal(existsSync(join(app, 'node_modules', 'big.js')), true);

  assert.equal(nmclean('--aply').status, 2);
  assert.equal(nmclean('--apply').status, 2); // no terminal and no --yes
  assert.equal(existsSync(join(app, 'node_modules')), true);

  const applied = nmclean('2', '--apply', '--yes');

  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.match(applied.stdout, /^ok {2}/m);
  assert.match(applied.stdout, /Done: 2 item\(s\), all ok/);
  assert.equal(existsSync(join(app, 'node_modules')), false);
  assert.equal(existsSync(join(lib, 'packages', 'ui', 'node_modules')), false);
  assert.equal(existsSync(join(app, 'index.js')), true);
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
