// packages/shared-types/eslint.config.mjs
//
// MomentLens — shared-types lint config.
//
// CLAUDE.md's layout table calls this package "the app↔API contract (TS
// only)". It's linted a notch stricter than apps/mobile and apps/api for
// that reason: no-explicit-any is an error here, not a warning, because a
// stray `any` in a zod-inferred type quietly defeats the point of having a
// shared contract in the first place — both sides keep compiling, and the
// mismatch only shows up at runtime.
//
// Install: this package uses the same root devDependencies as apps/api —
//   pnpm add -D -w eslint @eslint/js typescript-eslint eslint-config-prettier

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier/flat';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },

  js.configs.recommended,

  {
    files: ['**/*.ts'],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-exports': 'error',
    },
  },

  prettierConfig,
);
