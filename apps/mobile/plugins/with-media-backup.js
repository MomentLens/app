const { AndroidConfig, withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');

const exclusions = `
    <exclude domain="file" path="upload-queue/" />
    <exclude domain="file" path="SQLite/" />
    <exclude domain="database" path="." />`;

module.exports = function withMediaBackup(config) {
  config = withAndroidManifest(config, (mod) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(mod.modResults);
    app.$['android:fullBackupContent'] = '@xml/media_backup_rules';
    app.$['android:dataExtractionRules'] = '@xml/media_extraction_rules';
    return mod;
  });
  return withDangerousMod(config, [
    'android',
    async (mod) => {
      const directory = path.join(mod.modRequest.platformProjectRoot, 'app/src/main/res/xml');
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(
        path.join(directory, 'media_backup_rules.xml'),
        `<?xml version="1.0" encoding="utf-8"?>\n<full-backup-content>${exclusions}\n</full-backup-content>\n`,
      );
      await fs.writeFile(
        path.join(directory, 'media_extraction_rules.xml'),
        `<?xml version="1.0" encoding="utf-8"?>\n<data-extraction-rules>\n  <cloud-backup>${exclusions}\n  </cloud-backup>\n  <device-transfer>${exclusions}\n  </device-transfer>\n</data-extraction-rules>\n`,
      );
      return mod;
    },
  ]);
};
