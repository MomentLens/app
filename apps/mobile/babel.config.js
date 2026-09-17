// Babel for apps/mobile, on Expo's preset with NativeWind v4 on top
// (https://www.nativewind.dev/docs/getting-started/installation).
//
// jsxImportSource routes JSX through NativeWind so `className` works on React Native components, and
// nativewind/babel compiles the classes. Jest reads this file too, through jest-expo.

module.exports = function (api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { jsxImportSource: 'nativewind' }], 'nativewind/babel'],
  };
};
