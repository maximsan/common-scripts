// @ts-check
// lib/shared/format.mjs - text for the output: sizes, ages and indented details.

import { DAY_MS } from './constants.mjs';

// DETAIL_INDENT and LINE_STARTS: keep in sync with gpall.mjs.
const DETAIL_INDENT = '    ';
const LINE_STARTS = /^/gm;

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
const BYTES_PER_UNIT = 1024;

/**
 * Human-readable size, e.g. 1536 -> "1.5 KB".
 * @param {number | null | undefined} bytes  size, or nothing when unknown
 * @returns {string} the size with a unit, or an empty string when unknown
 */
export function formatBytes(bytes) {
  if (bytes == null) {
    return '';
  }

  let value = bytes;
  let unit = 0;

  while (value >= BYTES_PER_UNIT && unit < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unit += 1;
  }

  return `${value.toFixed(unit ? 1 : 0)} ${BYTE_UNITS[unit]}`;
}

/**
 * Whole days between `mtimeMs` and `now`. A time after `now` (a change after planning, or a clock
 * ahead) counts as 0 days.
 * @param {number} mtimeMs  an earlier time
 * @param {number} now  the later time
 * @returns {number} full days in between
 */
export const ageInDays = (mtimeMs, now) => Math.max(0, Math.floor((now - mtimeMs) / DAY_MS));

/**
 * Indent every line of a text, for failure details under a heading.
 * @param {string} text  possibly multi-line text
 * @returns {string} the indented text
 */
export const indent = (text) => text.replace(LINE_STARTS, DETAIL_INDENT);

/**
 * Upper-case the first letter.
 * @param {string} word  e.g. "delete"
 * @returns {string} e.g. "Delete"
 */
export const capitalize = (word) => word.charAt(0).toUpperCase() + word.slice(1);
