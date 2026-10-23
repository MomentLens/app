import {
  MAX_MEDIA_IMAGES_BATCH,
  type AlbumMediaItem,
  type MediaImage,
} from '@momentlens/shared-types';
import {
  useQueries,
  useQuery,
  useQueryClient,
  type UseQueryResult,
  type Query,
  skipToken,
} from '@tanstack/react-query';
import { useCallback, useMemo, useRef } from 'react';

import { getMediaImages } from '@/lib/api';

type Versioned = Pick<AlbumMediaItem, 'id' | 'variantVersion'>;

// The loaded photos in batches of at most 50, the serving endpoint's limit (D-148). Each batch is
// keyed on its ids and their versions, so a regenerated photo's batch is a new query and is signed
// again (D-60, root invariant 2).
export function thumbnailBatches(media: readonly Versioned[]): Versioned[][] {
  const batches: Versioned[][] = [];
  for (let i = 0; i < media.length; i += MAX_MEDIA_IMAGES_BATCH) {
    batches.push(media.slice(i, i + MAX_MEDIA_IMAGES_BATCH));
  }
  return batches;
}

function versionKey(item: Versioned): string {
  return `${item.id}:${item.variantVersion}`;
}

const RENEW_AFTER = 45 * 60 * 1000;
type CachedImage = { version: number; image: MediaImage | null; renewAt: number };
type ImageCache = Record<string, CachedImage>;
type SignedBatch = { renewAt: number };

export interface ThumbnailMap {
  images: Readonly<Record<string, MediaImage>>;
  omitted: ReadonlySet<string>;
  retry: (mediaId: string) => void;
}

export function useThumbnailMap(eventId: string, media: readonly Versioned[]): ThumbnailMap {
  const client = useQueryClient();
  const batches = useMemo(() => thumbnailBatches(media), [media]);
  const cacheKey = useMemo(() => ['media-images', eventId, 'thumbnail-cache'], [eventId]);
  // One observed cache holds each photo's signing time, even when incoming photos shift batches.
  const cache = useQuery<ImageCache>({
    queryKey: cacheKey,
    queryFn: skipToken,
    enabled: false,
    initialData: {},
    staleTime: Infinity,
    gcTime: 60 * 60 * 1000,
  });
  const errors = useRef(new Map<string, number>());
  const retry = useCallback(
    (mediaId: string) => {
      const now = Date.now();
      const errorKey = `${eventId}:${mediaId}`;
      const previous = errors.current.get(errorKey);
      if (previous !== undefined && now - previous < 30_000) return;
      errors.current.set(errorKey, now);
      client.setQueryData<ImageCache>(cacheKey, (current) => {
        const entry = current?.[mediaId];
        return entry ? { ...current, [mediaId]: { ...entry, renewAt: 0 } } : current;
      });
      void client.invalidateQueries({ queryKey: ['media-images', eventId, 'thumbnail'] });
    },
    [client, cacheKey, eventId],
  );

  const combine = useCallback(
    (results: UseQueryResult<SignedBatch>[]): ThumbnailMap => {
      const images: Record<string, MediaImage> = {};
      const omitted = new Set<string>();
      results.forEach((_result, index) => {
        for (const item of batches[index] ?? []) {
          const entry = cache.data?.[item.id];
          if (entry?.version !== item.variantVersion) continue;
          // The server's omission wins over an older query result after access changes.
          if (entry.image === null) omitted.add(item.id);
          else images[item.id] = entry.image;
        }
      });
      return { images, omitted, retry };
    },
    [batches, cache.data, retry],
  );

  return useQueries({
    queries: batches.map((batch) => ({
      queryKey: ['media-images', eventId, 'thumbnail', batch.map(versionKey).join(',')],
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<SignedBatch> => {
        const now = Date.now();
        let entries = client.getQueryData<ImageCache>(cacheKey) ?? {};
        const missing = batch.filter((item) => {
          const entry = entries[item.id];
          return entry?.version !== item.variantVersion || entry.renewAt <= now;
        });
        if (missing.length) {
          const response = await getMediaImages(
            eventId,
            {
              mediaIds: missing.map((item) => item.id),
              size: 'thumbnail',
            },
            signal,
          );
          if (signal.aborted)
            throw Object.assign(new Error('Thumbnail request cancelled'), { name: 'AbortError' });
          client.setQueryData<ImageCache>(cacheKey, (current) => {
            const next = { ...current };
            for (const item of missing)
              next[item.id] = {
                version: item.variantVersion,
                image: response.images[item.id] ?? null,
                renewAt: now + RENEW_AFTER,
              };
            return next;
          });
          entries = client.getQueryData<ImageCache>(cacheKey) ?? {};
        }
        let renewAt = Infinity;
        for (const item of batch) {
          const entry = entries[item.id];
          if (entry?.version !== item.variantVersion) continue;
          renewAt = Math.min(renewAt, entry.renewAt);
        }
        return { renewAt };
      },
      // Reusing a cached URL must not restart its lifetime.
      staleTime: (query: Query<SignedBatch>) =>
        Math.max(0, (query.state.data?.renewAt ?? 0) - query.state.dataUpdatedAt),
      refetchInterval: (query: Query<SignedBatch>) =>
        query.state.status === 'error'
          ? 60_000
          : Math.max(1000, (query.state.data?.renewAt ?? Date.now() + RENEW_AFTER) - Date.now()),
      gcTime: 60 * 60 * 1000,
    })),
    combine,
  });
}
