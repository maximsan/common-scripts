// @ts-check
// lib/shared/colors.mjs - the ANSI color codes of the progress line and the pick list. Each is closed by RESET.

export const YELLOW = '\u001B[33m';
export const GREEN = '\u001B[32m';
export const BOLD = '\u001B[1m';
export const DIM = '\u001B[2m';

// Pink from the 256-color palette; terminals with 16 colors get their magenta instead.
export const PINK = '\u001B[1;38;5;205m';
export const MAGENTA = '\u001B[1;35m';

export const RESET = '\u001B[0m';
