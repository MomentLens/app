import type { MembershipRole } from '@momentlens/shared-types';
import { Text, View } from 'react-native';

import { GLYPH, Glyph } from '@/components/ui/glyph';
import { Toggle } from '@/components/ui/toggle';

import { useAlbumSwitch } from './use-album-switch';

// The album-state banner under Home's header (spec §2.5.2, D-161). A Guest sees it only while the
// album is closed. The Admin sees it in both states, with the Open/Close Album switch inline, the
// same switch as Manage's status card. A Photographer never reaches Home, and reads the closed
// state in My Media's banner instead. Drawn as My Media's banner is: an inset card on the surface
// colour on iOS, a Material 3 filled card on Android.
export function AlbumBanner({ eventId, role }: { eventId: string; role: MembershipRole }) {
  const album = useAlbumSwitch(eventId);
  const admin = role === 'admin';
  if (!album.known || (!admin && album.open)) return null;

  const title = album.open ? 'Album open' : 'Album closed';
  const detail = admin
    ? album.open
      ? 'Guests and photographers can add photos.'
      : 'New photos wait on each phone until you open it.'
    : 'New photos wait on your phone until the organizer opens it.';

  return (
    <View
      accessibilityLiveRegion="polite"
      className="mx-5 mb-3 mt-2 overflow-hidden rounded-3xl ios:bg-surface android:mx-4 android:bg-surfaceContainer">
      <View className="min-h-14 flex-row items-center gap-3 px-5 py-3 android:px-4">
        <Glyph
          name={album.open ? GLYPH.albumOpen : GLYPH.albumClosed}
          size={20}
          tone="accentText"
        />
        <View className="flex-1 gap-0.5">
          <Text accessibilityRole="header" className="font-h2 text-body text-textPrimary">
            {title}
          </Text>
          <Text className="font-bodySecondary text-bodySecondary text-textSecondary">{detail}</Text>
        </View>
        {admin ? (
          <Toggle
            value={album.open}
            onValueChange={album.setOpen}
            disabled={album.busy}
            accessibilityLabel="Album open"
          />
        ) : null}
      </View>
      {album.problem ? (
        <Text
          accessibilityRole="alert"
          className="px-5 pb-3 font-caption text-caption text-danger android:px-4">
          {album.problem}
        </Text>
      ) : null}
    </View>
  );
}
