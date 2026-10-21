// @ts-check

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../../lib/commands/devclean/index.mjs';
import { runCli, tempWorkspace, testContext } from '../../setup.mjs';
import { backdate, makeRepo, write } from '../../utils.mjs';

const { root: workspace, cleanup } = tempWorkspace('devclean');

after(cleanup);

test('applied cleanup removes old temp entries, records the run, and --due goes quiet', async () => {
  const root = join(workspace, 'cli');

  makeRepo(root, 'app');

  const tempDir = join(workspace, 'cli-temp');

  write(join(tempDir, 'old.tmp'));
  backdate(join(tempDir, 'old.tmp'), 30);
  write(join(tempDir, 'new.tmp'));

  const stateDir = join(workspace, 'state');
  const before = testContext({ cwd: root, stateDir, tempDir });

  assert.equal(await main(['--due'], before.context), 0);
  assert.match(before.output(), /no cleanup recorded/);

  const applied = testContext({ cwd: root, stateDir, tempDir });

  assert.equal(await main(['--only', 'temp', '--apply'], applied.context), 0, applied.output());
  assert.equal(existsSync(join(tempDir, 'old.tmp')), false);
  assert.equal(existsSync(join(tempDir, 'new.tmp')), true);

  const later = testContext({ cwd: root, stateDir, tempDir });

  assert.equal(await main(['--due'], later.context), 0);
  assert.equal(later.output(), '');
});

test('as a process: --due reminds on a fresh state, and an unknown section is refused', () => {
  const root = join(workspace, 'process');
  const stateDir = join(workspace, 'process-state');

  makeRepo(root, 'app');

  /**
   * Run devclean as a child process in the test's repos folder.
   * @param {...string} args  command-line arguments
   * @returns {import('node:child_process').SpawnSyncReturns<string>} exit status and output
   */
  const devclean = (...args) => runCli(['devclean', ...args], { cwd: root, stateDir });

  assert.match(devclean('--due').stdout, /no cleanup recorded/);
  assert.equal(devclean('--only', 'temp,home').status, 2);
});
