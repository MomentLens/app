const {
  AndroidConfig,
  withAndroidColors,
  withAndroidColorsNight,
  withAndroidStyles,
} = require('expo/config-plugins');

// The gold for the buttons of React Native's Alert on Android, which draws an AppCompat dialog
// from the app theme. Expo generates that theme with no accent, so the buttons came out teal and
// all caps, and only a config plugin reaches it. These are accentText from global.css: 5.7:1 on
// the light dialog, and the dark palette's gold on the dark one (D-124).
const ACCENT = '#7E5B1E';
const ACCENT_NIGHT = '#D6AC52';

const DIALOG = { name: 'AppAlertDialog', parent: 'ThemeOverlay.AppCompat.Dialog.Alert' };
const DIALOG_BUTTON = {
  name: 'AppAlertDialogButton',
  parent: 'Widget.AppCompat.Button.ButtonBar.AlertDialog',
};

function setStyle(xml, parent, name, value) {
  return AndroidConfig.Styles.assignStylesValue(xml, { add: true, parent, name, value });
}

function setAccent(value) {
  return (config) => {
    config.modResults = AndroidConfig.Colors.assignColorValue(config.modResults, {
      name: 'colorAccent',
      value,
    });
    return config;
  };
}

// AppCompat's alert dialogs with the gold buttons and sentence case labels, as Material 3 sets
// them, in place of the template's teal all-caps ones.
module.exports = function withAndroidTheme(config) {
  config = withAndroidColors(config, setAccent(ACCENT));
  config = withAndroidColorsNight(config, setAccent(ACCENT_NIGHT));
  return withAndroidStyles(config, (config) => {
    let xml = config.modResults;
    const app = AndroidConfig.Styles.getAppThemeGroup();
    xml = setStyle(xml, app, 'colorAccent', '@color/colorAccent');
    xml = setStyle(xml, app, 'alertDialogTheme', `@style/${DIALOG.name}`);
    xml = setStyle(xml, DIALOG, 'colorAccent', '@color/colorAccent');
    for (const button of ['Positive', 'Negative', 'Neutral']) {
      xml = setStyle(xml, DIALOG, `buttonBar${button}ButtonStyle`, `@style/${DIALOG_BUTTON.name}`);
    }
    xml = setStyle(xml, DIALOG_BUTTON, 'android:textAllCaps', 'false');
    xml = setStyle(xml, DIALOG_BUTTON, 'android:textColor', '@color/colorAccent');
    config.modResults = xml;
    return config;
  });
};
