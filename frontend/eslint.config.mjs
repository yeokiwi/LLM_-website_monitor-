/**
 * Lint rules for the frontend.
 *
 * The rule that earns its keep here is `no-undef`. A call to an identifier that
 * no longer exists is valid JavaScript until it runs, so Vite builds it happily
 * and it only fails in the browser — where an uncaught throw during render
 * blanks the entire page. That is exactly how a deleted `engineAllowed()` call
 * left behind in a table header shipped to production.
 */

import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: { react: { version: 'detect' } },
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      // The one that matters: catches a reference to something that was deleted.
      'no-undef': 'error',

      // JSX counts as using a component, so React sees these identifiers.
      'react/jsx-uses-react': 'error',
      'react/jsx-uses-vars': 'error',
      'react/jsx-no-undef': 'error',

      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // A warning, not an error: leftovers from a deletion are worth surfacing
      // but should not block a deploy on their own.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
