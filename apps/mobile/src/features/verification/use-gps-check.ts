import * as Location from 'expo-location';
import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { createMMKV } from 'react-native-mmkv';

import { useEvent } from '@/features/event-shell/use-event';
import { nextStatusChange } from '@/features/schedule/schedule';
import { useSubEvents } from '@/features/schedule/use-sub-events';
import { getGpsReadings, getQueue, release } from '@/features/upload-queue/queue';
import { useNow } from '@/hooks/use-now';
import { useAuthStore } from '@/stores/auth';
import { GpsCheck, type GpsContext } from './gps-check';

const preferences = createMMKV({ id: 'device-preferences' });
const ASKED = 'locationVerificationPermissionAsked';
export const GPS_CHECK_INTERVAL_MS = 60_000;
const EMPTY: GpsContext['subEvents'] = [];

// One foreground checker per open event. Cached server state and the SQLite fixes decide when
// it stops; a new sub-event, a consumed fix or a fresh schedule starts it again (D-155).
export function useGpsCheck(eventId: string): void {
  const userId = useAuthStore((state) => state.userId);
  const event = useEvent(eventId);
  const schedule = useSubEvents(eventId);
  const subEvents = schedule.data?.subEvents ?? EMPTY;
  const nextChange = useCallback((at: Date) => nextStatusChange(subEvents, at), [subEvents]);
  const now = useNow(nextChange);
  const context = useRef<GpsContext>({ eventId, verification: undefined, subEvents: EMPTY });
  const wake = useRef<(force?: boolean) => void>(() => undefined);

  useEffect(() => {
    context.current = { eventId, verification: event.data?.verification, subEvents };
  }, [eventId, event.data?.verification, subEvents]);

  useEffect(() => {
    if (!userId) return;
    const checker = new GpsCheck({
      userId: () => useAuthStore.getState().userId,
      active: () => AppState.currentState === 'active',
      context: () => context.current,
      readings: getGpsReadings,
      permission: Location.getForegroundPermissionsAsync,
      requestPermission: Location.requestForegroundPermissionsAsync,
      asked: () => preferences.getBoolean(ASKED) === true,
      markAsked: () => preferences.set(ASKED, true),
      position: () =>
        Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
          mayShowUserSettingsDialog: false,
        }),
      release: async (owner, id, subEventIds) => {
        await release(owner, id, 'waiting_verification', subEventIds);
      },
      now: Date.now,
    });
    let disposed = false;
    let busy = false;
    let again = false;
    let forceNext = false;
    let lastAttempt: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;

    function clearTimer() {
      clearTimeout(timer);
      timer = undefined;
    }
    function reconsider(force = false) {
      if (disposed) return;
      forceNext ||= force;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      again = false;
      clearTimer();
      const forced = forceNext;
      forceNext = false;
      void (async () => {
        if (!(await checker.pending()) || disposed) return;
        const delay =
          forced || lastAttempt === null
            ? 0
            : Math.max(0, lastAttempt + GPS_CHECK_INTERVAL_MS - Date.now());
        if (delay > 0) {
          timer = setTimeout(reconsider, delay);
          return;
        }
        lastAttempt = Date.now();
        try {
          await checker.run();
        } catch {
          // Location disabled or unavailable leaves photos on the phone. No reading is logged.
        }
        if (!disposed && (await checker.pending()))
          timer = setTimeout(reconsider, GPS_CHECK_INTERVAL_MS);
      })()
        .catch(() => undefined)
        .finally(() => {
          busy = false;
          if (again && !disposed) reconsider();
        });
    }
    wake.current = reconsider;
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') reconsider(true);
      else clearTimer();
    });
    void getQueue()
      .then((store) => {
        if (!disposed) unsubscribe = store.subscribe(() => reconsider());
      })
      .catch(() => undefined);
    reconsider(true);
    return () => {
      disposed = true;
      checker.dispose();
      clearTimer();
      appState.remove();
      unsubscribe?.();
      wake.current = () => undefined;
    };
  }, [eventId, userId]);

  useEffect(() => {
    wake.current();
  }, [event.data?.verification, subEvents, now]);
}
