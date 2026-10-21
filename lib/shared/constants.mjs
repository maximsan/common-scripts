// @ts-check
// lib/shared/constants.mjs - names and numbers shared by the core and the scripts.

export const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_JOBS = 4;
export const NODE_MODULES = 'node_modules';
export const PACKAGE_JSON = 'package.json';
export const GIT_FOLDER = '.git';
export const YARN_BERRY_MAJOR = 2; // Yarn 2+ ("Berry") behaves differently from Yarn 1 ("Classic")
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_REFUSED = 2;

export const TEXT_ENCODING = 'utf8';
export const LINE_BREAK = /\r?\n/;
export const NUL = '\0';

// A folder being deleted is first renamed to "<name>.devkit-deleting-<Date.now()>".
export const TRASH_TAG = '.devkit-deleting-';
