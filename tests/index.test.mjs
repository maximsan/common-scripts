// @ts-check
// Tests for index.mjs, the one entry point.  Run:  node --test tests/index.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { INDEX_PATH, runCli, tempWorkspace } from './setup.mjs';
import { FILE_LINK_SKIP, makeRepo } from './utils.mjs';

const { root: workspace, cleanup } = tempWorkspace('index');
const stateDir = join(workspace, 'state');

after(cleanup);

test('without a command, or with --help, it lists every command', () => {
  for (const args of [[], ['--help']]) {
    const result = runCli(args, { cwd: workspace, stateDir });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /gpall .*nmclean .*nminstall .*devclean .*npmrctoken /s);
  }
});

test('an unknown command is refused without repeating it', () => {
  const result = runCli(['npm_SecretToken123456'], { cwd: workspace, stateDir });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown command/);
  assert.doesNotMatch(result.stderr + result.stdout, /SecretToken/);
});

test('runs a command when started through a symlink, as the devkit command from npm link is', {
  skip: FILE_LINK_SKIP,
}, () => {
  const root = join(workspace, 'via-link');

  makeRepo(root, 'app');

  const link = join(workspace, 'index-link.mjs');

  symlinkSync(INDEX_PATH, link);

  const result = runCli(['nmclean'], { cwd: root, stateDir, entry: link });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /node_modules in 1 repo/);
});
