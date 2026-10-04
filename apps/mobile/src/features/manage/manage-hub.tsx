import { useRouter } from 'expo-router';
import { Platform } from 'react-native';

import { GLYPH, Glyph, type GlyphName } from '@/components/ui/glyph';
import { Row, Section, SectionGap } from '@/components/ui/grouped';
import { EventTabScreen } from '@/features/event-shell/event-tab-screen';
import { tabHref } from '@/features/event-shell/tabs';
import { useSubEvents } from '@/features/schedule/use-sub-events';
import { byPlatform } from '@/lib/copy';

const IOS = Platform.OS === 'ios';

// A row a later slice builds: dimmed, announced as a dimmed button, and doing nothing yet. S-05,
// S-06, S-07 and S-24 each give their own row a target (D-142).
const LATER = {
  disabled: true,
  onPress: () => undefined,
  accessibilityHint: 'Arrives in a later update.',
  chevron: true,
} as const;

function HubGlyph({ name }: { name: GlyphName }) {
  return <Glyph name={name} size={22} tone="accentText" />;
}

// A row's second piece of text: a value at the trailing end on iOS, as Settings shows one, and a
// supporting line under the title on Android, as Material 3's two-line list item does.
function detail(text: string | undefined) {
  if (text === undefined) return {};
  return IOS ? { value: text } : { subtitle: text };
}

// The Admin's Manage tab, a hub of grouped rows that each open a screen of their own (spec
// §2.5.7). Pending Approvals stays apart from the Review Queue on purpose: different data and
// different actions. The live status card arrives at the top with S-31, and has no placeholder
// until then (D-142).
export function ManageHub({ eventId }: { eventId: string }) {
  const router = useRouter();
  // The Schedule's own persisted query, so the count is there whenever the Schedule has loaded.
  const subEvents = useSubEvents(eventId).data?.subEvents;
  const subEventsTitle = byPlatform('Sub-Events', 'Sub-events');
  const count = subEvents ? String(subEvents.length) : undefined;

  return (
    <EventTabScreen contentClassName="pt-2">
      <Section>
        <Row
          title={byPlatform('Pending Approvals', 'Pending approvals')}
          leading={<HubGlyph name={GLYPH.approvals} />}
          chevron
          onPress={() =>
            router.push({ pathname: '/event/[id]/manage/approvals', params: { id: eventId } })
          }
        />
        <Row
          title={byPlatform('Review Queue', 'Review queue')}
          leading={<HubGlyph name={GLYPH.reviewQueue} />}
          {...LATER}
        />
      </Section>
      <SectionGap />
      <Section>
        <Row
          title="Attendees"
          leading={<HubGlyph name={GLYPH.attendees} />}
          chevron
          onPress={() =>
            router.push({ pathname: '/event/[id]/manage/attendees', params: { id: eventId } })
          }
        />
        <Row
          title="Invite"
          {...detail('Links and QR codes')}
          leading={<HubGlyph name={GLYPH.invite} />}
          {...LATER}
        />
      </Section>
      <SectionGap />
      <Section
        footer={
          IOS ? 'Sub-Events opens the Schedule, where you add, edit and delay them.' : undefined
        }>
        {/* The Schedule tab already holds Add and Delay, so the hub links to it rather than
            repeating it (spec §2.5.7). */}
        <Row
          title={subEventsTitle}
          {...detail(IOS ? count : 'Opens the Schedule')}
          accessibilityLabel={count ? `${subEventsTitle}, ${count}` : subEventsTitle}
          accessibilityHint="Opens the Schedule."
          leading={<HubGlyph name={GLYPH.subEvents} />}
          chevron
          onPress={() => router.navigate(tabHref(eventId, 'schedule'))}
        />
        <Row
          title={byPlatform('Event Settings', 'Event settings')}
          leading={<HubGlyph name={GLYPH.settings} />}
          chevron
          onPress={() =>
            router.push({ pathname: '/event/[id]/manage/settings', params: { id: eventId } })
          }
        />
      </Section>
    </EventTabScreen>
  );
}
