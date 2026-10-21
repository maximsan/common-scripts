// @ts-check
// lib/shared/progress.mjs - one status line while work goes on: redrawn in place, in color where the terminal
// shows colors; a plain line every few seconds where it can't redraw (a pipe, a log file, CI output).

import { BOLD, DIM, MAGENTA, PINK, RESET, YELLOW } from './colors.mjs';
import { HOST_RULES } from './platform.mjs';

const FRAME_MS = 120;
const PLAIN_LINE_EVERY_MS = 5000;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_WIDTH = 2;
const DEFAULT_COLUMNS = 80;

// Carriage return, then erase to the end of the line: the next text replaces the status line.
const CLEAR_LINE = '\r\u001B[K';

// Colors: yellow symbol, pink action word, bold rest of the label, dim time. Pink needs this many colors.
const PALETTE_COLORS = 256;

/**
 * Where the status line goes: a terminal, or a pipe or file without isTTY.
 * @typedef {{
 *   write: (text: string) => unknown, isTTY?: boolean, columns?: number, hasColors?: (count?: number) => boolean,
 * }} StatusStream
 */

/** @typedef {{ label: string, done: number, total: number, started: number }} Task  what the status line shows */

/**
 * The status line of a run context (see docs/GLOSSARY.md). `start` begins a task and replaces the one
 * before; `total` 0 means the count is unknown. `print` writes a line of output above the status line.
 * @typedef {{
 *   start: (label: string, total?: number) => void,
 *   advance: () => void,
 *   stop: () => void,
 *   print: (line?: string) => void,
 * }} Progress
 */

/**
 * Elapsed time for the status line.
 * @param {number} elapsedMs  milliseconds
 * @returns {string} e.g. "7s" or "2m 05s"
 */
export function formatElapsed(elapsedMs) {
  const seconds = Math.floor(elapsedMs / MS_PER_SECOND);

  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds}s`;
  }

  const rest = String(seconds % SECONDS_PER_MINUTE).padStart(SECONDS_WIDTH, '0');

  return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m ${rest}s`;
}

/**
 * The two parts of the status text, without symbol or colors.
 * @param {{ label: string, done: number, total: number, elapsedMs: number }} task  the task and its time so far
 * @returns {{ what: string, time: string }} e.g. "Checking node_modules: 12 of 40" and "(7s)"
 */
export function statusParts({ label, done, total, elapsedMs }) {
  return { what: total ? `${label}: ${done} of ${total}` : label, time: `(${formatElapsed(elapsedMs)})` };
}

/**
 * A status line on `stream`, normally stderr, so a plan sent to a file or pipe gets none of it.
 * @param {{
 *   stream: StatusStream, write: (line: string) => void, frames?: string[], now?: () => number,
 * }} options  where the status line goes; where output lines go; the symbols it cycles through; the clock
 * @returns {Progress} the status line
 */
export function createProgress({ stream, write, frames = HOST_RULES.spinnerFrames, now = Date.now }) {
  const redraws = Boolean(stream.isTTY);
  const colored = redraws && Boolean(stream.hasColors?.());
  const pink = stream.hasColors?.(PALETTE_COLORS) ? PINK : MAGENTA;

  /** @type {Task | null} */
  let task = null;

  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  let frame = 0;
  let shown = false;

  /**
   * The status text of a running task.
   * @param {Task} current  the task
   * @returns {{ what: string, time: string }} its parts
   */
  const partsOf = (current) => statusParts({ ...current, elapsedMs: now() - current.started });

  /**
   * Wrap text in a color when the terminal shows colors.
   * @param {string} color  an ANSI color code
   * @param {string} text  the text
   * @returns {string} the text, colored or unchanged
   */
  const paint = (color, text) => (colored ? `${color}${text}${RESET}` : text);

  const hide = () => {
    if (shown) {
      stream.write(CLEAR_LINE);
      shown = false;
    }
  };

  const draw = () => {
    if (!task || !redraws) {
      return;
    }

    const symbol = frames[frame % frames.length];
    const { what, time } = partsOf(task);

    // Only the label is cut, so the line never wraps. The last column stays free: writing into it wraps
    // the line in some terminals.
    const room = Math.max((stream.columns || DEFAULT_COLUMNS) - 1 - `${symbol}  ${time}`.length, 0);
    const label = what.slice(0, room);
    const wordEnd = label.includes(' ') ? label.indexOf(' ') : label.length;
    const word = paint(pink, label.slice(0, wordEnd));
    const rest = label.slice(wordEnd) && paint(BOLD, label.slice(wordEnd));
    const line = `${paint(YELLOW, symbol)} ${word}${rest} ${paint(DIM, time)}`;

    stream.write(`${CLEAR_LINE}${line}`);
    shown = true;
  };

  const tick = () => {
    frame += 1;

    if (redraws) {
      draw();
    } else if (task) {
      const { what, time } = partsOf(task);

      stream.write(`${what} ${time}\n`);
    }
  };

  /** @type {Progress} */
  const progress = {
    start: (label, total = 0) => {
      progress.stop();
      task = { label, done: 0, total, started: now() };
      timer = setInterval(tick, redraws ? FRAME_MS : PLAIN_LINE_EVERY_MS);
      timer.unref();
      draw();
    },
    advance: () => {
      if (task) {
        task.done += 1;
        draw();
      }
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
      }

      timer = null;
      task = null;
      hide();
    },
    print: (line = '') => {
      hide();
      write(line);
      draw();
    },
  };

  return progress;
}
