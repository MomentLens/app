// Metro for apps/mobile. Expo's default config with Sentry's additions, then NativeWind compiling
// ./global.css and the classes in tailwind.config.js into React Native styles.
//
// getSentryExpoConfig stands in for expo/metro-config's getDefaultConfig. It stamps a Debug ID into
// each bundle and its source map, which is how Sentry matches an uploaded source map to a crash.

const { getSentryExpoConfig } = require('@sentry/react-native/metro');
const { withNativeWind } = require('nativewind/metro');

const config = getSentryExpoConfig(__dirname);

module.exports = withNativeWind(config, { input: './global.css' });
