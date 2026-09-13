// apps/api/eslint.config.mjs
//
// MomentLens — API lint config (Express 5, TypeScript, Node 24 as pinned in .nvmrc).
// Type-checked via typescript-eslint + projectService, so this needs a real
// tsconfig.json in apps/api to run against.
//
// Install (shared across all three TS workspaces — root of the pnpm
// workspace, so mobile and shared-types pick up the same versions):
//   pnpm add -D -w eslint @eslint/js typescript-eslint eslint-config-prettier globals
//
// The no-restricted-imports block is the one rule here that isn't generic
// Node/TS hygiene — it's CLAUDE.md invariant 5 and Handbook §16 turned into
// something that actually fails a PR instead of relying on someone
// remembering it under deadline pressure:
//
//   "Media bytes never pass through Express. No compositing, resizing, or
//   format inspection in a route handler, under any deadline."
//
// Image and face processing lives in worker/ behind pgmq. D-57 removed the
// one endpoint that used to violate this (a crop-and-paste composite in a
// request handler); if one of these packages shows up in apps/api again,
// that's the same mistake with a new name.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier/flat';
import globals from 'globals';

const IMAGE_PROCESSING_MSG =
  'Image/format work belongs in worker/, never in an Express route handler (CLAUDE.md invariant 5, Handbook §16, D-57).';
const EXIF_MSG =
  'EXIF handling happens client-side or in worker/, never in apps/api (Handbook §7).';

const BANNED_IMAGE_IMPORTS = [
  { name: 'sharp', message: IMAGE_PROCESSING_MSG },
  { name: 'jimp', message: IMAGE_PROCESSING_MSG },
  { name: 'canvas', message: IMAGE_PROCESSING_MSG },
  { name: 'gm', message: IMAGE_PROCESSING_MSG },
  { name: 'lwip', message: IMAGE_PROCESSING_MSG },
  { name: 'imagemagick', message: IMAGE_PROCESSING_MSG },
  { name: '@squoosh/lib', message: IMAGE_PROCESSING_MSG },
  { name: 'heic-convert', message: IMAGE_PROCESSING_MSG },
  { name: 'image-size', message: IMAGE_PROCESSING_MSG }, // format inspection is banned too
  { name: 'file-type', message: IMAGE_PROCESSING_MSG },
  { name: 'probe-image-size', message: IMAGE_PROCESSING_MSG },
  { name: 'exifr', message: EXIF_MSG },
  { name: 'exif-parser', message: EXIF_MSG },
];

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },

  js.configs.recommended,

  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-restricted-imports': ['error', { paths: BANNED_IMAGE_IMPORTS }],

      // Handbook §17: pino is the logger for this service.
      'no-console': 'error',

      // Express 5 handles rejected async middleware natively, which makes
      // it easy to write a handler that never resolves or rejects loudly —
      // it just hangs. Catch that at lint time, not during the demo.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  prettierConfig,
);
