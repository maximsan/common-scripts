// @ts-check

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { NODE_MODULES } from '../../lib/shared/constants.mjs';
import { findRepos } from '../../lib/shared/discovery.mjs';
import { checkRepoFolder, planFolders, removeRepoFolder } from '../../lib/shared/repo-folder.mjs';
import { tempWorkspace } from '../setup.mjs';
import { git, linkFolder, makeRepo, write } from '../utils.mjs';

const { root: workspace, cleanup } = tempWorkspace('shared-repo-folder');

after(cleanup);

/**
 * Map of plan line name to its skip reason, for asserting on a whole plan.
 * @param {import('../../lib/shared/run.mjs').PlanItem[]} items  plan lines
 * @returns {Record<string, string | null>} skip reason per name; null means "will run"
 */
const skipByName = (items) => Object.fromEntries(items.map((item) => [item.name, item.skip]));

test('checkRepoFolder applies every repo-folder rule', async () => {
  const root = join(workspace, 'repo-folders');
  const repo = makeRepo(root, 'rules', { ignore: 'ok/\nlinked/\nnested/\n\\[ab\\]/\n' });
  const outside = join(workspace, 'repo-folders-outside');

  // Not ignored: its new name matches no rule.
  const leftover = 'gone.devkit-deleting-1712345678901';

  write(join(repo, 'ok', 'a.js'));
  write(join(outside, 'precious.txt'));
  linkFolder(outside, join(repo, 'linked'));
  write(join(repo, 'not-ignored', 'a.js'));
  write(join(repo, 'nested', 'patched-lib', '.git', 'HEAD'));
  write(join(repo, 'a'));
  git(repo, 'add', 'a');
  git(repo, 'commit', '-q', '-m', 'a');

  // "[ab]" is a folder name, not a glob matching the tracked "a".
  write(join(repo, '[ab]', 'x.js'));

  write(join(repo, leftover, 'x.js'));

  const caseRepo = makeRepo(root, 'case', { ignore: '' });

  write(join(caseRepo, 'Dist', 'a.js'));
  git(caseRepo, 'add', '.');
  git(caseRepo, 'commit', '-q', '-m', 'Dist');
  write(join(caseRepo, '.gitignore'), 'dist/\n');

  // A case-only rename, as on Windows.
  renameSync(join(caseRepo, 'Dist'), join(caseRepo, 'dist'));

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

    // A leftover is finished whatever its age.
    [repo, leftover, null, { keepIf: tooNew }],
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

  // Would make ls-files read the wrong repo.
  process.env.GIT_DIR = join(other, '.git');

  try {
    const { reason } = await checkRepoFolder(tracked, join(tracked, NODE_MODULES));

    assert.match(String(reason), /tracked/);
  } finally {
    delete process.env.GIT_DIR;
  }
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
