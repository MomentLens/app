import type { EventSummary } from '@momentlens/shared-types';
import { useCallback } from 'react';

import { nextTimingChange } from '@/features/events/list';
import { useNow } from '@/hooks/use-now';

// The `now` the Events tab sorts by. It moves on when an event reaches its start or end, so an
// event changes tab while the list is open.
export function useTimingNow(events: readonly EventSummary[] | undefined): Date {
  return useNow(
    useCallback(
      (now: Date) => (events === undefined ? null : nextTimingChange(events, now)),
      [events],
    ),
  );
}
