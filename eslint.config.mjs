// @ts-check
// eslint.config.mjs - lint and formatting rules for the scripts. `npm run lint` checks, `npm run format` fixes.

import eslintJs from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';

const INDENT_SPACES = 2;
const MAX_LINE_LENGTH = 120;
const MIN_NAME_LENGTH = 3;

// Names that are short for something; spell out what they hold instead.
const UNCLEAR_NAMES = [
  'arr', 'buf', 'cb', 'cfg', 'ctx', 'fn', 'idx', 'num', 'obj', 'opts', 'rel', 'res', 'ret', 'str', 'tmp', 'val',
];

// Numbers and regexes live in named module-level constants. ESLint's no-magic-numbers can't express
// this: it also flags the parts of a constant such as `2 * 60 * 1000`. So the rule is "no number
// other than 0 or 1, and no regex, inside a function".
const NO_INLINE_VALUES = [
  {
    selector: ':function Literal[regex]',
    message: 'Move this regex to a named constant at the top of the file.',
  },
  {
    selector: String.raw`:function Literal[raw=/^(?![01]$)\d/]`,
    message: 'Move this number to a named constant at the top of the file.',
  },
];

// Blank lines separate the logical parts of a function: declarations, blocks, and the final return.
const PADDING_LINES = [
  { blankLine: 'always', prev: ['const', 'let'], next: '*' },
  { blankLine: 'always', prev: '*', next: ['const', 'let'] },
  { blankLine: 'any', prev: ['const', 'let'], next: ['const', 'let'] },
  { blankLine: 'always', prev: '*', next: ['block-like', 'return', 'throw'] },
  { blankLine: 'always', prev: 'block-like', next: '*' },
  { blankLine: 'always', prev: 'import', next: '*' },
  { blankLine: 'any', prev: 'import', next: 'import' },
];

export default [
  eslintJs.configs.recommended,
  jsdoc.configs['flat/recommended-typescript-flavor-error'],
  stylistic.configs.customize({
    indent: INDENT_SPACES,
    quotes: 'single',
    semi: true,
    jsx: false,
    arrowParens: true,
    braceStyle: '1tbs',
    commaDangle: 'always-multiline',
    quoteProps: 'as-needed',
  }),
  {
    languageOptions: { globals: globals.node },
    settings: { jsdoc: { mode: 'typescript' } },
    rules: {
      // Every body in braces, and a brace body never on one line: `return` always starts its own line.
      curly: ['error', 'all'],
      '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: false }],
      '@stylistic/max-statements-per-line': ['error', { max: 1 }],
      '@stylistic/max-len': ['error', { code: MAX_LINE_LENGTH, ignoreUrls: true }],
      '@stylistic/padding-line-between-statements': ['error', ...PADDING_LINES],

      'id-length': ['error', { min: MIN_NAME_LENGTH, properties: 'never' }],
      'id-denylist': ['error', ...UNCLEAR_NAMES],
      'no-restricted-syntax': ['error', ...NO_INLINE_VALUES],

      // Every named function has a doc comment: declarations and functions stored in a constant.
      // Inline callbacks are described by the code around them.
      'jsdoc/require-jsdoc': ['error', {
        require: { FunctionDeclaration: true },
        contexts: ['VariableDeclarator > ArrowFunctionExpression', 'VariableDeclarator > FunctionExpression'],
      }],
      'jsdoc/require-description': 'error',
      // Types are checked by `npm run typecheck`, which knows Node's types; this rule doesn't.
      'jsdoc/no-undefined-types': 'off',
    },
  },
  {
    // Tests keep fixture values and expected-output patterns inline, where they read best.
    files: ['**/*.test.mjs'],
    rules: { 'no-restricted-syntax': 'off' },
  },
];
