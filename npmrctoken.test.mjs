// @ts-check
// Tests for npmrctoken.mjs.  Run:  node --test npmrctoken.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { findTokenLines, maskToken, parseCommandLine, planEdit } from './npmrctoken.mjs';
import { makeRepo, runScript, tempWorkspace, write } from './test-helpers.mjs';

const { root: workspace, cleanup } = tempWorkspace('npmrctoken');
const stateDir = join(workspace, 'state');
const OLD_TOKEN = 'npm_OldOldOldOld1111';
const NEW_TOKEN = 'npm_NewNewNewNew2222';

after(cleanup);

test('planEdit replaces only the value after "=" and keeps every other byte', () => {
  const text = '# comment: //x/:_authToken=keep\r\nregistry=https://npm.example.com/\r\n'
    + '//npm.example.com/:_authToken = 123  \r\nalways-auth=true';
  const edit = planEdit(text, '345');

  assert.ok('text' in edit);
  assert.equal(edit.registry, '//npm.example.com/');
  assert.equal(edit.oldToken, '123');
  assert.equal(edit.text, text.replace('= 123  ', '= 345  '));
});

test('planEdit warns about several token lines and skips files without one or already up to date', () => {
  const two = planEdit('//a/:_authToken=1\n//b/:_authToken=2\n', 'new');

  assert.ok('skip' in two);
  assert.equal(two.warning, true);
  assert.match(two.skip, /2 _authToken lines/);

  assert.deepEqual(planEdit('registry=https://x/\n', 'new'), { skip: 'no _authToken line', warning: false });

  const same = planEdit('//a/:_authToken=same\n', 'same');

  assert.ok('skip' in same);
  assert.match(same.skip, /already has/);
  assert.deepEqual(findTokenLines('_authToken=abc\n'), [{ registry: '(default registry)', token: 'abc' }]);
});

test('maskToken shows the first and last 4 characters only for tokens longer than 12', () => {
  assert.equal(maskToken('npm_AbCdEf123456XyZ9'), 'npm_************XyZ9');
  assert.equal(maskToken('123456789012'), '************');
});

test('parseCommandLine: the token comes first, even when it looks like a job count', () => {
  assert.equal(parseCommandLine(['345', '--apply']).token, '345');
  assert.equal(parseCommandLine(['345', '--apply']).options.apply, true);
  assert.equal(parseCommandLine(['--help']).options.help, true);

  for (const bad of [[], ['--apply'], ['two words'], ['token', '--aply']]) {
    assert.throws(() => parseCommandLine(bad), /token|Unknown option/);
  }
});

test('dry run lists every file, --apply updates them, and the full token never appears in output or log', () => {
  const root = join(workspace, 'repos');
  const app = makeRepo(root, 'app');
  const lib = makeRepo(root, 'lib');
  const tools = makeRepo(root, 'tools');
  const shared = join(workspace, 'user-npmrc');
  const tokenLine = `//npm.example.com/:_authToken=${OLD_TOKEN}\n`;

  write(join(app, '.npmrc'), tokenLine);
  write(join(lib, 'packages', 'ui', 'package.json'), '{}');
  write(join(lib, 'packages', 'ui', '.npmrc'), tokenLine);
  write(join(lib, 'docs', '.npmrc'), tokenLine); // not a package folder: ignored
  write(join(tools, '.npmrc'), `${tokenLine}//npm.other.com/:_authToken=${OLD_TOKEN}\n`);
  write(shared, tokenLine);
  symlinkSync(shared, join(lib, '.npmrc'));

  /**
   * Run npmrctoken as a child process in the test's repos folder.
   * @param {...string} args  command-line arguments
   * @returns {import('node:child_process').SpawnSyncReturns<string>} exit status and output
   */
  const npmrctoken = (...args) => runScript('npmrctoken.mjs', args, { cwd: root, stateDir });

  const dryRun = npmrctoken(NEW_TOKEN);

  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /do {4}app\/\.npmrc .*npm_\*{12}1111 {2}-> {2}npm_\*{12}2222/);
  assert.match(dryRun.stdout, /do {4}lib\/packages\/ui\/\.npmrc/);
  assert.match(dryRun.stdout, /keep {2}lib\/\.npmrc .*symlink/);
  assert.match(dryRun.stdout, /keep {2}tools\/\.npmrc .*WARNING: 2 _authToken lines/);
  assert.match(dryRun.stdout, /1 warning\(s\)/);
  assert.doesNotMatch(dryRun.stdout, /docs/);
  assert.equal(readFileSync(join(app, '.npmrc'), 'utf8'), tokenLine);

  const applied = npmrctoken(NEW_TOKEN, '--apply', '--yes');
  const newLine = tokenLine.replace(OLD_TOKEN, NEW_TOKEN);

  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.match(applied.stdout, /ok {4}app\/\.npmrc +now npm_\*{12}2222/);
  assert.match(applied.stdout, /ok {4}lib\/packages\/ui\/\.npmrc +now npm_\*{12}2222/);
  assert.equal(readFileSync(join(app, '.npmrc'), 'utf8'), newLine);
  assert.equal(readFileSync(join(lib, 'packages', 'ui', '.npmrc'), 'utf8'), newLine);
  assert.equal(readFileSync(join(lib, 'docs', '.npmrc'), 'utf8'), tokenLine);
  assert.equal(readFileSync(shared, 'utf8'), tokenLine);
  assert.match(readFileSync(join(tools, '.npmrc'), 'utf8'), new RegExp(OLD_TOKEN));

  const logsDir = join(stateDir, 'devkit', 'logs');
  const logs = readdirSync(logsDir).map((file) => readFileSync(join(logsDir, file), 'utf8')).join('');

  for (const output of [dryRun.stdout, applied.stdout, logs]) {
    assert.doesNotMatch(output, new RegExp(`${OLD_TOKEN}|${NEW_TOKEN}`));
  }
});
