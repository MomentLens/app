import { useEffect, useState } from 'react';

import { getGpsReadings, getQrScans, getQueue } from '@/features/upload-queue/queue';
import { useSubEvents } from '@/features/schedule/use-sub-events';
import { useAuthStore } from '@/stores/auth';

const EMPTY: string[] = [];

export function useHeldReadings(eventId: string): readonly string[] {
  const userId = useAuthStore((state) => state.userId);
  const subEvents = useSubEvents(eventId).data?.subEvents;
  const [snapshot, setSnapshot] = useState<{
    userId: string;
    eventId: string;
    subEventIds: string[];
  }>();
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    let serial = 0;
    let unsubscribe: (() => void) | undefined;
    const load = async () => {
      const request = ++serial;
      try {
        const store = await getQueue();
        if (!alive) return;
        unsubscribe ??= store.subscribe(() => {
          void load();
        });
        const readings = await (
          await getGpsReadings()
        ).list(
          userId,
          eventId,
          subEvents?.map((sub) => sub.id),
        );
        const scans = await (await getQrScans()).list(userId, eventId, subEvents);
        if (alive && serial === request)
          setSnapshot({
            userId,
            eventId,
            subEventIds: [...new Set([...readings, ...scans].map((record) => record.subEventId))],
          });
      } catch {
        // A failed local read leaves the check-in notice visible; the queue never loses a photo.
      }
    };
    void load();
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [userId, eventId, subEvents]);
  return snapshot?.userId === userId && snapshot.eventId === eventId ? snapshot.subEventIds : EMPTY;
}
