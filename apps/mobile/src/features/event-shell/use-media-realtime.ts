import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { getQueue } from '@/features/upload-queue/queue';
import { queryClient } from '@/lib/query-client';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/auth';

interface MediaRowPayload {
  id: string;
  event_id: string;
  uploader_user_id: string;
  sub_event_id: string;
  captured_at: string;
  uploader_role_at_upload: string;
  processed_at: string | null;
  deleted_at: string | null;
  variant_version: number;
}

// Opens one Realtime channel on `media` per open event in the Event shell (D-148).
// Filtered on event_id, removed on unmount / logout.
// Updates Home's album queries and My Media's queue status badges live (D-145, D-148).
// Refetches loaded pages on reconnect and on app foreground.
export function useMediaRealtime(eventId: string) {
  const currentUserId = useAuthStore((state) => state.userId);
  const reconnectedRef = useRef(false);

  useEffect(() => {
    if (!eventId) return;

    async function handleMediaPayload(payload: RealtimePostgresChangesPayload<MediaRowPayload>) {
      // Invalidate album and uploaders queries so Home refetches fresh data
      void queryClient.invalidateQueries({ queryKey: ['album', eventId] });
      void queryClient.invalidateQueries({ queryKey: ['uploaders', eventId] });

      // If this change concerns the current signed-in user's upload, update My Media's queue
      if (!currentUserId) return;

      const mediaId =
        payload.eventType === 'DELETE'
          ? (payload.old as Partial<MediaRowPayload>)?.id
          : payload.new?.id;

      if (!mediaId) return;

      try {
        const queue = await getQueue();
        const items = await queue.listForEvent(currentUserId, eventId);
        const item = items.find(
          (candidate) => candidate.mediaId?.toLowerCase() === mediaId.toLowerCase(),
        );

        if (!item) return;

        if (payload.eventType === 'DELETE') {
          await queue.remove(currentUserId, item.id);
          return;
        }

        const row = payload.new;
        if (row.deleted_at !== null) {
          await queue.remove(currentUserId, item.id);
        } else if (row.processed_at !== null) {
          if (item.state !== 'published') {
            await queue.update(currentUserId, item.id, { state: 'published' });
          }
        } else {
          // Processed cleared
          if (item.state === 'published') {
            await queue.update(currentUserId, item.id, { state: 'uploaded' });
          }
        }
      } catch (err) {
        // Queue access error ignored
        console.warn('Realtime queue update error', err);
      }
    }

    const channelName = `media:event:${eventId}`;
    const channel = supabase
      .channel(channelName)
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
          if (reconnectedRef.current) {
            void queryClient.invalidateQueries({ queryKey: ['album', eventId] });
          }
          reconnectedRef.current = true;
        }
      });

    // Refetch on foreground
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void queryClient.invalidateQueries({ queryKey: ['album', eventId] });
      }
    });

    return () => {
      appStateSub.remove();
      void supabase.removeChannel(channel);
    };
  }, [eventId, currentUserId]);
}
