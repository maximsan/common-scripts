// @ts-check
// lib/shared/colors.mjs - the ANSI color codes of the progress line, the pick list and the result lines.
// Each is closed by RESET.

export const YELLOW = '\u001B[33m';
export const GREEN = '\u001B[32m';
export const RED = '\u001B[31m';
export const BOLD = '\u001B[1m';
export const DIM = '\u001B[2m';

// Pink from the 256-color palette; terminals with 16 colors get their magenta instead.
export const PINK = '\u001B[1;38;5;205m';
export const MAGENTA = '\u001B[1;35m';

export const RESET = '\u001B[0m';

/**
 * How a status word is colored: green for done, red for failed, dim for left alone.
 * @typedef {'ok' | 'fail' | 'quiet'} Tone
 */

const TONE_COLORS = Object.freeze({ ok: GREEN, fail: RED, quiet: DIM });

/**
 * A function that colors a status word, or returns it unchanged where the output shows no colors.
 * @param {boolean} colored  whether the output shows colors
 * @returns {(tone: Tone, text: string) => string} the text, colored by its tone or unchanged
 */
export function painter(colored) {
  return (tone, text) => (colored ? `${TONE_COLORS[tone]}${text}${RESET}` : text);
}
