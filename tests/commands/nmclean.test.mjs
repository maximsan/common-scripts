// @ts-check

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SafetyError } from '../../lib/shared/index.mjs';
import { main } from '../../lib/commands/nmclean.mjs';
import { runCli, tempWorkspace, testContext } from '../setup.mjs';
import { makeRepo, write } from '../utils.mjs';

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

test('--apply cleans only the picked repos, with every node_modules inside them', async () => {
  const root = join(workspace, 'picked');
  const app = makeRepo(root, 'app');
  const lib = makeRepo(root, 'lib');

  write(join(app, 'node_modules', 'a.js'));
  write(join(lib, 'node_modules', 'a.js'));
  write(join(lib, 'packages', 'ui', 'package.json'), '{}');
  write(join(lib, 'packages', 'ui', 'node_modules', 'a.js'));

  const picked = testContext({ cwd: root, stateDir, picks: [1] });

  assert.equal(await main(['--apply'], picked.context), 0, picked.output());
  assert.match(picked.output(), /^lib {2}2 item\(s\)/m);
  assert.equal(existsSync(join(app, 'node_modules')), true);
  assert.equal(existsSync(join(lib, 'node_modules')), false);
  assert.equal(existsSync(join(lib, 'packages', 'ui', 'node_modules')), false);
});

test('as a process: refuses --apply without a terminal, deletes with --apply --yes', () => {
  const root = join(workspace, 'process');
  const app = makeRepo(root, 'app');

  write(join(app, 'node_modules', 'a.js'));

  const refused = runCli(['nmclean', '--apply'], { cwd: root, stateDir });

  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /No interactive terminal/);
  assert.equal(existsSync(join(app, 'node_modules')), true);

  const applied = runCli(['nmclean', '--apply', '--yes'], { cwd: root, stateDir });

  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.match(applied.stdout, /^ok {4}app\/node_modules/m);
  assert.equal(existsSync(join(app, 'node_modules')), false);
});

test('refuses to run in the home folder', () => {
  const env = { HOME: workspace, USERPROFILE: workspace };
  const result = runCli(['nmclean'], { cwd: workspace, stateDir, env });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /home folder/);
});
