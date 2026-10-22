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

  assert.equal(await main(['--dry-run'], dryRun.context), 0);
  assert.match(dryRun.output(), /Dry run: nothing changed/);
  assert.match(dryRun.output(), /lib\/packages\/ui\/node_modules/);
  assert.equal(existsSync(join(app, 'node_modules', 'big.js')), true);

  await assert.rejects(main(['--aply'], dryRun.context), SafetyError);

  const declined = testContext({ cwd: root, stateDir, answer: false });

  assert.equal(await main([], declined.context), 0);
  assert.match(declined.output(), /Cancelled/);
  assert.equal(existsSync(join(app, 'node_modules')), true);

  const confirmed = testContext({ cwd: root, stateDir });

  assert.equal(await main(['2'], confirmed.context), 0, confirmed.output());
  assert.match(confirmed.output(), /Done: 2 item\(s\), all ok/);
  assert.equal(existsSync(join(app, 'node_modules')), false);
  assert.equal(existsSync(join(lib, 'packages', 'ui', 'node_modules')), false);
  assert.equal(existsSync(join(app, 'index.js')), true);
});

test('the pick list shows every node_modules on its own line and deletes only the picked ones', async () => {
  const root = join(workspace, 'picked');
  const app = makeRepo(root, 'app');
  const lib = makeRepo(root, 'lib');

  write(join(app, 'node_modules', 'a.js'));
  write(join(lib, 'node_modules', 'a.js'));
  write(join(lib, 'packages', 'ui', 'package.json'), '{}');
  write(join(lib, 'packages', 'ui', 'node_modules', 'a.js'));

  const picked = testContext({ cwd: root, stateDir, picks: [0, 2] });

  assert.equal(await main([], picked.context), 0, picked.output());
  assert.match(picked.output(), /^lib\/packages\/ui\/node_modules {2}1 B$/m);
  assert.equal(existsSync(join(app, 'node_modules')), false);
  assert.equal(existsSync(join(lib, 'node_modules')), true);
  assert.equal(existsSync(join(lib, 'packages', 'ui', 'node_modules')), false);
});

test('--only takes repo names and folder paths; a name that matches nothing changes nothing', async () => {
  const root = join(workspace, 'only');
  const app = makeRepo(root, 'app');
  const lib = makeRepo(root, 'lib');
  const web = makeRepo(root, 'web');

  for (const repo of [app, lib, web]) {
    write(join(repo, 'node_modules', 'a.js'));
  }

  write(join(lib, 'packages', 'ui', 'package.json'), '{}');
  write(join(lib, 'packages', 'ui', 'node_modules', 'a.js'));

  const dryRun = testContext({ cwd: root, stateDir, command: 'nmclean' });

  assert.equal(await main(['--only', 'app,lib\\packages\\ui\\node_modules/', '--dry-run'], dryRun.context), 0);
  assert.match(dryRun.output(), /app\/node_modules/);
  assert.match(dryRun.output(), /lib\/packages\/ui\/node_modules/);
  assert.doesNotMatch(dryRun.output(), /lib\/node_modules|web\//);
  assert.match(dryRun.output(), /devkit nmclean --only app,lib\S* --yes/);

  await assert.rejects(main(['--only', 'app,wbe', '--yes'], dryRun.context), /no repo .*: wbe/);
  assert.equal(existsSync(join(app, 'node_modules')), true);

  const applied = testContext({ cwd: root, stateDir });

  assert.equal(await main(['--only', 'lib', '--yes'], applied.context), 0, applied.output());
  assert.equal(existsSync(join(lib, 'node_modules')), false);
  assert.equal(existsSync(join(lib, 'packages', 'ui', 'node_modules')), false);
  assert.equal(existsSync(join(app, 'node_modules')), true);
  assert.equal(existsSync(join(web, 'node_modules')), true);
});

test('in a terminal, a plain run picks and confirms; --dry-run only looks', async () => {
  const root = join(workspace, 'terminal');
  const app = makeRepo(root, 'app');
  const lib = makeRepo(root, 'lib');

  write(join(app, 'node_modules', 'a.js'));
  write(join(lib, 'node_modules', 'a.js'));

  const looked = testContext({ cwd: root, stateDir, interactive: true });

  assert.equal(await main(['--dry-run'], looked.context), 0);
  assert.match(looked.output(), /Dry run: nothing changed/);
  assert.doesNotMatch(looked.output(), /Pick what to delete/);
  assert.equal(existsSync(join(app, 'node_modules')), true);

  const picked = testContext({ cwd: root, stateDir, interactive: true, picks: [1] });

  assert.equal(await main([], picked.context), 0, picked.output());
  assert.match(picked.output(), /Pick what to delete/);
  assert.equal(existsSync(join(app, 'node_modules')), true);
  assert.equal(existsSync(join(lib, 'node_modules')), false);
});

test('as a process: without a terminal only the plan is printed; --yes deletes', () => {
  const root = join(workspace, 'process');
  const app = makeRepo(root, 'app');

  write(join(app, 'node_modules', 'a.js'));

  const looked = runCli(['nmclean'], { cwd: root, stateDir });

  assert.equal(looked.status, 0, looked.stderr);
  assert.match(looked.stdout, /Dry run: nothing changed/);
  assert.equal(existsSync(join(app, 'node_modules')), true);

  const applied = runCli(['nmclean', '--yes'], { cwd: root, stateDir });

  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.match(applied.stdout, /^ok {4}app\/node_modules/m);
  assert.equal(existsSync(join(app, 'node_modules')), false);
});

test('refuses to run in the home folder', async () => {
  const { context } = testContext({ cwd: workspace, stateDir, home: workspace });

  await assert.rejects(main([], context), /home folder/);
});
