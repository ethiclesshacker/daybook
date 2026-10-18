import js from '@eslint/js';
import globals from 'globals';

// Browser code lives in src/, Node jobs in ledger/ and scripts/; some src/ledger
// modules are shared by both, so src/ gets both global sets.
export default [
  { ignores: ['dist/', 'node_modules/', '.claude/', '.wrangler/', 'supabase/functions/**/*.ts'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      // Destructuring a key out to drop it ({ re, ...rest }) is the idiom here.
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Escaped slashes in regex literals are harmless and common in the email parsers.
      'no-useless-escape': 'off',
      // NBSP and control characters in regexes are deliberate: they strip them from mail text.
      'no-irregular-whitespace': ['error', { skipRegExps: true, skipStrings: true, skipTemplates: true }],
      'no-control-regex': 'off',
    },
  },
  { files: ['src/**/*.js'], languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  {
    files: ['ledger/**/*.js', 'scripts/**/*.{js,mjs}', 'test/**/*.js', '*.config.js', 'supabase/**/*.js'],
    languageOptions: { globals: globals.node },
  },
];
