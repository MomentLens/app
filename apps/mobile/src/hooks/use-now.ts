import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

// setTimeout keeps its delay in a signed 32-bit number, so a longer wait fires early and just
// sets the next timer.
const MAX_TIMER_MS = 2 ** 31 - 1;
// A timer can fire a moment before its time; landing just after the boundary moves the screen on
// the first try.
const PAST_BOUNDARY_MS = 50;

// A `now` for a screen whose content changes at known instants, such as an event's start or a
// sub-event's end. It moves on at `nextChange(now)`, when the screen comes back into view and when
// the app returns to the foreground, with no polling in between. `nextChange` answers null when
// nothing changes again; keep it stable with useCallback, since a new one resets the timer.
export function useNow(nextChange: (now: Date) => Date | null): Date {
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
    const next = nextChange(now);
    if (next === null) return undefined;
    const delay = Math.min(
      Math.max(next.getTime() - Date.now(), 0) + PAST_BOUNDARY_MS,
      MAX_TIMER_MS,
    );
    const timer = setTimeout(() => setNow(new Date()), delay);
    return () => clearTimeout(timer);
  }, [nextChange, now]);

  return now;
}
