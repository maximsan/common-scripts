// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProgress, formatElapsed, statusParts } from '../../lib/shared/progress.mjs';

/**
 * A fake terminal or pipe that records what is written to it.
 * @param {{ isTTY: boolean, colors?: boolean, columns?: number }} options  what kind of stream it is
 * @returns {{ stream: import('../../lib/shared/progress.mjs').StatusStream, written: string[] }}
 *   the stream, and everything written to it
 */
function fakeStream({ isTTY, colors = false, columns = 80 }) {
  /** @type {string[]} */
  const written = [];

  return {
    stream: { isTTY, columns, hasColors: () => colors, write: (text) => written.push(text) },
    written,
  };
}

test('elapsed time and status text', () => {
  assert.equal(formatElapsed(7400), '7s');
  assert.equal(formatElapsed(125000), '2m 05s');
  assert.deepEqual(statusParts({ label: 'Delete', done: 3, total: 40, elapsedMs: 7000 }), {
    what: 'Delete: 3 of 40',
    time: '(7s)',
  });
  assert.equal(statusParts({ label: 'Finding repos', done: 0, total: 0, elapsedMs: 0 }).what, 'Finding repos');
});

test('in a terminal: the line is redrawn in place, output goes above it, and stop erases it', () => {
  const { stream, written } = fakeStream({ isTTY: true });

  /** @type {string[]} */
  const output = [];
  const progress = createProgress({ stream, write: (line) => output.push(line), frames: ['*'], now: () => 0 });

  progress.start('Delete', 2);
  progress.advance();
  assert.equal(written.at(-1), '\r\u001B[K* Delete: 1 of 2 (0s)');

  progress.print('ok    app/node_modules');
  assert.deepEqual(output, ['ok    app/node_modules']);
  assert.deepEqual(written.slice(-2), ['\r\u001B[K', '\r\u001B[K* Delete: 1 of 2 (0s)']);

  progress.stop();
  assert.equal(written.at(-1), '\r\u001B[K');
});

test('colors only where the terminal shows them; a narrow terminal cuts the label, never the time', () => {
  const colored = fakeStream({ isTTY: true, colors: true });

  createProgress({ stream: colored.stream, write: () => {}, frames: ['*'], now: () => 0 }).start('Checking repos', 3);
  assert.equal(
    colored.written.at(-1),
    '\r\u001B[K\u001B[33m*\u001B[0m \u001B[1;38;5;205mChecking\u001B[0m'
    + '\u001B[1m repos: 0 of 3\u001B[0m \u001B[2m(0s)\u001B[0m',
  );

  const narrow = fakeStream({ isTTY: true, columns: 16 });
  const progress = createProgress({ stream: narrow.stream, write: () => {}, frames: ['*'], now: () => 0 });

  progress.start('Checking node_modules', 40);
  assert.equal(narrow.written.at(-1), '\r\u001B[K* Checking (0s)');
  progress.stop();
});

test('in a pipe: nothing is redrawn, and output lines are written unchanged', () => {
  const { stream, written } = fakeStream({ isTTY: false, colors: true });

  /** @type {string[]} */
  const output = [];
  const progress = createProgress({ stream, write: (line) => output.push(line), now: () => 0 });

  progress.start('Delete', 2);
  progress.advance();
  progress.print('ok    app/node_modules');
  progress.stop();
  assert.deepEqual(written, []);
  assert.deepEqual(output, ['ok    app/node_modules']);
});
