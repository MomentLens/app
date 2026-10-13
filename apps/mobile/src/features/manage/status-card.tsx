import type { SubEvent } from '@momentlens/shared-types';
import { useCallback } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';

import { GLYPH, Glyph } from '@/components/ui/glyph';
import { Toggle } from '@/components/ui/toggle';
import { eventMoment, type EventMoment } from '@/features/album/album-state';
import { useAlbumStatus, useAlbumSwitch } from '@/features/album/use-album-switch';
import { formatDay, formatTime, formatTimeRange } from '@/features/events/format';
import { nextStatusChange } from '@/features/schedule/schedule';
import { useSubEvents } from '@/features/schedule/use-sub-events';
import { useNow } from '@/hooks/use-now';
import { useTokenColor } from '@/hooks/use-token-color';

const IOS = Platform.OS === 'ios';
const EMPTY_SCHEDULE: SubEvent[] = [];

// The status line's three parts: a label, the sub-event's name, and when and where.
function momentLines(
  moment: EventMoment,
  scheduleFailed: boolean,
): { label: string; name?: string; detail?: string } {
  switch (moment.kind) {
    case 'live': {
      const { subEvent } = moment;
      return {
        label: IOS ? 'In Progress' : 'In progress',
        name: subEvent.name,
        detail: `${formatTimeRange(new Date(subEvent.startsAt), new Date(subEvent.endsAt))} · ${subEvent.venue.name}`,
      };
    }
    case 'next': {
      const starts = new Date(moment.subEvent.startsAt);
      return {
        label: 'Upcoming',
        name: moment.subEvent.name,
        detail: `${formatDay(starts)} · ${formatTime(starts)} · ${moment.subEvent.venue.name}`,
      };
    }
    case 'ended':
      return { label: 'The event has ended' };
    case 'unknown':
      return {
        label: scheduleFailed ? 'The schedule could not be loaded' : 'Loading the schedule',
      };
  }
}

// The live status card at the top of Manage (spec §2.5.7, D-161): where the event stands, the
// event's finished uploads that are not deleted, processed or not, and the Open/Close Album
// switch, the same one as Home's banner. Drawn like the hub's sections: inset grouped on the
// surface colour on iOS, a Material 3 filled card on Android.
export function StatusCard({ eventId }: { eventId: string }) {
  const album = useAlbumSwitch(eventId);
  const status = useAlbumStatus(eventId);
  const scheduleQuery = useSubEvents(eventId);
  const schedule = scheduleQuery.data?.subEvents ?? EMPTY_SCHEDULE;
  const nextChange = useCallback((at: Date) => nextStatusChange(schedule, at), [schedule]);
  const now = useNow(nextChange);
  const moment = eventMoment(schedule, now);
  const lines = momentLines(moment, scheduleQuery.isError);
  const separator = useTokenColor('border');
  const count = status.data?.uploadCount;

  return (
    <View className="overflow-hidden ios:mx-5 ios:rounded-[26px] ios:bg-surface android:mx-4 android:rounded-3xl android:bg-surfaceContainer">
      <View className="flex-row items-start gap-4 px-4 pb-4 pt-4">
        <View accessible className="flex-1 gap-1">
          <View className="flex-row items-center gap-2">
            {moment.kind === 'live' ? <View className="h-2 w-2 rounded-full bg-danger" /> : null}
            <Text className="font-caption text-caption text-textSecondary">{lines.label}</Text>
          </View>
          {lines.name ? (
            <Text numberOfLines={2} className="font-h2 text-h2 text-textPrimary">
              {lines.name}
            </Text>
          ) : null}
          {lines.detail ? (
            <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
              {lines.detail}
            </Text>
          ) : null}
        </View>
        <View
          accessible
          accessibilityLabel={
            count === undefined
              ? status.isError
                ? 'Uploads unavailable'
                : 'Uploads loading'
              : `${count} ${count === 1 ? 'upload' : 'uploads'}`
          }
          className="min-w-16 items-end">
          {count === undefined ? (
            status.isError ? (
              <Text className="font-h1 text-h1 text-textMuted">?</Text>
            ) : (
              <ActivityIndicator className="text-textSecondary" />
            )
          ) : (
            <Text className="font-h1 text-h1 text-textPrimary">{count}</Text>
          )}
          <Text className="font-caption text-caption text-textSecondary">
            {count === 1 ? 'upload' : 'uploads'}
          </Text>
        </View>
      </View>
      {IOS ? (
        <View
          style={{ height: StyleSheet.hairlineWidth, marginLeft: 16, backgroundColor: separator }}
        />
      ) : (
        <View className="mx-4 h-px bg-border" />
      )}
      <View className="min-h-14 flex-row items-center gap-3 px-4 py-3">
        <Glyph
          name={album.open ? GLYPH.albumOpen : GLYPH.albumClosed}
          size={22}
          tone="accentText"
        />
        <View className="flex-1 gap-0.5">
          <Text className="font-body text-body text-textPrimary">
            {album.open ? 'Album open' : 'Album closed'}
          </Text>
          <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
            {album.open
              ? 'Guests and photographers can add photos.'
              : 'New photos wait on each phone until you open it.'}
          </Text>
        </View>
        <Toggle
          value={album.open}
          onValueChange={album.setOpen}
          disabled={album.busy || !album.known}
          accessibilityLabel="Album open"
        />
      </View>
      {album.problem ? (
        <Text accessibilityRole="alert" className="px-4 pb-3 font-caption text-caption text-danger">
          {album.problem}
        </Text>
      ) : null}
    </View>
  );
}
