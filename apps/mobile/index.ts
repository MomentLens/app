import { AppRegistry } from 'react-native';

import {
  BACKGROUND_UPLOAD_TASK,
  backgroundUploadTask,
} from '@/features/upload-queue/background-task';
// Registers the app through Expo Router, as the last import, as Expo Router's custom entry asks
// (https://docs.expo.dev/router/installation/).
import 'expo-router/entry';

// Android's background upload service starts this task by name (D-158). The bundle registers it
// while it loads, before native code can ask for it. iOS never runs it.
AppRegistry.registerHeadlessTask(BACKGROUND_UPLOAD_TASK, () => backgroundUploadTask);
