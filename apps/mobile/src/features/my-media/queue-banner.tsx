import { Fragment, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { GLYPH, Glyph, type GlyphName } from '@/components/ui/glyph';
import { Icon, type IconName } from '@/components/ui/icon';
import type { QueueCounts } from '@/features/upload-queue/types';
import { useTokenColor } from '@/hooks/use-token-color';

const IOS = Platform.OS === 'ios';
// Where the iOS hairline starts: the row's padding, the glyph and the gap after it.
const TEXT_INSET = 20 + 20 + 12;

export interface StatusRow {
  key: string;
  glyph: GlyphName;
  title: string;
  detail?: string;
  error?: string;
  actions?: {
    label: string;
    icon: IconName;
    variant?: 'primary' | 'secondary' | 'tonal';
    busy?: boolean;
    onPress(): void;
  }[];
}

// The queue counts as D-157 words them, each state once, zero segments left out.
export function queueSummary(counts: QueueCounts): string {
  return [
    { count: counts.queued, text: 'queued' },
    { count: counts.waitingAlbum, text: 'waiting for album' },
    { count: counts.waitingVerification, text: 'waiting to check in' },
    { count: counts.uploading, text: 'uploading' },
  ]
    .filter((segment) => segment.count > 0)
    .map((segment) => `${segment.count} ${segment.text}`)
    .join(' · ');
}

// My Media's one status banner (D-159). The queue counts head it and collapse the rows beneath:
// album closed (D-161), check-in, and S-14's keep-open notice (D-158). With no counts the rows show on their own, and
// with nothing to say the banner is gone. iOS draws it as an inset grouped card on the surface
// colour, Android as a Material 3 filled card on surfaceContainer.
export function StatusBanner({
  counts,
  rows,
}: {
  counts: QueueCounts;
  rows: readonly StatusRow[];
}) {
  const [expanded, setExpanded] = useState(true);
  const separator = useTokenColor('border');
  const summary = queueSummary(counts);
  if (!summary && rows.length === 0) return null;
  const collapsible = Boolean(summary) && rows.length > 0;
  const shown = !summary || expanded ? rows : [];
  const hairline = (
    <View
      pointerEvents="none"
      style={{
        height: StyleSheet.hairlineWidth,
        marginLeft: TEXT_INSET,
        backgroundColor: separator,
      }}
    />
  );
  return (
    <View
      accessibilityLiveRegion="polite"
      className="mx-5 mb-4 overflow-hidden rounded-3xl ios:bg-surface android:mx-4 android:bg-surfaceContainer">
      {summary ? (
        <Pressable
          accessibilityRole={collapsible ? 'button' : 'text'}
          accessibilityLabel={summary}
          accessibilityState={collapsible ? { expanded } : undefined}
          disabled={!collapsible}
          onPress={() => setExpanded((value) => !value)}
          className="min-h-14 flex-row items-center gap-3 px-5 py-3 active:opacity-80 android:px-4">
          <Glyph name={GLYPH.clock} size={20} tone="accentText" />
          <Text className="flex-1 font-h2 text-body text-textPrimary">{summary}</Text>
          {collapsible ? (
            <View style={{ transform: [{ rotate: expanded ? '180deg' : '0deg' }] }}>
              <Icon name="chevron-down" size={18} className="text-textSecondary" />
            </View>
          ) : null}
        </Pressable>
      ) : null}
      {shown.map((row, index) => (
        <Fragment key={row.key}>
          {IOS && (summary || index > 0) ? hairline : null}
          <View className="flex-row items-start gap-3 px-5 py-3 android:px-4">
            <View className="pt-0.5">
              <Glyph name={row.glyph} size={20} tone="accentText" />
            </View>
            <View className="flex-1 gap-1">
              <Text className="font-body text-body text-textPrimary">{row.title}</Text>
              {row.detail ? (
                <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
                  {row.detail}
                </Text>
              ) : null}
              {row.actions?.map((action) => (
                <View key={action.label} className="self-start pt-1">
                  <Button
                    label={action.label}
                    icon={action.icon}
                    variant={action.variant}
                    size="small"
                    busy={action.busy}
                    onPress={action.onPress}
                  />
                </View>
              ))}
              {row.error ? (
                <Text className="font-caption text-caption text-danger">{row.error}</Text>
              ) : null}
            </View>
          </View>
        </Fragment>
      ))}
    </View>
  );
}

// Shown to every role while the event's album is closed, first among the rows. A Photographer
// never sees Home, so this is where they learn it (D-161).
export const ALBUM_CLOSED_ROW: StatusRow = {
  key: 'album-closed',
  glyph: GLYPH.albumClosed,
  title: 'Album closed',
  detail: 'New photos wait on this phone until the album opens.',
};

// S-14's notice for a phone that refused background protection (D-158).
export const KEEP_OPEN_ROW: StatusRow = {
  key: 'keep-open',
  glyph: { ios: 'iphone', android: 'smartphone' },
  title: 'Keep MomentLens open to finish uploading',
};
