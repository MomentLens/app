import { Stack, usePathname, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { readPendingInvite } from '@/features/join/pending-invite';
import { useTokenColor } from '@/hooks/use-token-color';

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
  const background = useTokenColor('background');

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

  const sheet = {
    presentation: 'formSheet',
    sheetAllowedDetents: 'fitToContents',
    sheetGrabberVisible: true,
    sheetCornerRadius: Platform.OS === 'android' ? 28 : undefined,
    contentStyle: { backgroundColor: background },
  } as const;

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
      {/* Sheets that fit their content, over the whole Event shell. A formSheet draws inside the
          navigator that presents it, so from a tab's Stack the Android scrim stopped at the Event
          header and left the tab bar lit (D-125). iOS draws the grabber; Android takes Material 3's
          28dp corners here and draws its handle in the content. */}
      <Stack.Screen name="sub-event/[eventId]/[subEventId]/index" options={sheet} />
      <Stack.Screen name="sub-event/[eventId]/[subEventId]/delay" options={sheet} />
      <Stack.Screen name="attendee/[eventId]/[userId]" options={sheet} />
    </Stack>
  );
}
