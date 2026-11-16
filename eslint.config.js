// ESLint flat config: `npm run lint` (CI-friendly, no formatting rules).
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'instance/', 'instance_example/', 'coverage/'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
    },
  },
  {
    // Browser UI: no build step, runs in the page.
    files: ['src/web/public/**/*.js'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Playwright page.evaluate / addInitScript callbacks run in the browser.
    files: ['src/core/browser/**/*.js', 'src/platforms/twitter/**/*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
