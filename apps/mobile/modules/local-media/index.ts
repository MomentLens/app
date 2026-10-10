import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

interface LocalMediaModule {
  excludeMediaFromBackup(): Promise<boolean>;
  cameraStillSize(front: boolean): Promise<string>;
}
export async function cameraStillSize(front: boolean): Promise<string> {
  const native = requireOptionalNativeModule<LocalMediaModule>('LocalMedia');
  if (!native) throw new Error('The camera needs a new native build.');
  return native.cameraStillSize(front);
}
export async function excludeMediaFromBackup(): Promise<void> {
  if (Platform.OS === 'android') return; // Android's installed manifest supplies the rules.
  if (Platform.OS !== 'ios') throw new Error('Local media requires an iOS or Android phone.');
  const native = requireOptionalNativeModule<LocalMediaModule>('LocalMedia');
  if (!native || !(await native.excludeMediaFromBackup().catch(() => false))) {
    throw new Error(
      'Local media backup protection is unavailable. Rebuild the app before using the camera.',
    );
  }
}
