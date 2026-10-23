// @ts-check
// lib/shared/picker.mjs - a list in the terminal to pick items from: with arrow keys where the terminal sends
// single keypresses, with typed numbers where it refuses to.

import readline from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { BOLD, DIM, GREEN, MAGENTA, RESET, accentColor } from './colors.mjs';
import { SafetyError } from './errors.mjs';

// Lines of the arrow list that are not items: the title, the key help, the count, and the line below.
const RESERVED_ROWS = 4;

const MIN_VISIBLE_ITEMS = 3;

// The highlighted item stays in the middle of the shown window while it can.
const HALF = 2;

// Used when the terminal does not report its size.
const DEFAULT_ROWS = 24;
const DEFAULT_COLUMNS = 80;

// Each key and what it does. That Enter with nothing selected takes the line under the cursor is in the
// README, so the line here stays short.
const KEY_HINTS = [['Up/Down', 'move'], ['Space', 'select'], ['a', 'select all'], ['Enter', 'take'], ['Esc', 'cancel']];
const HINT_INDENT = '  ';
const HINT_SEPARATOR = ' · ';
const POINTER = '>';
const SELECTED_MARK = '[x]';
const NUMBER_PART = /^(\d+)(?:-(\d+))?$/;
const NUMBER_SEPARATORS = /[\s,]+/;

/**
 * The arrow list: the highlighted item, the selected items, and how it ended (null while it is open).
 * @typedef {{ cursor: number, selected: Set<number>, done: 'accept' | 'cancel' | null }} PickState
 */

/** @typedef {{ name?: string, ctrl?: boolean }} Key  one keypress, as node:readline reports it */

/**
 * Apply one keypress to the arrow list. Up and Down wrap around; `a` selects all, or none when all are selected.
 * @param {PickState} state  the list before the keypress
 * @param {Key} key  the keypress
 * @param {number} count  items in the list
 * @returns {PickState} the list after the keypress
 */
export function pressKey(state, key, count) {
  const { cursor, selected } = state;

  if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
    return { ...state, done: 'cancel' };
  }

  // Enter with nothing selected takes the highlighted item.
  if (key.name === 'return' || key.name === 'enter') {
    return { ...state, selected: selected.size ? selected : new Set([cursor]), done: 'accept' };
  }

  if (key.name === 'up' || key.name === 'down') {
    const step = key.name === 'up' ? count - 1 : 1;

    return { ...state, cursor: (cursor + step) % count };
  }

  if (key.name === 'space') {
    const next = new Set(selected);

    if (!next.delete(cursor)) {
      next.add(cursor);
    }

    return { ...state, selected: next };
  }

  if (key.name === 'a') {
    const all = selected.size === count ? [] : [...Array(count).keys()];

    return { ...state, selected: new Set(all) };
  }

  return state;
}

/**
 * The key help line: whole hints only, as many as fit in the terminal width. With `colored`, the keys are bold
 * and the rest is dim.
 * @param {number} columns  the terminal width
 * @param {boolean} colored  whether the terminal shows colors
 * @returns {string} the line to print
 */
export function keyHelp(columns, colored) {
  /**
   * Color a part of the line where the terminal shows colors.
   * @param {string} color  the color code
   * @param {string} text  the part
   * @returns {string} the part as shown
   */
  const paint = (color, text) => (colored ? `${color}${text}${RESET}` : text);

  /** @type {string[]} */
  const hints = [];
  let width = HINT_INDENT.length;

  for (const [key, action] of KEY_HINTS) {
    const added = (hints.length ? HINT_SEPARATOR.length : 0) + key.length + 1 + action.length;

    if (width + added >= columns) {
      break;
    }

    width += added;
    hints.push(`${paint(BOLD, key)} ${paint(DIM, action)}`);
  }

  return HINT_INDENT + hints.join(paint(DIM, HINT_SEPARATOR));
}

/**
 * The lines of the arrow list. When the items don't fit in the terminal, only a window around the
 * highlighted item is shown, and every line is cut to the terminal width so none wraps. With `colored`,
 * the mark of a selected item is green and the pointer at the highlighted item has the accent color.
 * @param {PickState} state  the list
 * @param {string} title  the line above the items
 * @param {readonly string[]} labels  one text per item
 * @param {{ rows: number, columns: number, colored?: boolean, accent?: string }} terminal  its size, whether it
 *   shows colors, and the pointer's color
 * @returns {string[]} the lines to print
 */
export function renderList(state, title, labels, { rows, columns, colored = false, accent = MAGENTA }) {
  const visible = Math.max(rows - RESERVED_ROWS, MIN_VISIBLE_ITEMS);
  const first = Math.min(Math.max(state.cursor - Math.floor(visible / HALF), 0), Math.max(labels.length - visible, 0));

  /**
   * Cut a line to the terminal width.
   * @param {string} line  the full line
   * @returns {string} the line as shown
   */
  const cut = (line) => line.slice(0, columns - 1);

  const shown = labels.slice(first, first + visible).map((label, offset) => {
    const index = first + offset;
    const highlighted = index === state.cursor;
    const selected = state.selected.has(index);
    const line = cut(`${highlighted ? POINTER : ' '} ${selected ? SELECTED_MARK : '[ ]'} ${label}`);

    if (!colored) {
      return line;
    }

    // Colored after cutting, so the color codes never count against the width.
    const marked = selected ? line.replace(SELECTED_MARK, `${GREEN}${SELECTED_MARK}${RESET}`) : line;

    return highlighted ? `${accent}${POINTER}${RESET}${marked.slice(POINTER.length)}` : marked;
  });
  const hidden = labels.length > shown.length ? `, ${first + 1}-${first + shown.length} shown` : '';

  const count = cut(`  ${state.selected.size} of ${labels.length} selected${hidden}`);

  return [cut(title), keyHelp(columns, colored), ...shown, count];
}

/**
 * Read typed item numbers, such as "1,3,5-7".
 * @param {string} text  what was typed
 * @param {number} count  items in the list, numbered from 1
 * @returns {number[] | null} the picked items as indexes from 0 in list order (none for an empty
 *   text), or null when the text is not valid
 */
export function parseNumbers(text, count) {
  const picked = new Set();

  for (const part of text.split(NUMBER_SEPARATORS).filter(Boolean)) {
    const match = part.match(NUMBER_PART);

    if (!match) {
      return null;
    }

    const [, first, last = first] = match;
    const from = Number(first);
    const until = Number(last);

    if (from < 1 || until > count || from > until) {
      return null;
    }

    for (let number = from; number <= until; number += 1) {
      picked.add(number - 1);
    }
  }

  return [...picked].sort((left, right) => left - right);
}

/**
 * Pick with arrow keys and Space. The terminal must already be in raw mode; it is left in normal mode.
 * @param {string} title  the line above the items
 * @param {readonly string[]} labels  one text per item
 * @returns {Promise<number[]>} the picked indexes in list order; none when cancelled
 */
function pickWithKeys(title, labels) {
  const { stdin, stdout } = process;

  /** @type {PickState} */
  let state = { cursor: 0, selected: new Set(), done: null };
  let drawnLines = 0;

  const draw = () => {
    if (drawnLines) {
      readline.moveCursor(stdout, 0, -drawnLines);
      readline.clearScreenDown(stdout);
    }

    const terminal = {
      rows: stdout.rows || DEFAULT_ROWS,
      columns: stdout.columns || DEFAULT_COLUMNS,
      colored: stdout.hasColors(),
      accent: accentColor(stdout),
    };
    const lines = renderList(state, title, labels, terminal);

    stdout.write(`${lines.join('\n')}\n`);
    drawnLines = lines.length;
  };

  return new Promise((resolve) => {
    /**
     * Handle one keypress.
     * @param {string | undefined} _text  the typed character
     * @param {Key | undefined} key  the keypress
     */
    const onKeypress = (_text, key) => {
      state = pressKey(state, key ?? {}, labels.length);
      draw();

      if (!state.done) {
        return;
      }

      stdin.off('keypress', onKeypress);
      stdin.setRawMode(false);
      stdin.pause();
      resolve(state.done === 'accept' ? [...state.selected].sort((left, right) => left - right) : []);
    };

    readline.emitKeypressEvents(stdin);
    stdin.on('keypress', onKeypress);
    stdin.resume();
    draw();
  });
}

/**
 * Pick by typing item numbers; asks again until the numbers are valid.
 * @param {string} title  the line above the items
 * @param {readonly string[]} labels  one text per item
 * @returns {Promise<number[]>} the picked indexes in list order; none for an empty line
 */
async function pickWithNumbers(title, labels) {
  const width = String(labels.length).length;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });

  console.log([title, ...labels.map((label, index) => `  ${String(index + 1).padStart(width)}  ${label}`)].join('\n'));

  try {
    for (;;) {
      const answer = await prompt.question('Numbers to pick, e.g. 1,3,5-7 (empty: cancel): ');
      const picked = parseNumbers(answer, labels.length);

      if (picked) {
        return picked;
      }

      console.log(`Use numbers from 1 to ${labels.length}, separated by commas; a range is written 5-7.`);
    }
  } finally {
    prompt.close();
  }
}

/**
 * Let the person in the terminal pick items from a list. Uses arrow keys, or typed numbers when the
 * terminal refuses raw mode (single keypresses). Refuses when there is no interactive terminal.
 * @param {string} title  the line above the items
 * @param {readonly string[]} labels  one text per item
 * @returns {Promise<number[]>} the picked indexes in list order; none when cancelled
 */
export async function pickInTerminal(title, labels) {
  if (!process.stdin.isTTY) {
    throw new SafetyError('No interactive terminal to pick in: re-run with --yes to take every item. '
      + 'Nothing was changed.');
  }

  try {
    process.stdin.setRawMode(true);
  } catch {
    return pickWithNumbers(title, labels);
  }

  return pickWithKeys(title, labels);
}
