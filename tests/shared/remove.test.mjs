// @ts-check
// Folder links are junctions on Windows and symlinks elsewhere (see linkFolder in tests/utils.mjs).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, linkSync, mkdirSync, readdirSync, statSync, symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { NODE_MODULES } from '../../lib/shared/constants.mjs';
import { HOST_RULES } from '../../lib/shared/platform.mjs';
import { safeRemoveTree } from '../../lib/shared/remove.mjs';
import { tempWorkspace } from '../setup.mjs';
import { FILE_LINK_SKIP, linkFolder, write } from '../utils.mjs';

const { root: workspace, cleanup } = tempWorkspace('shared-remove');
const PRIVATE_FILE_MODE = 0o600;
const READ_ONLY_FOLDER_MODE = 0o555;
const OPEN_FOLDER_MODE = 0o755;
const MODE_BITS = 0o777;

after(cleanup);

test('safeRemoveTree removes links but never their targets', async () => {
  const boundary = join(workspace, 'links');
  const outside = join(workspace, 'outside');
  const target = join(boundary, NODE_MODULES);

  write(join(outside, 'precious.txt'), 'keep me');
  write(join(target, 'pkg', 'index.js'));
  write(join(target, 'pkg', 'deep', 'a', 'b', 'c.js'));

  // Like a workspace junction.
  linkFolder(outside, join(target, 'linked-dir'));

  if (!FILE_LINK_SKIP) {
    symlinkSync(join(outside, 'precious.txt'), join(target, 'linked-file'));
  }

  assert.deepEqual(await safeRemoveTree(target, boundary), { ok: true, output: '' });
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(join(outside, 'precious.txt')), true);
});

test('safeRemoveTree refuses a target that is itself a link, or outside the boundary', async () => {
  const boundary = join(workspace, 'link-root');
  const real = join(workspace, 'real-modules');

  write(join(real, 'file.js'));
  mkdirSync(boundary, { recursive: true });
  linkFolder(real, join(boundary, NODE_MODULES));
  assert.match((await safeRemoveTree(join(boundary, NODE_MODULES), boundary)).output, /symlink/);
  assert.match((await safeRemoveTree(real, boundary)).output, /outside/);
  assert.equal(existsSync(join(real, 'file.js')), true);
});

test('a file that cannot be deleted keeps its mode, so a hard link outside the folder stays private', {
  skip: HOST_RULES.readOnlyBlocksDelete && 'here the read-only attribute must be cleared to delete a file',
}, async () => {
  const boundary = join(workspace, 'hard-links');
  const store = join(boundary, 'store', 'file');
  const locked = join(boundary, 'target', 'locked');

  write(store);
  chmodSync(store, PRIVATE_FILE_MODE);
  mkdirSync(locked, { recursive: true });

  // Like a pnpm store file linked into node_modules.
  linkSync(store, join(locked, 'file'));

  // Its folder refuses deletion.
  chmodSync(locked, READ_ONLY_FOLDER_MODE);

  try {
    await safeRemoveTree(join(boundary, 'target'), boundary);
    assert.equal(statSync(store).mode & MODE_BITS, PRIVATE_FILE_MODE);
  } finally {
    for (const name of readdirSync(boundary).filter((entry) => entry.startsWith('target'))) {
      // Renamed before deleting; let cleanup in.
      chmodSync(join(boundary, name, 'locked'), OPEN_FOLDER_MODE);
    }
  }
});
