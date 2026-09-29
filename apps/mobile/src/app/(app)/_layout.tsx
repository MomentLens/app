import { Stack, usePathname, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';

import { readPendingInvite } from '@/features/join/pending-invite';

// A link or a code that opens a screen in this group directly still has the Events list under it,
// so going back from Join Confirmation or an event lands on Events.
export const unstable_settings = { anchor: '(tabs)' };

const CONFIRM = '/join/confirm';

// The signed-in app. The root layout mounts this group only while someone is signed in.
//
// A Stack around the Global shell's tabs, so the Create Event wizard and an event's screen cover
// the tab bar rather than sitting inside one tab (spec §2.5.1). Native tabs show only the routes
// their layout names, so these could not live beside the tabs.
export default function AppLayout() {
  const router = useRouter();
  const pathname = usePathname();
  const checked = useRef(false);

  // The group mounts at launch and right after a login or signup. Either way, an invite opened and
  // not yet joined or dismissed opens Join Confirmation over Events (D-115). A link that is already
  // opening it is left alone.
  useEffect(() => {
    if (checked.current) {
      return;
    }
    checked.current = true;
    if (pathname !== CONFIRM && readPendingInvite() !== null) {
      router.push(CONFIRM);
    }
  }, [pathname, router]);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      {/* No swipe down: closing the wizard asks before throwing the draft away (events/new). */}
      <Stack.Screen
        name="events/new"
        options={{ presentation: 'fullScreenModal', gestureEnabled: false }}
      />
      <Stack.Screen name="event/[id]" />
      <Stack.Screen name="join/confirm" />
      <Stack.Screen name="join/pending/[eventId]" />
    </Stack>
  );
}
