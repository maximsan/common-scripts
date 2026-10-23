// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isConfirmed } from '../../lib/shared/state.mjs';

test('the y/N question goes ahead only on "y" or "yes"', () => {
  for (const answer of ['y', 'Y', 'yes', 'YES', ' y ']) {
    assert.equal(isConfirmed(answer), true, answer);
  }

  for (const answer of ['', 'n', 'no', 'ye', 'yess', 'ok']) {
    assert.equal(isConfirmed(answer), false, answer);
  }
});
