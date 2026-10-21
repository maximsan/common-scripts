// @ts-check

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { findTokenLines, main, maskToken, parseCommandLine, planEdit } from '../../lib/commands/npmrctoken.mjs';
import { runCli, tempWorkspace, testContext } from '../setup.mjs';
import { FILE_LINK_SKIP, makeRepo, write } from '../utils.mjs';

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

test('dry run lists every file, --apply updates them, and the full token never appears in output or log', async () => {
  const root = join(workspace, 'repos');
  const app = makeRepo(root, 'app');
  const lib = makeRepo(root, 'lib');
  const tools = makeRepo(root, 'tools');
  const tokenLine = `//npm.example.com/:_authToken=${OLD_TOKEN}\n`;

  write(join(app, '.npmrc'), tokenLine);
  write(join(lib, 'packages', 'ui', 'package.json'), '{}');
  write(join(lib, 'packages', 'ui', '.npmrc'), tokenLine);

  // Not a package folder: ignored.
  write(join(lib, 'docs', '.npmrc'), tokenLine);

  write(join(tools, '.npmrc'), `${tokenLine}//npm.other.com/:_authToken=${OLD_TOKEN}\n`);

  const dryRun = testContext({ cwd: root, stateDir });

  assert.equal(await main([NEW_TOKEN], dryRun.context), 0);

  const planned = dryRun.output();

  assert.match(planned, /do {4}app\/\.npmrc .*npm_\*{12}1111 {2}-> {2}npm_\*{12}2222/);
  assert.match(planned, /do {4}lib\/packages\/ui\/\.npmrc/);
  assert.match(planned, /keep {2}tools\/\.npmrc .*WARNING: 2 _authToken lines/);
  assert.match(planned, /1 warning\(s\)/);
  assert.doesNotMatch(planned, /docs/);
  assert.equal(readFileSync(join(app, '.npmrc'), 'utf8'), tokenLine);

  const applied = testContext({ cwd: root, stateDir });
  const newLine = tokenLine.replace(OLD_TOKEN, NEW_TOKEN);

  assert.equal(await main([NEW_TOKEN, '--apply'], applied.context), 0, applied.output());
  assert.match(applied.output(), /ok {4}app\/\.npmrc +now npm_\*{12}2222/);
  assert.match(applied.output(), /ok {4}lib\/packages\/ui\/\.npmrc +now npm_\*{12}2222/);
  assert.equal(readFileSync(join(app, '.npmrc'), 'utf8'), newLine);
  assert.equal(readFileSync(join(lib, 'packages', 'ui', '.npmrc'), 'utf8'), newLine);
  assert.equal(readFileSync(join(lib, 'docs', '.npmrc'), 'utf8'), tokenLine);
  assert.match(readFileSync(join(tools, '.npmrc'), 'utf8'), new RegExp(OLD_TOKEN));

  const logsDir = join(stateDir, 'logs');
  const logs = readdirSync(logsDir).map((file) => readFileSync(join(logsDir, file), 'utf8')).join('');

  for (const output of [planned, applied.output(), logs]) {
    assert.doesNotMatch(output, new RegExp(`${OLD_TOKEN}|${NEW_TOKEN}`));
  }
});

test('a .npmrc that is a link is left alone, so a user-wide file is never changed', {
  skip: FILE_LINK_SKIP,
}, async () => {
  const root = join(workspace, 'linked');
  const lib = makeRepo(root, 'lib');
  const shared = join(workspace, 'user-npmrc');
  const tokenLine = `//npm.example.com/:_authToken=${OLD_TOKEN}\n`;

  write(shared, tokenLine);
  symlinkSync(shared, join(lib, '.npmrc'));

  const applied = testContext({ cwd: root, stateDir });

  assert.equal(await main([NEW_TOKEN, '--apply'], applied.context), 0, applied.output());
  assert.match(applied.output(), /keep {2}lib\/\.npmrc .*symlink/);
  assert.equal(readFileSync(shared, 'utf8'), tokenLine);
});

test('as a process: prints the masked plan', () => {
  const root = join(workspace, 'process');
  const app = makeRepo(root, 'app');

  write(join(app, '.npmrc'), `//npm.example.com/:_authToken=${OLD_TOKEN}\n`);

  const dryRun = runCli(['npmrctoken', NEW_TOKEN], { cwd: root, stateDir });

  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /do {4}app\/\.npmrc .*npm_\*{12}2222/);
  assert.doesNotMatch(dryRun.stdout, new RegExp(NEW_TOKEN));
});
