// @ts-check
// Tests for lib/commands/devclean/temp.mjs.  Run:  node --test tests/commands/devclean/temp.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { planTemp } from '../../../lib/commands/devclean/temp.mjs';
import { tempWorkspace } from '../../setup.mjs';
import { backdate, write } from '../../utils.mjs';

const { root: workspace, cleanup } = tempWorkspace('devclean-temp');

after(cleanup);

test('planTemp only selects entries with nothing newer than the cutoff', async () => {
  const temp = join(workspace, 'temp');

  write(join(temp, 'old.log'));
  backdate(join(temp, 'old.log'), 20);
  write(join(temp, 'new.log'));
  write(join(temp, 'mixed', 'old.txt'));
  backdate(join(temp, 'mixed', 'old.txt'), 20);
  write(join(temp, 'mixed', 'new.txt'));
  write(join(temp, 'old-dir', 'x.txt'));
  backdate(join(temp, 'old-dir', 'x.txt'), 20);
  backdate(join(temp, 'old-dir'), 20);

  const { items, keptCount } = await planTemp(temp, { tempDays: 7 });

  assert.deepEqual(items.map((item) => item.name).sort(), ['old-dir', 'old.log']);
  assert.equal(keptCount, 2);
});
