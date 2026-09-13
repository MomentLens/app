// apps/mobile/eslint.config.js
//
// MomentLens — mobile app lint config.
// Base: eslint-config-expo/flat (Expo SDK 56+, RN 0.85+, New Architecture only).
//
// eslint-config-expo is a devDependency of this package. eslint and
// eslint-config-prettier come from the workspace root, shared with apps/api
// and packages/shared-types.
//
// The custom rules below aren't generic TS hygiene — they encode specific
// rules from the root CLAUDE.md and Engineering Handbook §16 that are easy
// for a person (or an agent) to reach past out of habit under deadline
// pressure:
//   - FlatList/SectionList are banned. "The album grid must use FlashList
//     v2, never FlatList" — an album can hit the 2,000-photo cap in spec
//     §4.17, and FlatList's virtualization isn't close at that scale.
//   - @react-native-async-storage/async-storage is banned outright.
//     CLAUDE.md's "Model traps" section: "No AsyncStorage patterns." This
//     stack uses expo-sqlite for structured data and react-native-mmkv for
//     key-value state.
//   - The RN-core Animated API is discouraged (warn, not error) in favor of
//     react-native-reanimated worklets, so gesture/animation work keeps
//     running on the UI thread while the JS thread is busy (Handbook §16).

const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const prettierConfig = require('eslint-config-prettier/flat');

const RESTRICTED_IMPORT_MESSAGES = {
  flatList:
    "Use @shopify/flash-list (FlashList v2) instead — Handbook §16. FlatList's virtualization does not hold up at the 2,000-photo album cap (spec §4.17).",
  asyncStorage:
    'No AsyncStorage patterns in this stack (CLAUDE.md, "Model traps"). Use expo-sqlite for structured/queued data or react-native-mmkv for key-value state.',
};

module.exports = defineConfig([
  {
    ignores: ['dist/*', '.expo/*', 'android/*', 'ios/*'],
  },

  expoConfig,

  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react-native',
              importNames: ['FlatList', 'SectionList'],
              message: RESTRICTED_IMPORT_MESSAGES.flatList,
            },
            {
              name: '@react-native-async-storage/async-storage',
              message: RESTRICTED_IMPORT_MESSAGES.asyncStorage,
            },
          ],
        },
      ],

      'no-restricted-syntax': [
        'warn',
        {
          selector:
            "ImportDeclaration[source.value='react-native'] > ImportSpecifier[imported.name='Animated']",
          message:
            'Prefer react-native-reanimated worklets over the JS-driven Animated API (Handbook §16) so animations keep running while the JS thread is briefly busy.',
        },
      ],
    },
  },

  {
    // eslint-config-expo registers the @typescript-eslint plugin for TypeScript files
    // only. Any rule from it in a block that also matches .js files crashes ESLint.
    files: ['**/*.{ts,tsx}'],
    rules: {
      // CLAUDE.md: "Correctness and efficiency come first... do not drop
      // error handling or an edge case to shorten a diff." A stray `any`
      // is exactly that kind of shortcut, so flag it rather than forbid it.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },

  prettierConfig,
]);
