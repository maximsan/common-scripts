// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOLD, DIM, GREEN, PINK, RESET } from '../../lib/shared/colors.mjs';
import { keyHelp, parseNumbers, pressKey, renderList } from '../../lib/shared/picker.mjs';

/** @type {import('../../lib/shared/picker.mjs').PickState} */
const START = { cursor: 0, selected: new Set(), done: null };

/**
 * Apply keypresses one after another.
 * @param {string[]} names  key names, e.g. ["down", "space"]
 * @param {number} count  items in the list
 * @returns {import('../../lib/shared/picker.mjs').PickState} the list after the last keypress
 */
const press = (names, count) => names.reduce((state, name) => pressKey(state, { name }, count), START);

test('arrow keys move and wrap around; Space selects and unselects; a selects all, then none', () => {
  assert.equal(press(['up'], 3).cursor, 2);
  assert.equal(press(['down', 'down', 'down'], 3).cursor, 0);
  assert.deepEqual([...press(['down', 'space'], 3).selected], [1]);
  assert.deepEqual([...press(['space', 'space'], 3).selected], []);
  assert.deepEqual([...press(['a'], 3).selected], [0, 1, 2]);
  assert.deepEqual([...press(['a', 'a'], 3).selected], []);
  assert.equal(press(['x'], 3), START);
});

test('Enter accepts, and takes the highlighted item when none is selected; Esc and Ctrl+C cancel', () => {
  assert.equal(press(['return'], 3).done, 'accept');
  assert.deepEqual([...press(['down', 'return'], 3).selected], [1]);
  assert.deepEqual([...press(['space', 'down', 'return'], 3).selected], [0]);
  assert.equal(press(['escape'], 3).done, 'cancel');
  assert.equal(pressKey(START, { name: 'c', ctrl: true }, 3).done, 'cancel');
});

test('a long list shows a window around the highlighted item, cut to the terminal width', () => {
  const labels = [...Array(20).keys()].map((index) => `repo-${index + 1}`);
  const state = { ...START, cursor: 10, selected: new Set([10]) };
  const lines = renderList(state, 'Pick:', labels, { rows: 9, columns: 40 });

  assert.equal(lines.length, 8);
  assert.equal(lines[0], 'Pick:');
  assert.ok(lines.includes('> [x] repo-11'), lines.join('\n'));
  assert.equal(lines.at(-1), '  1 of 20 selected, 9-13 shown');
  assert.ok(lines.every((line) => line.length < 40));
});

test('in color, and only there, the pointer has the accent color and a selected mark is green', () => {
  const state = { ...START, selected: new Set([0, 1]) };
  const terminal = { rows: 24, columns: 80, colored: true, accent: PINK };
  const [, , highlighted, selected] = renderList(state, 'Pick:', ['app', 'lib'], terminal);

  assert.equal(highlighted, `${PINK}>${RESET} ${GREEN}[x]${RESET} app`);
  assert.equal(selected, `  ${GREEN}[x]${RESET} lib`);
  assert.equal(renderList(state, 'Pick:', ['app', 'lib'], { rows: 24, columns: 80 })[2], '> [x] app');
});

test('the key help shows whole hints that fit the width; in color the keys are bold and the rest dim', () => {
  assert.equal(keyHelp(80, false), '  Up/Down move · Space select · a select all · Enter take · Esc cancel');
  assert.equal(keyHelp(40, false), '  Up/Down move · Space select');
  assert.ok(keyHelp(80, true).startsWith(`  ${BOLD}Up/Down${RESET} ${DIM}move${RESET}${DIM} · ${RESET}${BOLD}Space`));
});

test('typed numbers: lists and ranges, an empty line picks none, anything else is invalid', () => {
  assert.deepEqual(parseNumbers('1, 3 5-7', 8), [0, 2, 4, 5, 6]);
  assert.deepEqual(parseNumbers('2,2,1-2', 3), [0, 1]);
  assert.deepEqual(parseNumbers('  ', 3), []);

  for (const bad of ['0', '4', '3-2', 'a', '1-', '-1']) {
    assert.equal(parseNumbers(bad, 3), null, bad);
  }
});
