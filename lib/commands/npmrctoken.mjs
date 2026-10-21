// @ts-check
// lib/commands/npmrctoken.mjs - put a new registry token into the .npmrc of every git repo directly under the current
// folder: the repo's own .npmrc and the one of each package inside it. The rules: docs/safety-model.md.

import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  errorText, EXIT_OK, findPackageFiles, findReposHere, mapPool, parseArgs, planAndRun, SafetyError,
  skippedItem, TEXT_ENCODING, toPosix,
} from '../shared/index.mjs';

const NPMRC = '.npmrc';
const AUTH_TOKEN_KEY = '_authToken';
const OPTION_PREFIX = '-';

// A bare "_authToken=" line names no registry.
const DEFAULT_REGISTRY = '(default registry)';

// Spaces and tabs, never a line break.
const BLANKS = String.raw`[^\S\r\n]*`;

// One "<registry>:_authToken=<token>" setting per match; comment lines (# or ;) never match. The token
// stops before trailing spaces and the line break, so those stay as they are.
const TOKEN_LINE = new RegExp(
  String.raw`^(?<prefix>${BLANKS}(?<registry>[^\s#;=]*?):?${AUTH_TOKEN_KEY}${BLANKS}=${BLANKS})`
  + String.raw`(?<token>[^\r\n]*?)(?=${BLANKS}\r?$)`,
  'gm',
);
const VALID_TOKEN = /^\S+$/;

// Masking: "npm_AbCdEf123456XyZ9" -> "npm_************XyZ9". A fixed number of stars also hides the length.
const VISIBLE_EDGE_CHARS = 4;
const MASK_LENGTH = 12;
const MASK = '*'.repeat(MASK_LENGTH);

// A token of 12 characters or fewer is shown as stars only.
const MIN_REVEALED_LENGTH = 13;

const HELP = `Put a new token into the ${NPMRC} files of every git repo under the current folder.
In a terminal: the plan, then a list to pick from, then a typed "yes"; elsewhere only the plan.

  devkit token <token> [jobs] [--dry-run | --yes]

  token      the new value for the ${AUTH_TOKEN_KEY}= line
  jobs       files updated in parallel
  --dry-run  only print the plan
  --yes      take every file without the pick list and the confirmation; the only way without a terminal

Every ${NPMRC} in a repo folder or in a package folder inside it is updated when it has exactly one
${AUTH_TOKEN_KEY}= line. Files with more than one are listed as warnings and left unchanged.
Tokens are shown masked, e.g. npm_${MASK}XyZ9.
`;

/**
 * One _authToken setting found in a .npmrc.
 * @typedef {{ registry: string, token: string }} TokenLine
 */
/**
 * The edited content of a .npmrc, and the setting it changes.
 * @typedef {{ registry: string, oldToken: string, text: string }} TokenEdit
 */
/**
 * Why a .npmrc is left alone; `warning` marks the cases that need a person to look.
 * @typedef {{ skip: string, warning: boolean }} TokenSkip
 */

/**
 * Hide most of a token, keeping its first and last characters for a visual check.
 * @param {string} token  the full token
 * @returns {string} e.g. "npm_************XyZ9", or only stars for a short token
 */
export function maskToken(token) {
  if (token.length < MIN_REVEALED_LENGTH) {
    return MASK;
  }

  return `${token.slice(0, VISIBLE_EDGE_CHARS)}${MASK}${token.slice(-VISIBLE_EDGE_CHARS)}`;
}

/**
 * Every _authToken setting in a .npmrc's content.
 * @param {string} text  the file's content
 * @returns {TokenLine[]} the settings in file order
 */
export const findTokenLines = (text) => [...text.matchAll(TOKEN_LINE)].map(({ groups = {} }) => ({
  registry: groups.registry || DEFAULT_REGISTRY,
  token: groups.token,
}));

/**
 * Work out the edit for one .npmrc: replace the value of its only _authToken line with `token`.
 * @param {string} text  the file's content
 * @param {string} token  the new token
 * @returns {TokenEdit | TokenSkip} the new content, or why the file is left alone
 */
export function planEdit(text, token) {
  const found = findTokenLines(text);

  if (!found.length) {
    return { skip: `no ${AUTH_TOKEN_KEY} line`, warning: false };
  }

  if (found.length > 1) {
    return { skip: `WARNING: ${found.length} ${AUTH_TOKEN_KEY} lines found; update this file by hand`, warning: true };
  }

  const [{ registry, token: oldToken }] = found;

  if (oldToken === token) {
    return { skip: `already has this token (${maskToken(token)})`, warning: false };
  }

  return { registry, oldToken, text: text.replace(TOKEN_LINE, (_match, prefix) => `${prefix}${token}`) };
}

/**
 * Read a .npmrc and work out its edit. Links are left alone: one could point at the user-wide ~/.npmrc.
 * @param {string} file  path of the .npmrc
 * @param {string} token  the new token
 * @returns {Promise<TokenEdit | TokenSkip>} the edit, or why the file is left alone
 */
async function readAndPlan(file, token) {
  const info = await lstat(file);

  if (info.isSymbolicLink()) {
    return { skip: 'is a symlink (left alone)', warning: false };
  }

  if (!info.isFile()) {
    return { skip: 'is not a file', warning: false };
  }

  return planEdit(await readFile(file, TEXT_ENCODING), token);
}

/**
 * Plan the update of one .npmrc. The file is read again right before writing, because it can change
 * while the confirmation prompt is open; after writing, it is read back to confirm the new token is there.
 * @param {string} name  how the file is shown, e.g. "app/packages/ui/.npmrc"
 * @param {string} file  path of the file
 * @param {string} token  the new token
 * @returns {Promise<{ item: import('../shared/index.mjs').PlanItem, warning: boolean }>}
 *   the plan line, and whether it is a warning
 */
async function planFile(name, file, token) {
  const planned = await readAndPlan(file, token)
    .catch((err) => ({ skip: `cannot read (${errorText(err)})`, warning: false }));

  if ('skip' in planned) {
    return { item: skippedItem(name, planned.skip), warning: planned.warning };
  }

  /** @type {import('../shared/index.mjs').PlanItem} */
  const item = {
    name,
    detail: `${planned.registry}  ${maskToken(planned.oldToken)}  ->  ${maskToken(token)}`,
    skip: null,
    run: async () => {
      const edit = await readAndPlan(file, token);

      if ('skip' in edit) {
        return { ok: false, output: `${edit.skip} (re-checked before writing; left unchanged)` };
      }

      await writeFile(file, edit.text);

      const written = findTokenLines(await readFile(file, TEXT_ENCODING));

      if (written.length !== 1 || written[0].token !== token) {
        return { ok: false, output: 'the file does not hold the new token after writing' };
      }

      return { ok: true, output: '', summary: `now ${maskToken(token)}` };
    },
  };

  return { item, warning: false };
}

/**
 * Split the command line into the new token (always first) and the usual flags.
 * @param {string[]} argv  command-line arguments after the script name
 * @returns {{ token: string, options: import('../shared/index.mjs').BaseOptions }} the token ('' with --help)
 */
export function parseCommandLine(argv) {
  const [first = '', ...rest] = argv;

  if (!first || first.startsWith(OPTION_PREFIX)) {
    const options = parseArgs(argv, { defaults: {} });

    if (options.help) {
      return { token: '', options };
    }

    throw new SafetyError('The new token is missing: devkit token <token>. '
      + 'Nothing was changed.');
  }

  if (!VALID_TOKEN.test(first)) {
    throw new SafetyError('The token must not contain spaces or line breaks. Nothing was changed.');
  }

  return { token: first, options: parseArgs(rest, { defaults: {} }) };
}

/**
 * Plan, and after the person picks and confirms, write the new token into every .npmrc under the current folder.
 * @param {string[]} argv  command-line arguments after the script name
 * @param {import('../shared/index.mjs').RunContext} context  the folder, state folder, output and confirmation to use
 * @returns {Promise<number>} exit code
 */
export async function main(argv, context) {
  const { token, options } = parseCommandLine(argv);

  if (options.help) {
    context.print(HELP);

    return EXIT_OK;
  }

  const { root, repos } = await findReposHere(context);
  const { progress } = context;

  progress.start(`Finding ${NPMRC} files`, repos.length);

  const files = (await mapPool(repos, options.jobs, async (repo) => {
    const found = await findPackageFiles(repo.real, NPMRC);

    progress.advance();

    return found.map((file) => ({ name: `${repo.name}/${toPosix(path.relative(repo.real, file))}`, file }));
  })).flat();

  progress.start(`Reading ${NPMRC} files`, files.length);

  const planned = await mapPool(files, options.jobs, async ({ name, file }) => {
    const plan = await planFile(name, file, token);

    progress.advance();

    return plan;
  });
  const warnings = planned.filter((plan) => plan.warning).length;
  const section = {
    title: `${NPMRC} files in repos under ${root}`,
    items: planned.map((plan) => plan.item),
  };
  const { code } = await planAndRun({
    sections: [section],
    options,
    verb: 'update',
    command: 'token',

    // The hint must not repeat the token: it would end up in the output and the shell history twice.
    args: ['<token>', ...argv.slice(1)],
    context,
  });

  if (warnings) {
    context.print(`\n${warnings} warning(s): those files were left unchanged. See the WARNING lines above.`);
  }

  return code;
}
