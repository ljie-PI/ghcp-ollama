import globals from 'globals';
import js from '@eslint/js';

export default [
  {
    files: ['src/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2021
      }
    },
    rules: {
      'no-console': 'off',
      'comma-dangle': ['error', 'only-multiline'],
      'indent': ['error', 2],
      'linebreak-style': ['error', 'unix'],
      'quotes': ['error', 'double'],
      'semi': ['error', 'always'],
      'no-unused-vars': ['error', { 'argsIgnorePattern': '^_' }],
      'prefer-const': 'error',
      'no-var': 'error'
    }
  },
  js.configs.recommended,
  {
    ignores: [
      'node_modules/',
      'copilot/',
      'dist/',
      '*.md'
    ]
  }
];
