import type { MembershipRole } from '@momentlens/shared-types';
import { useRouter } from 'expo-router';
import type { ReactElement, ReactNode } from 'react';
import type { RefreshControlProps } from 'react-native';

import { LargeTitleScreen } from '@/components/ui/large-title-screen';
import type { BarAction, LargeTitleList } from '@/components/ui/large-title-screen.types';
import { useEventId } from '@/features/event-shell/event-id';
import { useEvent } from '@/features/event-shell/use-event';
import { formatEventDates } from '@/features/events/format';

const ROLE_LINE: Record<MembershipRole, string> = {
  admin: "You're the Admin",
  guest: "You're a Guest",
  photographer: "You're a Photographer",
};

interface EventTabScreenProps {
  actions?: BarAction[];
  refreshControl?: ReactElement<RefreshControlProps>;
  bottomInset?: number;
  overlay?: ReactNode;
  contentClassName?: string;
  renderList?: (list: LargeTitleList) => ReactNode;
  children?: ReactNode;
}

// The first screen of every Event shell tab, under the Event header (spec §2.5.1, D-119, D-125):
// the platform's back button to Events, the event's name as the large title, which stays in the
// bar once it collapses, and its dates and the caller's role under it. S-29 adds the avatar at the
// bar's trailing end (spec §2.5.9). No cover (D-119).
export function EventTabScreen({ children, ...screen }: EventTabScreenProps) {
  const router = useRouter();
  const event = useEvent(useEventId()).data?.event;
  const subtitle = event
    ? `${formatEventDates(new Date(event.startsAt), new Date(event.endsAt))} · ${ROLE_LINE[event.role]}`
    : undefined;

  return (
    <LargeTitleScreen
      title={event?.name ?? ''}
      subtitle={subtitle}
      // router.back() inside the tabs would step back through them first on Android.
      back={{ label: 'Back to Events', onPress: () => router.dismissTo('/') }}
      {...screen}>
      {children}
    </LargeTitleScreen>
  );
}
