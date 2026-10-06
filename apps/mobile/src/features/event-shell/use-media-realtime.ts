import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { applyMediaChange } from '@/features/my-media/status';
import { getQueue } from '@/features/upload-queue/queue';
import { queryClient } from '@/lib/query-client';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/auth';

interface MediaRowPayload {
  id: string;
  event_id: string;
  uploader_user_id: string;
  processed_at: string | null;
  deleted_at: string | null;
}

// A burst of photos arrives as a burst of changes. The album's loaded pages refetch once the
// changes pause for QUIET_MS, and at least every MAX_WAIT_MS while they keep coming, rather than
// once per change, each of which would cancel the refetch before it.
const QUIET_MS = 1000;
const MAX_WAIT_MS = 4000;

// realtime-js hands back the channel already on a topic until its leave completes, so a remount
// inside that window would reuse a channel that is about to close. Each mount takes its own topic.
let channelCount = 0;

// Opens one Realtime channel on `media` per open event in the Event shell (D-148).
// Filtered on event_id, removed on unmount and logout.
// Updates Home's album queries and My Media's queue status badges live (D-145, D-148).
// Refetches loaded pages on reconnect and on app foreground.
export function useMediaRealtime(eventId: string) {
  const currentUserId = useAuthStore((state) => state.userId);

  useEffect(() => {
    if (!eventId) return;

    let refetchTimer: ReturnType<typeof setTimeout> | undefined;
    let firstPendingAt: number | null = null;

    function refetchAlbum() {
      if (refetchTimer !== undefined) clearTimeout(refetchTimer);
      refetchTimer = undefined;
      firstPendingAt = null;
      void queryClient.invalidateQueries({ queryKey: ['album', eventId] });
      void queryClient.invalidateQueries({ queryKey: ['uploaders', eventId] });
    }

    function scheduleRefetch() {
      const now = Date.now();
      firstPendingAt ??= now;
      if (refetchTimer !== undefined) clearTimeout(refetchTimer);
      const wait = Math.max(0, Math.min(QUIET_MS, firstPendingAt + MAX_WAIT_MS - now));
      refetchTimer = setTimeout(refetchAlbum, wait);
    }

    async function handleMediaPayload(payload: RealtimePostgresChangesPayload<MediaRowPayload>) {
      scheduleRefetch();

      if (!currentUserId) return;
      const row = payload.eventType === 'DELETE' ? null : payload.new;
      const mediaId =
        payload.eventType === 'DELETE' ? (payload.old as Partial<MediaRowPayload>).id : row?.id;
      if (!mediaId) return;

      try {
        await applyMediaChange(
          await getQueue(),
          currentUserId,
          eventId,
          {
            mediaId,
            row:
              row === null
                ? null
                : {
                    uploaderUserId: row.uploader_user_id,
                    processedAt: row.processed_at,
                    deletedAt: row.deleted_at,
                  },
          },
          // A change that lands after this account signed out must not touch its queue.
          () => useAuthStore.getState().userId === currentUserId,
        );
      } catch (err) {
        console.warn('Realtime queue update error', err);
      }
    }

    let subscribedOnce = false;
    channelCount += 1;
    const channel = supabase
      .channel(`media:event:${eventId}:${channelCount}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'media',
          filter: `event_id=eq.${eventId}`,
        },
        (payload) => {
          void handleMediaPayload(
            payload as unknown as RealtimePostgresChangesPayload<MediaRowPayload>,
          );
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          // A rejoin after a dropped connection may have missed changes.
          if (subscribedOnce) refetchAlbum();
          subscribedOnce = true;
        }
      });

    // Refetch on foreground
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refetchAlbum();
    });

    return () => {
      if (refetchTimer !== undefined) clearTimeout(refetchTimer);
      appStateSub.remove();
      void supabase.removeChannel(channel);
    };
  }, [eventId, currentUserId]);
}
