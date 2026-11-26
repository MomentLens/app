import { useQuery } from '@tanstack/react-query';

import { recheckEvent, retryUnlessRefused } from '@/features/event-shell/use-event';
import { ApiError, listPhotoFaces } from '@/lib/api';

export function photoFacesQueryKey(eventId: string, mediaId: string) {
  return ['photo-faces', eventId, mediaId] as const;
}

// GET /events/{eventId}/media/{mediaId}/faces for the Recognized Faces strip. A match can change
// with no `variant_version` bump, so the strip asks again every time a photo opens and keeps
// nothing once it closes (D-176). Not persisted.
export function usePhotoFaces(eventId: string, mediaId: string) {
  return useQuery({
    queryKey: photoFacesQueryKey(eventId, mediaId),
    queryFn: async ({ signal }) => {
      try {
        return await listPhotoFaces(eventId, mediaId, signal);
      } catch (error) {
        // A 404 is a deleted event or a deleted photo. Rechecking the event tells the two apart.
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          recheckEvent(eventId);
        }
        throw error;
      }
    },
    retry: retryUnlessRefused,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  });
}
