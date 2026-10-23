// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { painter } from '../../lib/shared/colors.mjs';

test('painter colors by tone where the output shows colors, and changes nothing elsewhere', () => {
  const paint = painter(true);

  assert.equal(paint('ok', 'ok'), '\u001B[32mok\u001B[0m');
  assert.equal(paint('fail', 'FAIL'), '\u001B[31mFAIL\u001B[0m');
  assert.equal(paint('quiet', 'keep'), '\u001B[2mkeep\u001B[0m');
  assert.equal(painter(false)('fail', 'FAIL'), 'FAIL');
});
