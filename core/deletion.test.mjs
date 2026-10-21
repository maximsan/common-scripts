// @ts-check
// Tests for core/deletion.mjs.  Run:  node --test core/deletion.test.mjs
// Directory symlinks stand in for Windows junctions here; also run the junction smoke test on Windows.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, linkSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, symlinkSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DAY_MS, NODE_MODULES } from './constants.mjs';
import { HOST_RULES } from './platform.mjs';
import { checkRepoFolder, checkTempEntry, removeRepoFolder, removeTempEntry, safeRemoveTree } from './deletion.mjs';
import { backdate, FILE_LINK_SKIP, git, linkFolder, makeRepo, tempWorkspace, write } from '../test-helpers.mjs';

const { root: workspace, cleanup } = tempWorkspace('core-deletion');
const ON_WINDOWS = HOST_RULES.name === 'win32';
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
  linkFolder(outside, join(target, 'linked-dir')); // like a workspace junction

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
  linkSync(store, join(locked, 'file')); // like a pnpm store file linked into node_modules
  chmodSync(locked, READ_ONLY_FOLDER_MODE); // its folder refuses deletion

  try {
    await safeRemoveTree(join(boundary, 'target'), boundary);
    assert.equal(statSync(store).mode & MODE_BITS, PRIVATE_FILE_MODE);
  } finally {
    for (const name of readdirSync(boundary).filter((entry) => entry.startsWith('target'))) {
      chmodSync(join(boundary, name, 'locked'), OPEN_FOLDER_MODE); // renamed before deleting; let cleanup in
    }
  }
});

test('checkRepoFolder applies every repo-folder rule', async () => {
  const root = join(workspace, 'repo-folders');
  const repo = makeRepo(root, 'rules', { ignore: 'ok/\nlinked/\nnested/\n\\[ab\\]/\n' });
  const outside = join(workspace, 'repo-folders-outside');
  const leftover = 'gone.devkit-deleting-1712345678901'; // not ignored: its new name matches no rule

  write(join(repo, 'ok', 'a.js'));
  write(join(outside, 'precious.txt'));
  linkFolder(outside, join(repo, 'linked'));
  write(join(repo, 'not-ignored', 'a.js'));
  write(join(repo, 'nested', 'patched-lib', '.git', 'HEAD'));
  write(join(repo, 'a'));
  git(repo, 'add', 'a');
  git(repo, 'commit', '-q', '-m', 'a');
  write(join(repo, '[ab]', 'x.js')); // "[ab]" is a folder name, not a glob matching the tracked "a"
  write(join(repo, leftover, 'x.js'));

  const caseRepo = makeRepo(root, 'case', { ignore: '' });

  write(join(caseRepo, 'Dist', 'a.js'));
  git(caseRepo, 'add', '.');
  git(caseRepo, 'commit', '-q', '-m', 'Dist');
  write(join(caseRepo, '.gitignore'), 'dist/\n');
  renameSync(join(caseRepo, 'Dist'), join(caseRepo, 'dist')); // a case-only rename, as on Windows

  /**
   * Always keeps, like an age rule that finds the folder too new.
   * @returns {Promise<string>} the keep reason
   */
  const tooNew = async () => 'too new';

  /** @type {[string, string, RegExp | null, Parameters<typeof checkRepoFolder>[2]?][]} */
  const cases = [
    [repo, 'ok', null],
    [repo, 'linked', /symlink/],
    [repo, 'not-ignored', /not ignored/],
    [repo, 'nested', /nested git repo/],
    [repo, '[ab]', null],
    [repo, leftover, null],
    [caseRepo, 'dist', /tracked/],
    [repo, 'ok', /too new/, { keepIf: tooNew }],
    [repo, leftover, null, { keepIf: tooNew }], // a leftover is finished whatever its age
  ];

  for (const [repoReal, folder, expected, options] of cases) {
    const { reason } = await checkRepoFolder(repoReal, join(repoReal, folder), options);
    const label = `${folder}${options ? ' with keepIf' : ''}`;

    if (expected) {
      assert.match(String(reason), expected, label);
    } else {
      assert.equal(reason, null, label);
    }
  }
});

test('removeRepoFolder checks again and deletes only a folder that passes', async () => {
  const repo = makeRepo(join(workspace, 'remove-folder'), 'repo');

  write(join(repo, NODE_MODULES, 'a.js'));
  write(join(repo, 'dist', 'pkg', '.git', 'HEAD'));

  assert.deepEqual(await removeRepoFolder(repo, join(repo, NODE_MODULES)), { ok: true, output: '' });
  assert.equal(existsSync(join(repo, NODE_MODULES)), false);

  const kept = await removeRepoFolder(repo, join(repo, 'dist'));

  assert.equal(kept.ok, false);
  assert.match(kept.output, /nested git repo.*re-checked before deleting; kept/);
  assert.equal(existsSync(join(repo, 'dist', 'pkg', '.git', 'HEAD')), true);
});

test('checkRepoFolder ignores GIT_DIR / GIT_INDEX_FILE inherited from the parent shell', async () => {
  const root = join(workspace, 'git-env');
  const tracked = makeRepo(root, 'tracked', { ignore: '' });

  write(join(tracked, NODE_MODULES, 'v.js'));
  git(tracked, 'add', '.');
  git(tracked, 'commit', '-q', '-m', 'vendor');

  const other = makeRepo(root, 'other');

  process.env.GIT_DIR = join(other, '.git'); // would make ls-files read the wrong repo

  try {
    const { reason } = await checkRepoFolder(tracked, join(tracked, NODE_MODULES));

    assert.match(String(reason), /tracked/);
  } finally {
    delete process.env.GIT_DIR;
  }
});

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
