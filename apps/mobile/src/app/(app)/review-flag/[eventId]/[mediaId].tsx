import { useLocalSearchParams } from 'expo-router';

import { FlaggedPhotoViewer } from '@/features/review-queue/flagged-photo-viewer';

// The Admin's moderation viewer for a flagged photo, opened from the Review Queue (D-181). A route
// of its own rather than a mode of Home's viewer, which pages through the album, not the queue.
export default function ReviewFlagRoute() {
  const { eventId, mediaId } = useLocalSearchParams<{ eventId: string; mediaId: string }>();
  return <FlaggedPhotoViewer eventId={eventId} mediaId={mediaId} />;
}
