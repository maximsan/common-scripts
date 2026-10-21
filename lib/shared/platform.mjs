// @ts-check
// lib/shared/platform.mjs - the platform rules: every difference between operating systems, in one table.

import path from 'node:path';

const GIT_ENV_PREFIX = 'GIT_';

/**
 * How one operating system works, for every behaviour that differs between systems. See "platform rules"
 * in docs/GLOSSARY.md.
 *
 * PLATFORM_RULES below is the only place where devkit may depend on the operating system. Lint rejects
 * process.platform everywhere else. To change behaviour:
 * - support another system: add an entry to PLATFORM_RULES, keyed by its process.platform name, with every
 *   field below; systems without an entry get UNIX_RULES;
 * - change how one system behaves: edit the field in its entry;
 * - add a new difference between systems: add a field to this type, set it in every entry, and read it
 *   from the rules (HOST_RULES, or a `rules` argument). Name the field after the behaviour, never after a
 *   system: `treeKill: 'taskkill'`, not `isWindows`.
 *
 * Real runs always use HOST_RULES, the rules of the machine they run on. Functions that touch no disk also
 * take a `rules` argument, so tests can check another system's entry: the Windows rules are tested on
 * macOS and Linux this way, where the tests run.
 * @typedef {object} PlatformRules
 * @property {string} name
 *   The process.platform name, shown in messages.
 * @property {import('node:path').PlatformPath} paths
 *   The path syntax: drive letters and backslashes, or plain slashes.
 * @property {boolean} ignoreCase
 *   Paths that differ only in letter case name the same folder.
 * @property {string[]} networkPrefixes
 *   Starts of a network path. The scripts refuse to run on a network path.
 * @property {string[]} protectedEnvVars
 *   Environment variables naming folders the scripts must never run inside.
 * @property {string[]} protectedSystemFolders
 *   Absolute folders the scripts must never run inside.
 * @property {string[]} protectedHomeFolders
 *   Folders inside the home folder the scripts must never run inside.
 * @property {(home: string) => string[]} tempHomes
 *   Where the user temp folder may be; subfolders count. devclean deletes old temp entries there.
 * @property {boolean} onlyAbsolutePath
 *   Child processes get a PATH with only absolute folders, so an empty entry or "." can't make them run
 *   an npm or yarn planted in the current folder.
 * @property {'taskkill' | 'ps'} treeKill
 *   How to end a child and everything it started: taskkill, or a ps listing plus kill.
 * @property {boolean} fileOwners
 *   Files have an owning user id, so a shared temp folder can hold other users' entries.
 * @property {boolean} readOnlyBlocksDelete
 *   A read-only file can't be deleted until the attribute is cleared. Elsewhere the parent folder's
 *   permissions decide, and changing the file's mode would only widen access to every hard link of it.
 */

/** @type {Omit<PlatformRules, 'name' | 'tempHomes'>} */
const UNIX_BASE = {
  paths: path.posix,
  ignoreCase: false,
  networkPrefixes: ['//'],
  protectedEnvVars: [],

  // /var is left out on purpose: macOS keeps each user's temp folder under it.
  protectedSystemFolders: [
    '/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/opt', '/proc', '/run', '/sbin', '/sys', '/usr',
    '/Applications', '/Library', '/System',
  ],

  protectedHomeFolders: ['Library', '.cache', '.config', '.local'],
  onlyAbsolutePath: true,
  treeKill: 'ps',
  fileOwners: true,
  readOnlyBlocksDelete: false,
};

/** Rules for a system without its own entry: Unix behaviour, and no known temp folder. */
const UNIX_RULES = { ...UNIX_BASE, name: 'unix', tempHomes: () => [] };

/** @type {Readonly<Record<string, PlatformRules>>} */
const PLATFORM_RULES = Object.freeze({
  win32: {
    name: 'win32',
    paths: path.win32,
    ignoreCase: true,
    networkPrefixes: ['\\\\', '//'],
    protectedEnvVars: ['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'APPDATA', 'LOCALAPPDATA'],
    protectedSystemFolders: [],
    protectedHomeFolders: [],
    tempHomes: (home) => [path.win32.join(home, 'AppData', 'Local', 'Temp')],

    // `cmd.exe` is told not to search the current folder instead.
    onlyAbsolutePath: false,

    treeKill: 'taskkill',
    fileOwners: false,
    readOnlyBlocksDelete: true,
  },
  darwin: { ...UNIX_BASE, name: 'darwin', tempHomes: () => ['/private/var/folders', '/private/tmp'] },
  linux: { ...UNIX_BASE, name: 'linux', tempHomes: () => ['/tmp', '/var/tmp'] },
});

/**
 * The rules of one operating system.
 * @param {string} platform  a process.platform name, e.g. "win32"
 * @returns {PlatformRules} its entry in PLATFORM_RULES, or the Unix rules under its name
 */
export const platformRules = (platform) => PLATFORM_RULES[platform] ?? { ...UNIX_RULES, name: platform };

// The one place that reads the operating system; everything else uses these rules.
// eslint-disable-next-line no-restricted-syntax
export const HOST_RULES = platformRules(process.platform);

/**
 * The environment for a child process: no GIT_DIR / GIT_INDEX_FILE / ... overrides from the parent shell,
 * no credential prompts, and no npm or yarn planted in the current folder (cmd.exe is told not to search
 * it; with onlyAbsolutePath, PATH keeps only absolute folders).
 * @param {NodeJS.ProcessEnv} env  the parent's environment
 * @param {PlatformRules} [rules]  the system's rules
 * @returns {NodeJS.ProcessEnv} the child's environment
 */
export function childEnv(env, rules = HOST_RULES) {
  const kept = Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith(GIT_ENV_PREFIX));

  /** @type {NodeJS.ProcessEnv} */
  const result = { ...Object.fromEntries(kept), GIT_TERMINAL_PROMPT: '0', NoDefaultCurrentDirectoryInExePath: '1' };

  if (rules.onlyAbsolutePath) {
    const { delimiter, isAbsolute } = rules.paths;

    result.PATH = (env.PATH ?? '').split(delimiter).filter((dir) => isAbsolute(dir)).join(delimiter);
  }

  return result;
}
