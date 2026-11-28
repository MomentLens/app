import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

import { photoFilters } from '@/features/photo-viewer/model';
import { PhotoViewerScreen } from '@/features/photo-viewer/photo-viewer-screen';

// Home's single photo view (spec §2.5.6). Home passes its active chip, Uploader and People
// filters, so the pager pages through exactly the photos the grid shows.
export default function PhotoRoute() {
  const { eventId, mediaId, subEventId, uploaderId, personId, clusterId } = useLocalSearchParams<{
    eventId: string;
    mediaId: string;
    subEventId?: string;
    uploaderId?: string;
    personId?: string;
    clusterId?: string;
  }>();
  const filters = useMemo(
    () => photoFilters({ subEventId, uploaderId, personId, clusterId }),
    [subEventId, uploaderId, personId, clusterId],
  );
  return <PhotoViewerScreen eventId={eventId} mediaId={mediaId} filters={filters} />;
}
