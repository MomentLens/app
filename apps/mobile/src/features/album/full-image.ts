import type { MediaImage } from '@momentlens/shared-types';

import { recheckEvent, retryUnlessRefused } from '@/features/event-shell/use-event';
import { ApiError, getMediaImages } from '@/lib/api';

const FULL_RENEW_AFTER = 45 * 60 * 1000;

// One photo's full image for this viewer, signed by the serving endpoint (root invariant 3). The
// single photo view and Blur an Area share this key, so opening Blur from the viewer reuses the
// file it already signed. The key carries `variant_version`, so a regeneration while either screen
// is open signs the new file and never shows the old one (root invariant 2). A null image means the
// endpoint left the photo out: this viewer may no longer see it (D-148).
export function fullImageQuery(
  eventId: string,
  mediaId: string,
  variantVersion: number | undefined,
) {
  return {
    queryKey: ['media-images', eventId, 'full', mediaId, variantVersion ?? 'unknown'] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<MediaImage | null> => {
      try {
        const response = await getMediaImages(
          eventId,
          { mediaIds: [mediaId], size: 'full' },
          signal,
        );
        return response.images[mediaId] ?? null;
      } catch (error) {
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          recheckEvent(eventId);
        }
        throw error;
      }
    },
    staleTime: FULL_RENEW_AFTER,
    refetchInterval: FULL_RENEW_AFTER,
    retry: retryUnlessRefused,
  };
}
