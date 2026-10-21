// @ts-check
// Tests for lib/shared/processes.mjs.  Run:  node --test tests/shared/processes.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { HOST_RULES } from '../../lib/shared/platform.mjs';
import { processTree, runShell } from '../../lib/shared/processes.mjs';
import { tempWorkspace } from '../setup.mjs';
import { write } from '../utils.mjs';

const { root: workspace, cleanup } = tempWorkspace('core-processes');
const ON_WINDOWS = HOST_RULES.name === 'win32';

after(cleanup);

/**
 * Wait the given time.
 * @param {number} durationMs  milliseconds
 * @returns {Promise<void>} settles after the wait
 */
const sleep = (durationMs) => new Promise((resolve) => {
  setTimeout(resolve, durationMs);
});

test('processTree lists a process and all its descendants, parents first', () => {
  const psOutput = '  1     0\n 10     1\n 11    10\n 12    11\n 20     1\n 13    10\n';

  assert.deepEqual(processTree(10, psOutput), [10, 11, 13, 12]);
  assert.deepEqual(processTree(99, psOutput), [99]);
});

test('a timed-out command is killed together with the processes it started', {
  skip: ON_WINDOWS && 'uses sh syntax; taskkill is covered by the Windows check',
}, async () => {
  const result = await runShell('sleep 30 & echo $!; wait', { timeout: 500 });

  assert.equal(result.timedOut, true);

  const grandchild = Number(result.stdout.trim());

  /**
   * True while the grandchild process still exists.
   * @returns {boolean} whether it is alive
   */
  const alive = () => {
    try {
      process.kill(grandchild, 0);

      return true;
    } catch {
      return false;
    }
  };

  for (let attempt = 0; attempt < 50 && alive(); attempt += 1) {
    await sleep(100);
  }

  assert.equal(alive(), false);
});

test('npm planted in the current folder never runs, even with "." in PATH', {
  skip: ON_WINDOWS && 'Windows uses NoDefaultCurrentDirectoryInExePath',
}, async () => {
  const dir = join(workspace, 'planted');

  write(join(dir, 'npm'), '#!/bin/sh\necho planted\n');
  chmodSync(join(dir, 'npm'), 0o755);

  const previous = process.env.PATH;

  process.env.PATH = `.${delimiter}${previous}`;

  try {
    assert.doesNotMatch((await runShell('npm --version', { cwd: dir })).output, /planted/);
  } finally {
    process.env.PATH = previous;
  }
});
