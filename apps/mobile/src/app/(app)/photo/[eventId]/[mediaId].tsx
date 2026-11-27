import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

import { PhotoViewerScreen } from '@/features/photo-viewer/photo-viewer-screen';

// Home's single photo view (spec §2.5.6). Home passes its active chip and Uploader filter, so the
// pager pages through exactly the photos the grid shows.
export default function PhotoRoute() {
  const { eventId, mediaId, subEventId, uploaderId } = useLocalSearchParams<{
    eventId: string;
    mediaId: string;
    subEventId?: string;
    uploaderId?: string;
  }>();
  const filters = useMemo(() => ({ subEventId, uploaderId }), [subEventId, uploaderId]);
  return <PhotoViewerScreen eventId={eventId} mediaId={mediaId} filters={filters} />;
}
