// Jest for apps/mobile, on Expo's preset (https://docs.expo.dev/develop/unit-testing/).
//
// jest-expo 57 is built on Jest 29, so this package pins Jest 29 even though apps/api runs 30.
// Tests import describe, expect and jest from @jest/globals, the way apps/api does, rather than
// relying on global types.

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  // Expo's pattern for pnpm. Isolated installs put every package under node_modules/.pnpm, and
  // without `.pnpm` in the list the preset would skip transforming React Native's own setup files.
  transformIgnorePatterns: [
    'node_modules/(?!(.pnpm|(jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@sentry/react-native|native-base|react-native-svg))',
  ],
  // The app imports through the @/ aliases in tsconfig.json, which Jest does not read on its own.
  moduleNameMapper: {
    '^@/assets/(.*)$': '<rootDir>/assets/$1',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  // Expo dropped Watchman for Metro in SDK 56, and apps/api turns it off for the same reason.
  watchman: false,
};
