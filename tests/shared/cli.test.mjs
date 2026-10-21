// @ts-check
// Tests for lib/shared/cli.mjs.  Run:  node --test tests/shared/cli.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../../lib/shared/cli.mjs';
import { SafetyError } from '../../lib/shared/errors.mjs';

test('parseArgs: bare number is jobs; unknown flags, prototype names and bad values are refused', () => {
  const spec = { defaults: { days: 30 }, numbers: { '--days': /** @type {'days'} */ ('days') } };
  const expected = { apply: true, yes: false, help: false, jobs: 8, days: 5 };

  assert.deepEqual(parseArgs(['8', '--days', '5', '--apply'], spec), expected);

  for (const bad of [['--aply'], ['constructor'], ['--days', '0'], ['0']]) {
    assert.throws(() => parseArgs(bad, spec), SafetyError);
  }
});
