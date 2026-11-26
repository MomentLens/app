import type { PhotoFace } from '@momentlens/shared-types';
import { useRouter } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { setPeopleFilter, type PeopleFilter } from '@/features/album/filter-store';
import { MemberAvatar } from '@/features/album/member-avatar';
import { tabHref } from '@/features/event-shell/tabs';
import { usePhotoFaces } from './use-photo-faces';

// The Recognized Faces strip of one photo (spec §2.5.6, D-176): a row of name chips, "Unknown"
// where a face matched nobody, with no crop and no box. Tapping one sets Home's People filter and
// returns to Home, which shows it as the People pill. The strip sits on a dark photo screen.
//
// It draws nothing while loading, on an error, or when the photo has no face to name, which is
// every photo until arch §6 records thresholds (D-172). S-22 mounts it on the single photo view.
export function FacesStrip({ eventId, mediaId }: { eventId: string; mediaId: string }) {
  const router = useRouter();
  const facesQuery = usePhotoFaces(eventId, mediaId);
  const faces = facesQuery.data?.faces ?? [];
  if (faces.length === 0) return null;

  const open = (filter: PeopleFilter) => {
    setPeopleFilter(eventId, filter);
    router.dismissTo(tabHref(eventId, 'home'));
  };

  return (
    // Horizontal, so a photo with 40 faces scrolls instead of wrapping over the action bar.
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityLabel="Recognized faces"
      contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
      {faces.map((face) => (
        <FaceChip key={faceKey(face)} face={face} onPress={() => open(filterFor(face))} />
      ))}
    </ScrollView>
  );
}

function faceKey(face: PhotoFace): string {
  return face.kind === 'person' ? `p:${face.userId}` : `u:${face.clusterId}`;
}

function filterFor(face: PhotoFace): PeopleFilter {
  return face.kind === 'person'
    ? { kind: 'person', userId: face.userId, name: face.fullName }
    : { kind: 'unknown', clusterId: face.clusterId };
}

function FaceChip({ face, onPress }: { face: PhotoFace; onPress: () => void }) {
  const label = face.kind === 'person' ? face.fullName : 'Unknown';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Show photos of ${face.kind === 'person' ? label : 'this unknown person'}`}
      onPress={onPress}
      className="h-11 flex-row items-center gap-2 rounded-full bg-onPhoto/15 pl-1.5 pr-4 active:opacity-70">
      {face.kind === 'person' ? (
        <MemberAvatar name={face.fullName} size={32} />
      ) : (
        <View className="h-8 w-8 items-center justify-center rounded-full bg-onPhoto/20">
          <Icon name="user" size={18} className="text-onPhoto" />
        </View>
      )}
      <Text className="font-body text-body text-onPhoto" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}
