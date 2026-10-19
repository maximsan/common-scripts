// @ts-check
// Tests for devkit-core.mjs.  Run:  node --test devkit-core.test.mjs
// Directory symlinks stand in for Windows junctions here; also run the junction smoke test on Windows.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, renameSync, symlinkSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import {
  assertSafeRoot, checkRepoFolder, findNamedDirs, findRepos, IS_WINDOWS, isInside, NODE_MODULES, parseArgs,
  planAndRun, planFolders, processTree, removeRepoFolder, resolveTempDir, runItems, runShell, safeRemoveTree,
  SafetyError, skippedItem, trashBase,
} from './devkit-core.mjs';
import { git, makeRepo, tempWorkspace, write } from './test-helpers.mjs';

const { root: workspace, cleanup } = tempWorkspace('devkit-core');

after(cleanup);

/**
 * Map of plan line name to its skip reason, for asserting on a whole plan.
 * @param {import('./devkit-core.mjs').PlanItem[]} items  plan lines
 * @returns {Record<string, string | null>} skip reason per name; null means "will run"
 */
const skipByName = (items) => Object.fromEntries(items.map((item) => [item.name, item.skip]));

/**
 * Wait the given time.
 * @param {number} durationMs  milliseconds
 * @returns {Promise<void>} settles after the wait
 */
const sleep = (durationMs) => new Promise((resolve) => {
  setTimeout(resolve, durationMs);
});

test('isInside: strict containment only', () => {
  assert.equal(isInside('/a/b', '/a/b/c'), true);
  assert.equal(isInside('/a/b', '/a/b'), false);
  assert.equal(isInside('/a/b', '/a/bc'), false);
  assert.equal(isInside('/a/b', '/a/b/../x'), false);
  assert.equal(isInside('/a/b', '/a/b/..foo'), true); // a folder literally named "..foo"
});

test('assertSafeRoot refuses filesystem root, home and AppData', async () => {
  await assert.rejects(assertSafeRoot('/'), SafetyError);

  const home = join(workspace, 'home');
  const appdata = join(workspace, 'appdata');
  const work = join(workspace, 'work');
  const windowsEnv = { home, env: { LOCALAPPDATA: appdata }, windows: true };

  for (const dir of [home, join(appdata, 'x'), work]) {
    mkdirSync(dir, { recursive: true });
  }

  await assert.rejects(assertSafeRoot(home, { home, env: {} }), /home folder/);
  await assert.rejects(assertSafeRoot(join(appdata, 'x'), windowsEnv), /LOCALAPPDATA/);
  assert.ok(await assertSafeRoot(work, windowsEnv));
});

test('assertSafeRoot on macOS and Linux refuses system folders and app data in the home folder', {
  skip: IS_WINDOWS,
}, async () => {
  const home = join(workspace, 'unix-home');

  mkdirSync(join(home, '.config', 'app'), { recursive: true });
  mkdirSync(join(home, 'projects'), { recursive: true });
  await assert.rejects(assertSafeRoot('/usr', { home }), /inside \/usr/);
  await assert.rejects(assertSafeRoot(join(home, '.config', 'app'), { home }), /~\/\.config/);
  assert.ok(await assertSafeRoot(join(home, 'projects'), { home }));
});

test('resolveTempDir accepts the system temp folder and refuses anything else', async () => {
  assert.ok(await resolveTempDir());
  await assert.rejects(resolveTempDir({ temp: workspace, home: workspace, platform: 'win32' }), /expected/);
  await assert.rejects(resolveTempDir({ temp: join(workspace, '..'), platform: 'freebsd' }), /no known temp folder/);

  if (!IS_WINDOWS) {
    await assert.rejects(resolveTempDir({ temp: '/usr' }), /expected/);
  }
});

test('processTree lists a process and all its descendants, parents first', () => {
  const psOutput = '  1     0\n 10     1\n 11    10\n 12    11\n 20     1\n 13    10\n';

  assert.deepEqual(processTree(10, psOutput), [10, 11, 13, 12]);
  assert.deepEqual(processTree(99, psOutput), [99]);
});

test('a timed-out command is killed together with the processes it started', {
  skip: IS_WINDOWS && 'uses sh syntax; taskkill is covered by the Windows check',
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
  skip: IS_WINDOWS && 'Windows uses NoDefaultCurrentDirectoryInExePath',
}, async () => {
  const dir = join(workspace, 'planted');

  write(join(dir, 'npm'), '#!/bin/sh\necho planted\n');
  chmodSync(join(dir, 'npm'), 0o755);

  const previous = process.env.PATH;

  process.env.PATH = `.${delimiter}${previous}`;

  try {
    // CHILD_ENV is built when devkit-core loads, so load a fresh copy while PATH is set.
    const { runShell: freshRunShell } = await import(`./devkit-core.mjs?path=${Date.now()}`);

    assert.doesNotMatch((await freshRunShell('npm --version', { cwd: dir })).output, /planted/);
  } finally {
    process.env.PATH = previous;
  }
});

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

test('planFolders applies the git guards and finds nested workspaces', async () => {
  const root = join(workspace, 'plan');
  const good = makeRepo(root, 'good');

  write(join(good, NODE_MODULES, 'a.js'));
  write(join(good, 'packages', 'web', 'package.json'), '{}');
  write(join(good, 'packages', 'web', NODE_MODULES, 'b.js'));
  write(join(makeRepo(root, 'not-ignored', { ignore: '' }), NODE_MODULES, 'a.js'));

  const tracked = makeRepo(root, 'tracked', { ignore: '' });

  write(join(tracked, NODE_MODULES, 'vendored.js'));
  git(tracked, 'add', '.');
  git(tracked, 'commit', '-q', '-m', 'vendor');
  write(join(tracked, '.gitignore'), `${NODE_MODULES}/\n`);

  const skips = skipByName(await planFolders(await findRepos(root), [NODE_MODULES], { jobs: 2 }));

  assert.equal(skips['good/node_modules'], null);
  assert.equal(skips['good/packages/web/node_modules'], null);
  assert.match(String(skips['not-ignored/node_modules']), /not ignored/);
  assert.match(String(skips['tracked/node_modules']), /tracked/);
});

test('search skips dot-folders, folders without package.json, and nested repos', async () => {
  const repo = makeRepo(join(workspace, 'search'), 'repo', { ignore: 'dist/\n.venv/\nlib/\n' });

  write(join(repo, '.venv', 'Lib', 'site-packages', 'pkg', 'package.json'), '{}');
  write(join(repo, '.venv', 'Lib', 'site-packages', 'pkg', 'dist', 'x.py'));
  write(join(repo, 'lib', 'dist', 'not-a-package.txt'));
  makeRepo(repo, 'inner');
  write(join(repo, 'inner', 'dist', 'x.js'));
  assert.deepEqual(await findNamedDirs(repo, ['dist']), []);
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
    // CHILD_ENV is built when devkit-core loads, so load a fresh copy while GIT_DIR is set.
    const { checkRepoFolder: freshCheck } = await import(`./devkit-core.mjs?env=${Date.now()}`);
    const { reason } = await freshCheck(tracked, join(tracked, NODE_MODULES));

    assert.match(String(reason), /tracked/);
  } finally {
    delete process.env.GIT_DIR;
  }
});

test('only devkit-made leftovers count as leftovers', () => {
  assert.equal(trashBase('node_modules.devkit-deleting-1712345678901'), NODE_MODULES);
  assert.equal(trashBase('node_modules.devkit-deleting-mine'), null);
});

test('runItems attempts every item and returns failures as data', async () => {
  /** @type {import('./devkit-core.mjs').PlanItem[]} */
  const items = [
    { name: 'good', skip: null, run: async () => ({ ok: true, output: '' }) },
    { name: 'bad', skip: null, run: async () => ({ ok: false, output: 'boom' }) },
    {
      name: 'throws',
      skip: null,
      run: async () => {
        throw new Error('crash');
      },
    },
  ];
  const results = await runItems(items, { jobs: 2 });

  assert.deepEqual(
    results.map((result) => [result.name, result.ok, result.output]),
    [['good', true, ''], ['bad', false, 'boom'], ['throws', false, 'crash']],
  );
});

test('planAndRun returns exit code 1 on a failure and refuses while another run holds the lock', async () => {
  process.env.LOCALAPPDATA = join(workspace, 'state');

  const options = { apply: true, yes: true, help: false, jobs: 1 };
  const failing = { name: 'bad', skip: null, run: async () => ({ ok: false, output: 'boom' }) };
  const sections = [{ title: 'test', items: [failing, skippedItem('kept', 'reason')] }];

  assert.deepEqual(await planAndRun({ sections, options, verb: 'run', logName: 'test' }), { code: 1, applied: true });

  write(join(workspace, 'state', 'devkit', 'devkit.lock'), '999999\n');

  const whileLocked = planAndRun({ sections, options, verb: 'run', logName: 'test' });

  await assert.rejects(whileLocked, /Another devkit script is running/);
});

test('parseArgs: bare number is jobs; unknown flags, prototype names and bad values are refused', () => {
  const spec = { defaults: { days: 30 }, numbers: { '--days': /** @type {'days'} */ ('days') } };
  const expected = { apply: true, yes: false, help: false, jobs: 8, days: 5 };

  assert.deepEqual(parseArgs(['8', '--days', '5', '--apply'], spec), expected);

  for (const bad of [['--aply'], ['constructor'], ['--days', '0'], ['0']]) {
    assert.throws(() => parseArgs(bad, spec), SafetyError);
  }
});
