// Plain Jest, no jest-expo preset (apps/api/CLAUDE.md). @swc/jest strips types
// without checking them; `pnpm typecheck` covers tests/ as well as src/.

/** @type {import('jest').Config} */
export default {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  // Expo stopped using Watchman for Metro in SDK 56. Keeping Jest off it too means every
  // machine crawls files the same way, with or without a working Watchman install.
  watchman: false,
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: { parser: { syntax: 'typescript' }, target: 'es2024' },
        module: { type: 'commonjs' },
      },
    ],
  },
};
