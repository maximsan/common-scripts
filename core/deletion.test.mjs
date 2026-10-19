// @ts-check
// Tests for core/deletion.mjs.  Run:  node --test core/deletion.test.mjs
// Directory symlinks stand in for Windows junctions here; also run the junction smoke test on Windows.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, renameSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { NODE_MODULES } from './constants.mjs';
import { checkRepoFolder, removeRepoFolder, safeRemoveTree } from './deletion.mjs';
import { git, makeRepo, tempWorkspace, write } from '../test-helpers.mjs';

const { root: workspace, cleanup } = tempWorkspace('core-deletion');

after(cleanup);

test('safeRemoveTree removes links but never their targets', async () => {
  const boundary = join(workspace, 'links');
  const outside = join(workspace, 'outside');
  const target = join(boundary, NODE_MODULES);

  write(join(outside, 'precious.txt'), 'keep me');
  write(join(target, 'pkg', 'index.js'));
  write(join(target, 'pkg', 'deep', 'a', 'b', 'c.js'));
  symlinkSync(outside, join(target, 'linked-dir'), 'dir'); // like a workspace junction
  symlinkSync(join(outside, 'precious.txt'), join(target, 'linked-file'));
  assert.deepEqual(await safeRemoveTree(target, boundary), { ok: true, output: '' });
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(join(outside, 'precious.txt')), true);
});

test('safeRemoveTree refuses a target that is itself a link, or outside the boundary', async () => {
  const boundary = join(workspace, 'link-root');
  const real = join(workspace, 'real-modules');

  write(join(real, 'file.js'));
  mkdirSync(boundary, { recursive: true });
  symlinkSync(real, join(boundary, NODE_MODULES), 'dir');
  assert.match((await safeRemoveTree(join(boundary, NODE_MODULES), boundary)).output, /symlink/);
  assert.match((await safeRemoveTree(real, boundary)).output, /outside/);
  assert.equal(existsSync(join(real, 'file.js')), true);
});

test('checkRepoFolder applies every repo-folder rule', async () => {
  const root = join(workspace, 'repo-folders');
  const repo = makeRepo(root, 'rules', { ignore: 'ok/\nlinked/\nnested/\n\\[ab\\]/\n' });
  const outside = join(workspace, 'repo-folders-outside');
  const leftover = 'gone.devkit-deleting-1712345678901'; // not ignored: its new name matches no rule

  write(join(repo, 'ok', 'a.js'));
  write(join(outside, 'precious.txt'));
  symlinkSync(outside, join(repo, 'linked'), 'dir');
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
