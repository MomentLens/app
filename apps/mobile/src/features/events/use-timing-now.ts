import type { EventSummary } from '@momentlens/shared-types';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { nextTimingChange } from '@/features/events/list';

// setTimeout keeps its delay in a signed 32-bit number, so a longer wait fires early and just
// sets the next timer.
const MAX_TIMER_MS = 2 ** 31 - 1;
// A timer can fire a moment before its time; landing just after the boundary puts the event in
// its new tab on the first try.
const PAST_BOUNDARY_MS = 50;

// The `now` the Events tab sorts by. It moves on when an event reaches its start or end, when the
// screen comes back into view and when the app returns to the foreground, so an event changes
// tab while the list is open, with no polling in between.
export function useTimingNow(events: readonly EventSummary[] | undefined): Date {
  const [now, setNow] = useState(() => new Date());

  useFocusEffect(
    useCallback(() => {
      setNow(new Date());
    }, []),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') setNow(new Date());
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (events === undefined) return undefined;
    const next = nextTimingChange(events, now);
    if (next === null) return undefined;
    const delay = Math.min(
      Math.max(next.getTime() - Date.now(), 0) + PAST_BOUNDARY_MS,
      MAX_TIMER_MS,
    );
    const timer = setTimeout(() => setNow(new Date()), delay);
    return () => clearTimeout(timer);
  }, [events, now]);

  return now;
}
