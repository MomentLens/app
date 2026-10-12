import { subEventStatus, type SubEvent } from '@momentlens/shared-types';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Platform,
  Pressable,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { GLYPH, Glyph } from '@/components/ui/glyph';
import { lostAccess, useEvent } from '@/features/event-shell/use-event';
import { nextStatusChange } from '@/features/schedule/schedule';
import { useSubEvents } from '@/features/schedule/use-sub-events';
import { getQrScans, release } from '@/features/upload-queue/queue';
import { useNow } from '@/hooks/use-now';
import { useAuthStore } from '@/stores/auth';
import { selectVenueScan } from './qr-scans';

const EMPTY: SubEvent[] = [];
export function ScanVenueScreen({ eventId }: { eventId: string }) {
  const owner = useAuthStore((state) => state.userId);
  return <Scanner key={`${owner}/${eventId}`} owner={owner} eventId={eventId} />;
}
function Scanner({ owner, eventId }: { owner: string | null; eventId: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const event = useEvent(eventId);
  const schedule = useSubEvents(eventId);
  const subs = schedule.data?.subEvents ?? EMPTY;
  const nextChange = useCallback((at: Date) => nextStatusChange(subs, at), [subs]);
  const now = useNow(nextChange);
  const live = subs.filter((sub) => subEventStatus(sub, now) === 'in_progress');
  const allowed = Boolean(
    owner &&
    event.data?.event.role === 'guest' &&
    !event.data.verification?.everySubEvent &&
    !lostAccess(event.error) &&
    !lostAccess(schedule.error),
  );
  const [permission, requestPermission, refreshPermission] = useCameraPermissions();
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [busy, setBusy] = useState(false);
  const [recorded, setRecorded] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [cameraFailed, setCameraFailed] = useState(false);
  const running = useRef(false);
  const saved = useRef(false);
  const mounted = useRef(true);
  const asked = useRef(false);
  const context = useRef({ allowed, subs, focused, active });
  useLayoutEffect(() => {
    context.current = { allowed, subs, focused, active };
  }, [allowed, subs, focused, active]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useFocusEffect(
    useCallback(() => {
      if (saved.current) {
        router.dismissTo({ pathname: '/event/[id]/media', params: { id: eventId } });
        return;
      }
      setFocused(true);
      return () => setFocused(false);
    }, [eventId, router]),
  );
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => {
      setActive(state === 'active');
      if (state === 'active')
        void refreshPermission().catch(() =>
          setProblem('Camera permission could not be read. Try again.'),
        );
    });
    return () => listener.remove();
  }, [refreshPermission]);
  useEffect(() => {
    if (
      !allowed ||
      !live.length ||
      !focused ||
      !active ||
      !permission ||
      permission.granted ||
      !permission.canAskAgain ||
      asked.current
    )
      return;
    asked.current = true;
    void requestPermission().catch(() =>
      setProblem('Camera permission could not be requested. Try again.'),
    );
  }, [allowed, live.length, focused, active, permission, requestPermission]);

  function current() {
    return (
      mounted.current &&
      useAuthStore.getState().userId === owner &&
      context.current.allowed &&
      context.current.active &&
      context.current.focused
    );
  }
  function close() {
    router.dismissTo({ pathname: '/event/[id]/media', params: { id: eventId } });
  }
  async function scan(data: string) {
    if (running.current || saved.current || !permission?.granted || !current()) return;
    running.current = true;
    setBusy(true);
    setProblem(undefined);
    const selected = selectVenueScan(data, context.current.subs, new Date(Date.now()));
    if (!selected) {
      setProblem("Use this event's venue code while a sub-event is live there.");
      running.current = false;
      setBusy(false);
      return;
    }
    try {
      const store = await getQrScans();
      if (!current() || !owner) return;
      const subEvent = await store.save(owner, eventId, selected.scan, context.current.subs);
      if (!current()) return;
      saved.current = true;
      setRecorded(true);
      // The scan is durable even if release fails. Startup retries that release (D-156).
      await release(owner, eventId, 'waiting_verification', [subEvent.id]).catch(() => undefined);
      if (current())
        router.push({
          pathname: '/scan-result/[eventId]',
          params: { eventId, subEventId: subEvent.id },
        });
    } catch {
      if (current())
        setProblem(
          saved.current
            ? 'Your check-in is saved on this phone. Return to My Media for its status.'
            : 'The scan could not be saved on this phone. Check free space and scan again. Your photos are still here.',
        );
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const canPreview =
    allowed && live.length > 0 && focused && active && permission?.granted && !cameraFailed;
  const venues = [...new Set(live.map((sub) => sub.venue.name))];
  return (
    <View className="flex-1 bg-scrim">
      <StatusBar style="light" />
      {canPreview ? (
        <CameraView
          style={{ position: 'absolute', width: '100%', height: '100%' }}
          facing="back"
          autofocus="on"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={busy || recorded || problem ? undefined : ({ data }) => void scan(data)}
          onMountError={() => {
            setCameraFailed(true);
            setProblem('The camera could not start. Close this screen and try again.');
          }}
        />
      ) : null}
      <View
        className="flex-1"
        style={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }}>
        <View className="h-16 flex-row items-center gap-3 px-4 ios:justify-center">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close scanner"
            onPress={close}
            className="h-12 w-12 items-center justify-center rounded-full ios:absolute ios:left-4 ios:border ios:border-onPhoto/20 ios:bg-scrim/30">
            <Glyph name={GLYPH.close} tone="onPhoto" />
          </Pressable>
          <View className="ios:rounded-full ios:border ios:border-onPhoto/20 ios:bg-scrim/30 ios:px-4 ios:py-2">
            <Text accessibilityRole="header" className="font-h2 text-h2 text-onPhoto">
              {Platform.OS === 'ios' ? 'Scan Venue QR' : 'Scan venue QR'}
            </Text>
          </View>
        </View>
        {event.isPending || schedule.isPending || !permission ? (
          <ActivityIndicator className="mt-16 text-onPhoto" />
        ) : !allowed || !live.length ? (
          <View className="gap-4 px-8 pt-12">
            <Text className="font-h2 text-h2 text-onPhoto">
              {!allowed
                ? 'Venue scanning is for Guests who need to check in'
                : 'No sub-event is live at this event'}
            </Text>
            <Text className="font-body text-body text-onPhoto">
              Return to My Media. Ask the organizer to check you in if your sub-event has ended.
            </Text>
            <Button label="Return to My Media" onPress={close} />
          </View>
        ) : !permission.granted ? (
          <View className="gap-4 px-8 pt-12">
            <Text className="font-h2 text-h2 text-onPhoto">
              Allow camera access to scan the venue code
            </Text>
            <Text className="font-body text-body text-onPhoto">
              Your waiting photos stay on this phone. You can also ask the organizer to check you
              in.
            </Text>
            <Button
              label={permission.canAskAgain ? 'Allow camera' : 'Open settings'}
              onPress={() => {
                void (permission.canAskAgain ? requestPermission() : Linking.openSettings()).catch(
                  () => setProblem('Settings could not be opened. Open them from your phone.'),
                );
              }}
            />
          </View>
        ) : (
          <View className="items-center gap-8 px-6 pt-12">
            <View className="rounded-full bg-onPhoto/90 px-4 py-3 android:rounded-xl android:bg-scrim/70">
              <Text className="text-center font-fieldLabel text-body ios:text-scrim android:text-onPhoto">
                Point at the code posted at {venues.join(' or ')}
              </Text>
            </View>
            <View
              accessibilityLabel="Place the venue QR inside this frame"
              style={{ width: '85%', maxWidth: 320, aspectRatio: 1 }}>
              <View className="absolute left-0 top-0 h-11 w-11 rounded-tl-3xl border-l-4 border-t-4 border-onPhoto" />
              <View className="absolute right-0 top-0 h-11 w-11 rounded-tr-3xl border-r-4 border-t-4 border-onPhoto" />
              <View className="absolute bottom-0 left-0 h-11 w-11 rounded-bl-3xl border-b-4 border-l-4 border-onPhoto" />
              <View className="absolute bottom-0 right-0 h-11 w-11 rounded-br-3xl border-b-4 border-r-4 border-onPhoto" />
              {busy ? (
                <ActivityIndicator
                  className="flex-1 text-onPhoto"
                  accessibilityLabel="Saving check-in"
                />
              ) : null}
            </View>
          </View>
        )}
        {problem ? (
          <View accessibilityLiveRegion="polite" className="mx-6 mt-6 rounded-2xl bg-scrim/80 p-4">
            <Text className="font-body text-body text-onPhoto">{problem}</Text>
            <View className="mt-3 self-start">
              <Button
                label={recorded ? 'Return to My Media' : 'Try again'}
                onPress={
                  recorded
                    ? close
                    : () => {
                        setProblem(undefined);
                        setCameraFailed(false);
                      }
                }
              />
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}
