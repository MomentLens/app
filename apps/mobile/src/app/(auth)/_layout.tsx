import { Stack } from 'expo-router';

// The signed-out screens. The root layout mounts this group only while nobody is signed in, and
// Login is the screen it opens on.
export const unstable_settings = { anchor: 'login' };

export default function AuthLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
