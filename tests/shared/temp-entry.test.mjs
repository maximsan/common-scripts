// @ts-check
// Tests for lib/shared/temp-entry.mjs.  Run:  node --test tests/shared/temp-entry.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DAY_MS } from '../../lib/shared/constants.mjs';
import { HOST_RULES } from '../../lib/shared/platform.mjs';
import { checkTempEntry, removeTempEntry } from '../../lib/shared/temp-entry.mjs';
import { tempWorkspace } from '../setup.mjs';
import { backdate, linkFolder, write } from '../utils.mjs';

const { root: workspace, cleanup } = tempWorkspace('shared-temp-entry');
const ON_WINDOWS = HOST_RULES.name === 'win32';

after(cleanup);

test('checkTempEntry applies every temp-entry rule', async () => {
  const temp = join(workspace, 'temp-rules');
  const outside = join(workspace, 'temp-rules-outside');
  const cutoff = Date.now() - 7 * DAY_MS;

  write(join(temp, 'old.log'));
  backdate(join(temp, 'old.log'), 20);
  write(join(temp, 'new.log'));
  write(join(temp, 'old-dir', 'x.txt'));
  backdate(join(temp, 'old-dir', 'x.txt'), 20);
  backdate(join(temp, 'old-dir'), 20);
  write(join(temp, 'mixed', 'old.txt'));
  backdate(join(temp, 'mixed', 'old.txt'), 20);
  write(join(temp, 'mixed', 'new.txt'));
  write(join(outside, 'precious.txt'));
  linkFolder(outside, join(temp, 'linked'));
  write(join(temp, 'old-clone', '.git', 'HEAD'));
  backdate(join(temp, 'old-clone', '.git', 'HEAD'), 20);
  backdate(join(temp, 'old-clone', '.git'), 20);
  backdate(join(temp, 'old-clone'), 20);

  /** @type {[string, RegExp | null][]} */
  const cases = [
    ['old.log', null],
    ['new.log', /changed recently/],
    ['old-dir', null],
    ['mixed', /changed recently/], // one new file keeps the whole folder
    ['linked', /symlink/],
    ['missing', /no longer exists/],
    ['old-clone', /nested git repo/], // deleting it would leave .git behind
  ];

  for (const [name, expected] of cases) {
    const { reason } = await checkTempEntry(temp, join(temp, name), cutoff);

    if (expected) {
      assert.match(String(reason), expected, name);
    } else {
      assert.equal(reason, null, name);
    }
  }
});

test('a temp folder holding a socket is kept, whatever its age', {
  skip: ON_WINDOWS && 'a Windows server path is a named pipe, not a file in the folder',
}, async () => {
  const temp = join(workspace, 'temp-socket');
  const folder = join(temp, 'agent-dir');
  const previous = process.cwd();

  mkdirSync(folder, { recursive: true });
  process.chdir(folder); // a short relative path: socket paths are limited to about 100 characters

  const server = createServer();

  try {
    await new Promise((resolve) => {
      server.listen('agent.sock', () => resolve(undefined));
    });
    backdate(join(folder, 'agent.sock'), 20);
    backdate(folder, 20);

    const { reason } = await checkTempEntry(temp, folder, Date.now() - 7 * DAY_MS);

    assert.match(String(reason), /socket/);
  } finally {
    server.close();
    process.chdir(previous);
  }
});

test('removeTempEntry checks again and keeps an entry that changed after planning', async () => {
  const temp = join(workspace, 'temp-recheck');
  const outside = join(workspace, 'temp-recheck-outside');
  const cutoff = Date.now() - 7 * DAY_MS;

  for (const name of ['touched.log', 'swapped.log', 'gone.log']) {
    write(join(temp, name));
    backdate(join(temp, name), 20);
  }

  write(join(temp, 'touched-dir', 'x.txt'));
  backdate(join(temp, 'touched-dir', 'x.txt'), 20);
  backdate(join(temp, 'touched-dir'), 20);
  write(join(outside, 'precious.txt'));

  for (const name of ['touched.log', 'swapped.log', 'gone.log', 'touched-dir']) {
    assert.equal((await checkTempEntry(temp, join(temp, name), cutoff)).reason, null, `${name} is planned`);
  }

  write(join(temp, 'touched.log'));
  write(join(temp, 'touched-dir', 'new.txt'));
  rmSync(join(temp, 'swapped.log'));
  linkFolder(outside, join(temp, 'swapped.log'));

  assert.match((await removeTempEntry(temp, join(temp, 'touched.log'), cutoff)).output, /changed recently.*kept/);
  assert.match((await removeTempEntry(temp, join(temp, 'touched-dir'), cutoff)).output, /changed recently.*kept/);
  assert.match((await removeTempEntry(temp, join(temp, 'swapped.log'), cutoff)).output, /symlink.*kept/);
  assert.equal(existsSync(join(temp, 'touched.log')), true);
  assert.equal(existsSync(join(temp, 'touched-dir', 'x.txt')), true);
  assert.equal(existsSync(join(outside, 'precious.txt')), true);

  assert.deepEqual(await removeTempEntry(temp, join(temp, 'gone.log'), cutoff), { ok: true, output: '' });
  assert.equal(existsSync(join(temp, 'gone.log')), false);
});
