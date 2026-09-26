import { Stack } from 'expo-router';

// The signed-in app. The root layout mounts this group only while someone is signed in.
//
// A Stack around the Global shell's tabs, so the Create Event wizard and an event's screen cover
// the tab bar rather than sitting inside one tab (spec §2.5.1). Native tabs show only the routes
// their layout names, so these two could not live beside the tabs.
export default function AppLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      {/* No swipe down: closing the wizard asks before throwing the draft away (events/new). */}
      <Stack.Screen
        name="events/new"
        options={{ presentation: 'fullScreenModal', gestureEnabled: false }}
      />
      <Stack.Screen name="event/[id]" />
    </Stack>
  );
}
