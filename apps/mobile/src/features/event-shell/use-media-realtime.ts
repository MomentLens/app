import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { albumStatusQueryKey } from '@/features/album/use-album-switch';
import { recheckEvent } from '@/features/event-shell/use-event';
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

// Opens one Realtime channel per open event in the Event shell, carrying a `media` listener filtered
// on event_id and an `event` listener on the event's own row (D-148, D-161). Removed on unmount and
// logout.
// - `media` updates Home's album queries and My Media's queue status badges live (D-145, D-148).
// - `event` refetches GET /events/{eventId} and the Admin's album status, and never writes the
//   cache itself: only the API's answer releases waiting_album photos (arch §4.3). A soft delete
//   reaches the phone this way too, and the refetch shows the event's 404 state.
// Both refetch on reconnect, and the album's pages on app foreground; the event query refetches on
// foreground by itself.
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
      void queryClient.invalidateQueries({ queryKey: albumStatusQueryKey(eventId), exact: true });
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

    function refetchEvent() {
      recheckEvent(eventId);
      void queryClient.invalidateQueries({ queryKey: albumStatusQueryKey(eventId), exact: true });
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
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'event', filter: `id=eq.${eventId}` },
        refetchEvent,
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          // A rejoin after a dropped connection may have missed changes.
          if (subscribedOnce) {
            refetchAlbum();
            refetchEvent();
          }
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
