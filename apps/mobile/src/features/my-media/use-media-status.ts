import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { recheckEvent } from '@/features/event-shell/use-event';
import { getQueue } from '@/features/upload-queue/queue';
import { ApiError, getMediaStatus } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { refreshMediaStatus } from './status';

export function useMediaStatus(userId: string | null, eventId: string) {
  const active = useRef(false);
  const flight = useRef<AbortController | null>(null);
  const [error, setError] = useState(false);
  const refresh = useCallback(
    async (all = false) => {
      if (!userId || !active.current) return;
      flight.current?.abort();
      const controller = new AbortController();
      flight.current = controller;
      const current = () =>
        !controller.signal.aborted && active.current && useAuthStore.getState().userId === userId;
      try {
        const queue = await getQueue();
        await refreshMediaStatus(
          queue,
          userId,
          eventId,
          all,
          (mediaIds) => getMediaStatus(eventId, { mediaIds }, controller.signal),
          current,
        );
        if (current()) setError(false);
      } catch (problem) {
        if (!current()) return;
        setError(true);
        if (problem instanceof ApiError && (problem.status === 403 || problem.status === 404))
          recheckEvent(eventId);
      }
    },
    [userId, eventId],
  );
  useFocusEffect(
    useCallback(() => {
      active.current = true;
      void refresh();
      const stopAuth = useAuthStore.subscribe((state) => {
        if (state.userId !== userId) flight.current?.abort();
      });
      return () => {
        active.current = false;
        flight.current?.abort();
        stopAuth();
      };
    }, [refresh, userId]),
  );
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && active.current) void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);
  return { refresh, error };
}
