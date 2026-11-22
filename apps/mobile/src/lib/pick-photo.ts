import * as ImagePicker from 'expo-image-picker';
import { Alert, Linking } from 'react-native';

import { byPlatform } from '@/lib/copy';

export type PhotoSource = 'camera' | 'library';

// One photo from the camera or the system picker, as a local uri, or null when the person
// cancelled or refused the camera. The system picker needs no library permission on either
// platform. The camera asks once, and after a refusal offers Settings, as the viewfinder does.
//
// The front camera is the default for a profile or reference photo, both of which are selfies.
export async function pickPhoto(source: PhotoSource): Promise<string | null> {
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 1,
    exif: false,
  };
  if (source === 'library') {
    const picked = await ImagePicker.launchImageLibraryAsync({ ...options, selectionLimit: 1 });
    return picked.canceled ? null : (picked.assets[0]?.uri ?? null);
  }
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    if (!permission.canAskAgain) {
      Alert.alert(
        'Camera is off for MomentLens',
        'Turn it on in Settings to take a photo, or choose one from your photos.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: byPlatform('Open Settings', 'Open settings'),
            onPress: () => void Linking.openSettings(),
          },
        ],
      );
    }
    return null;
  }
  const taken = await ImagePicker.launchCameraAsync({
    ...options,
    cameraType: ImagePicker.CameraType.front,
  });
  return taken.canceled ? null : (taken.assets[0]?.uri ?? null);
}

// Asks Take Photo or Choose Photo in a system alert, then hands back the choice. Android's alert
// holds at most three buttons, which is exactly these.
export function choosePhotoSource(title: string, onSource: (source: PhotoSource) => void): void {
  Alert.alert(title, undefined, [
    { text: byPlatform('Take Photo', 'Take photo'), onPress: () => onSource('camera') },
    { text: byPlatform('Choose Photo', 'Choose photo'), onPress: () => onSource('library') },
    { text: 'Cancel', style: 'cancel' },
  ]);
}
