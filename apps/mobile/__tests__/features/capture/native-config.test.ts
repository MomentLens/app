import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

describe('generated camera permissions', () => {
  it('retains the camera permission when image picking is gallery-only', () => {
    const project = path.resolve(__dirname, '../../..');
    const expo = path.dirname(require.resolve('expo/package.json'));
    const output = execFileSync(
      process.execPath,
      [path.join(expo, 'bin/cli'), 'config', '--type', 'introspect', '--json'],
      {
        cwd: project,
        env: { ...process.env, EXPO_NO_DOTENV: '1' },
        encoding: 'utf8',
      },
    );
    const config = JSON.parse(output);
    const permissions = config._internal.modResults.android.manifest.manifest['uses-permission'];
    const camera = permissions.find(
      (permission: { $: Record<string, string> }) =>
        permission.$['android:name'] === 'android.permission.CAMERA',
    );
    expect(camera).toBeDefined();
    expect(camera.$['tools:node']).not.toBe('remove');
    expect(config._internal.modResults.ios.infoPlist.NSCameraUsageDescription).toContain(
      'MomentLens',
    );
  });
});
