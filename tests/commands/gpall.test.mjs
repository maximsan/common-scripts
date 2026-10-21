// @ts-check
// Tests for lib/commands/gpall.mjs.  Run:  node --test tests/commands/gpall.test.mjs
//
// Builds real repositories in a temp folder: one shared "remote" plus clones in
// different states, then checks that every repo is attempted and classified correctly.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepos, parseArgs, pullAll } from '../../lib/commands/gpall.mjs';
import { runCli, tempWorkspace } from '../setup.mjs';
import { git } from '../utils.mjs';

const { root: workspace, cleanup } = tempWorkspace('gpall');
const root = join(workspace, 'repos'); // the folder the script runs in (contains the clones)

/**
 * Write a file and commit it.
 * @param {string} repo  the repo folder
 * @param {string} file  file name inside the repo
 * @param {string} content  text to write
 * @param {string} message  commit message
 */
function commitFile(repo, file, content, message) {
  writeFileSync(join(repo, file), content);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', message);
}

before(() => {
  mkdirSync(root);

  // Shared remote with one commit.
  const remote = join(workspace, 'remote.git');
  const seed = join(workspace, 'seed');

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, seed], { stdio: 'pipe' });
  git(seed, 'checkout', '-q', '-b', 'main');
  commitFile(seed, 'a.txt', 'v1\n', 'c1');
  git(seed, 'push', '-q', 'origin', 'main');

  // Git for Windows checks files out with CRLF line endings by default; the clones keep the committed ones.
  for (const name of ['clean', 'diverged', 'dirty-conflict', 'broken-remote']) {
    execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', remote, join(root, name)]);
  }

  git(join(root, 'broken-remote'), 'remote', 'set-url', 'origin', join(workspace, 'does-not-exist.git'));
  execFileSync('git', ['init', '-q', join(root, 'no-upstream')]);
  mkdirSync(join(root, 'not-a-repo'));

  // New commit on the remote that every clone is now behind.
  commitFile(seed, 'a.txt', 'v2\n', 'c2');
  git(seed, 'push', '-q', 'origin', 'main');

  // Local commit -> branch diverges from the remote.
  commitFile(join(root, 'diverged'), 'local.txt', 'mine\n', 'local');
  // Uncommitted edit to the same file the remote changed.
  writeFileSync(join(root, 'dirty-conflict', 'a.txt'), 'my edit\n');
});

after(cleanup);

test('findRepos returns only folders containing .git', async () => {
  assert.deepEqual(await findRepos(root), [
    'broken-remote', 'clean', 'dirty-conflict', 'diverged', 'no-upstream',
  ]);
});

test('pullAll attempts every repo and keeps going after failures', async () => {
  /** @type {string[]} */
  const seen = [];
  const results = await pullAll(root, {
    jobs: 2,
    onResult: (result) => {
      seen.push(result.name);
    },
  });
  const byName = Object.fromEntries(results.map((result) => [result.name, result]));

  assert.equal(results.length, 5);
  assert.equal(seen.length, 5);

  assert.equal(byName.clean.ok, true);
  assert.equal(readFileSync(join(root, 'clean', 'a.txt'), 'utf8'), 'v2\n');

  for (const name of ['diverged', 'dirty-conflict', 'broken-remote', 'no-upstream']) {
    assert.equal(byName[name].ok, false, `${name} should fail`);
    assert.notEqual(byName[name].output, '', `${name} should carry git's error text`);
  }

  // Failed repos are left untouched.
  assert.equal(readFileSync(join(root, 'dirty-conflict', 'a.txt'), 'utf8'), 'my edit\n');
  assert.equal(git(join(root, 'diverged'), 'log', '-1', '--format=%s').toString().trim(), 'local');
});

test('parseArgs: optional job count or --help; anything else is refused', () => {
  assert.deepEqual(parseArgs([]), { help: false, jobs: 8 });
  assert.deepEqual(parseArgs(['3']), { help: false, jobs: 3 });
  assert.equal(parseArgs(['--help']).help, true);

  for (const bad of [['abc'], ['0'], ['2.5'], ['4', '4'], ['--apply']]) {
    assert.throws(() => parseArgs(bad), /job count/);
  }
});

test('as a process: --help prints the usage', () => {
  const result = runCli(['gpall', '--help'], { cwd: root, stateDir: join(workspace, 'state') });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /git pull --ff-only/);
});
