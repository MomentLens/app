import type { SubEvent, SubEventStatus } from '@momentlens/shared-types';
import { Link, type Href } from 'expo-router';
import { useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';

import { AnchoredMenu, type MenuAnchor, type MenuItem } from '@/components/ui/anchored-menu';
import { Button } from '@/components/ui/button';
import { GLYPH, Glyph } from '@/components/ui/glyph';
import { Row } from '@/components/ui/grouped';
import { formatTime } from '@/features/events/format';
import { romanNumeral } from '@/features/schedule/schedule';

export const STATUS_LABEL: Record<SubEventStatus, string> = {
  upcoming: 'Upcoming',
  in_progress: 'In progress',
  completed: 'Completed',
};

interface ScheduleRowProps {
  subEvent: SubEvent;
  number: number;
  status: SubEventStatus;
  // Sub-event Detail, which a tap opens.
  href: Href;
  // A Delay button on the row, for the next sub-event to start (D-127).
  delayButton?: boolean;
  onDelay?: () => void;
  // The long-press menu: Delay and Edit for the Admin, Directions and Photos for whoever may.
  menu: readonly MenuItem[];
}

// The status every row shows (spec §2.5.5): a check once it is over, Live while it runs, and the
// word Upcoming before, unless the row carries the Delay button instead.
function Status({ status }: { status: SubEventStatus }) {
  if (status === 'completed') {
    return <Glyph name={GLYPH.check} size={18} tone="textMuted" />;
  }
  if (status === 'in_progress') {
    return (
      <View className="flex-row items-center gap-1.5 rounded-full bg-danger/10 px-2 py-0.5">
        <View className="h-1.5 w-1.5 rounded-full bg-danger" />
        <Text className="font-micro text-micro text-danger">Live</Text>
      </View>
    );
  }
  return <Text className="font-caption text-caption text-textSecondary">Upcoming</Text>;
}

// One sub-event as a timeline row (D-127): the start over the end, the numeral in Fraunces before
// the name, the venue as the Admin typed it, and the status. A tap opens Sub-event Detail. A long
// press opens the platform's menu, and on iOS the Admin can swipe for Delay.
export function ScheduleRow({
  subEvent,
  number,
  status,
  href,
  delayButton = false,
  onDelay,
  menu,
}: ScheduleRowProps) {
  const done = status === 'completed';
  const startsAt = formatTime(new Date(subEvent.startsAt));
  const endsAt = formatTime(new Date(subEvent.endsAt));
  const label = `${subEvent.name}, ${STATUS_LABEL[status]}, ${startsAt} to ${endsAt}, ${subEvent.venue.name}`;

  const body = (
    <View className={`flex-1 flex-row items-start gap-3.5 ${done ? 'opacity-55' : ''}`}>
      <View className="w-[76px]">
        <Text
          numberOfLines={1}
          className="font-fieldLabel text-bodySecondary tabular-nums text-textPrimary">
          {startsAt}
        </Text>
        <Text
          numberOfLines={1}
          className="font-caption text-caption tabular-nums text-textSecondary">
          {endsAt}
        </Text>
      </View>
      <View className="flex-1 gap-0.5">
        <View className="flex-row items-baseline gap-1.5">
          <Text className="font-fraunces-semibold text-body text-accentText">
            {romanNumeral(number)}
          </Text>
          <Text numberOfLines={1} className="flex-1 font-h2 text-body text-textPrimary">
            {subEvent.name}
          </Text>
        </View>
        <Text
          numberOfLines={1}
          className="font-bodySecondary text-bodySecondary text-textSecondary">
          {subEvent.venue.name}
        </Text>
      </View>
    </View>
  );

  const trailing =
    delayButton && onDelay ? (
      <Button label="Delay" icon="clock" variant="tonal" size="small" onPress={onDelay} />
    ) : (
      <Status status={status} />
    );

  if (Platform.OS === 'ios') {
    const row = (
      <Link href={href} asChild>
        <Link.Trigger>
          <Row
            trailing={trailing}
            chevron
            accessibilityLabel={label}
            accessibilityHint="Opens the sub-event">
            {body}
          </Row>
        </Link.Trigger>
        <Link.Menu>
          {menu.map((item) => (
            <Link.MenuAction
              key={item.key}
              title={item.label}
              icon={item.glyph?.ios}
              destructive={item.destructive}
              disabled={item.disabled}
              onPress={item.onPress}
            />
          ))}
        </Link.Menu>
      </Link>
    );
    if (!onDelay) return row;
    return (
      <ReanimatedSwipeable
        friction={2}
        rightThreshold={40}
        renderRightActions={(_progress, _drag, swipeable) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Delay ${subEvent.name}`}
            onPress={() => {
              swipeable.close();
              onDelay();
            }}
            className="w-24 items-center justify-center gap-1 bg-accent">
            <Glyph name={GLYPH.delay} size={20} tone="textPrimary" />
            <Text className="font-fieldLabel text-caption text-textPrimary">Delay</Text>
          </Pressable>
        )}>
        {row}
      </ReanimatedSwipeable>
    );
  }

  return <AndroidRow label={label} href={href} trailing={trailing} menu={menu} body={body} />;
}

// Android: a tap opens Detail and a long press opens Material 3's menu anchored to the row.
function AndroidRow({
  label,
  href,
  trailing,
  menu,
  body,
}: {
  label: string;
  href: Href;
  trailing: React.ReactNode;
  menu: readonly MenuItem[];
  body: React.ReactNode;
}) {
  const box = useRef<View>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  return (
    <View ref={box} collapsable={false}>
      <Link href={href} asChild>
        <Row
          trailing={trailing}
          accessibilityLabel={label}
          accessibilityHint="Opens the sub-event. Long press for more."
          onLongPress={() =>
            box.current?.measureInWindow((x, y, width, height) =>
              setAnchor({ x, y, width, height }),
            )
          }>
          {body}
        </Row>
      </Link>
      <AnchoredMenu anchor={anchor} items={menu} onClose={() => setAnchor(null)} />
    </View>
  );
}
