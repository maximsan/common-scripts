// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../../lib/shared/cli.mjs';
import { SafetyError } from '../../lib/shared/errors.mjs';

test('parseArgs: bare number is jobs; unknown flags, prototype names and bad values are refused', () => {
  const spec = { defaults: { days: 30 }, numbers: { '--days': /** @type {'days'} */ ('days') } };
  const expected = { apply: true, yes: false, dryRun: false, help: false, jobs: 8, days: 5 };

  assert.deepEqual(parseArgs(['8', '--days', '5', '--apply'], spec), expected);

  const bads = [['--aply'], ['constructor'], ['--days', '0'], ['0'], ['--dry-run', '--apply'], ['--dry-run', '--yes']];

  for (const bad of bads) {
    assert.throws(() => parseArgs(bad, spec), SafetyError);
  }
});

test('parseArgs: a list takes only allowed names, or any names when it has no allowed set; never an empty list', () => {
  const spec = {
    defaults: { only: /** @type {Set<string> | null} */ (null), part: /** @type {Set<string> | null} */ (null) },
    lists: {
      '--only': { key: /** @type {'only'} */ ('only') },
      '--part': { key: /** @type {'part'} */ ('part'), allowed: ['a', 'b'] },
    },
  };

  assert.deepEqual(parseArgs(['--only', 'app,lib/node_modules'], spec).only, new Set(['app', 'lib/node_modules']));
  assert.deepEqual(parseArgs(['--part', 'b'], spec).part, new Set(['b']));

  for (const bad of [['--only'], ['--only', ','], ['--part', 'c']]) {
    assert.throws(() => parseArgs(bad, spec), SafetyError);
  }
});
