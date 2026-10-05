import { useCallback, useEffect, useState } from 'react';
import { useAuthStore } from '@/stores/auth';
import { getQueue } from './queue';
import { queueCounts } from './store';
import type { QueueItem } from './types';

const EMPTY: QueueItem[] = [];
export function useQueue(eventId: string) {
  const userId = useAuthStore((state) => state.userId);
  const [snapshot, setSnapshot] = useState<{
    userId: string | null;
    eventId: string;
    items: QueueItem[];
    error: boolean;
  }>();
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    let alive = true;
    let request = 0;
    let unsubscribe: (() => void) | undefined;
    if (!userId) return undefined;
    const load = async () => {
      const serial = ++request;
      try {
        const store = await getQueue();
        if (!alive) return;
        if (!unsubscribe)
          unsubscribe = store.subscribe(() => {
            void load();
          });
        const items = await store.listForEvent(userId, eventId);
        if (alive && serial === request) setSnapshot({ userId, eventId, items, error: false });
      } catch {
        if (alive && serial === request)
          setSnapshot((previous) => ({
            userId,
            eventId,
            items:
              previous?.userId === userId && previous.eventId === eventId ? previous.items : [],
            error: true,
          }));
      }
    };
    void load();
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [userId, eventId, version]);
  // An account switch hides the previous account's rows in the same render, before any effect.
  const current =
    snapshot?.userId === userId && snapshot.eventId === eventId ? snapshot : undefined;
  const items = current?.items ?? EMPTY;
  return {
    userId,
    items,
    counts: queueCounts(items),
    loading: userId !== null && !current,
    error: current?.error ?? false,
    reload,
  };
}
