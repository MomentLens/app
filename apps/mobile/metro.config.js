// Metro for apps/mobile. Expo's default config, with NativeWind compiling ./global.css and the
// classes in tailwind.config.js into React Native styles.

const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

module.exports = withNativeWind(config, { input: './global.css' });
