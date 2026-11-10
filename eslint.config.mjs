import js from '@eslint/js';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['coverage', 'data', 'node_modules']),
  {
    files: ['src/**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      complexity: ['error', 15],
      'max-depth': ['error', 3],
      'max-len': [
        'error',
        {
          code: 120,
          ignoreRegExpLiterals: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreUrls: true,
        },
      ],
      'max-params': ['error', 4],
    },
  },
]);
