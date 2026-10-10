import { currentSubEvent, type SubEvent } from '@momentlens/shared-types';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useFocusEffect, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Platform,
  Pressable,
  Text,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { cameraStillSize } from '../../../modules/local-media';
import { Glyph } from '@/components/ui/glyph';
import { lostAccess, useEvent } from '@/features/event-shell/use-event';
import { nextStatusChange } from '@/features/schedule/schedule';
import { useSubEvents } from '@/features/schedule/use-sub-events';
import { useNow } from '@/hooks/use-now';
import { useAuthStore } from '@/stores/auth';
import { admitShot, fitPreview, nativePictureSize, type CaptureMode } from './context';
import { useCaptureMode } from './mode-store';
import {
  captureController,
  getCaptures,
  hasLocalNotice,
  readStartingMode,
  rememberLocalNotice,
} from './runtime';
import type { SessionPhoto } from './session-stack';
import Viewfinder from './viewfinder';

const EMPTY: SubEvent[] = [];
export function ViewfinderScreen({ eventId }: { eventId: string }) {
  const owner = useAuthStore((state) => state.userId);
  return <CameraSession key={`${owner}/${eventId}`} owner={owner} eventId={eventId} />;
}
function CameraSession({ owner, eventId }: { owner: string | null; eventId: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const event = useEvent(eventId);
  const schedule = useSubEvents(eventId);
  const subs = schedule.data?.subEvents ?? EMPTY;
  const nextChange = useCallback((at: Date) => nextStatusChange(subs, at), [subs]);
  const now = useNow(nextChange);
  const live = currentSubEvent(subs, now);
  const accessible = Boolean(
    owner && event.data && !lostAccess(event.error) && !lostAccess(schedule.error),
  );
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [facing, setFacing] = useState<'back' | 'front'>('back');
  const [size, setSize] = useState<string | null>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const [problem, setProblem] = useState<string>();
  const [photos, setPhotos] = useState<SessionPhoto[]>([]);
  const mode = useCaptureMode((state) => state.mode);
  const mounted = useRef(true);
  const shooting = useRef(false);
  const cameraGeneration = useRef(0);
  const close = useCallback(() => {
    router.dismissTo({ pathname: '/event/[id]/media', params: { id: eventId } });
  }, [router, eventId]);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setActive(state === 'active');
      if (state !== 'active') {
        setReady(false);
        cameraGeneration.current++;
      }
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const setMode = useCallback(
    (next: CaptureMode) => {
      if (!owner || useAuthStore.getState().userId !== owner) return;
      if (next === 'local_only' && !hasLocalNotice(owner)) {
        Alert.alert(
          'Keep photos on this phone?',
          'Local Only photos stay inside MomentLens. They do not appear in your gallery, cannot become Public, and are lost if you uninstall the app.',
          [
            {
              text: 'Cancel',
              style: 'cancel',
              onPress: () => {
                if (useAuthStore.getState().userId === owner)
                  useCaptureMode.getState().setMode('public');
              },
            },
            {
              text: 'Use Local Only',
              onPress: () => {
                if (useAuthStore.getState().userId !== owner) return;
                rememberLocalNotice(owner);
                useCaptureMode.getState().setMode('local_only');
              },
            },
          ],
        );
        return;
      }
      useCaptureMode.getState().setMode(next);
    },
    [owner],
  );
  useEffect(() => {
    useCaptureMode.getState().setMode('public');
    setMode(readStartingMode());
  }, [setMode]);
  useEffect(() => {
    if (
      !owner ||
      lostAccess(event.error) ||
      lostAccess(schedule.error) ||
      (accessible && schedule.data && !live && !busy)
    )
      close();
  }, [owner, accessible, schedule.data, schedule.error, event.error, live, busy, close]);

  const currentSize = useRef(size);
  useEffect(() => {
    currentSize.current = size;
  }, [size]);
  const controller = useRef<ReturnType<typeof captureController> | null>(null);
  useEffect(() => {
    controller.current = captureController(async () => {
      const photo = await camera.current?.takePictureAsync({ quality: 1, exif: true });
      if (!photo) throw new Error('The camera could not take the photo.');
      const [w, h] = currentSize.current!.split('x').map(Number);
      const ratio = Math.min(photo.width, photo.height) / Math.max(photo.width, photo.height);
      const expected = Math.min(w!, h!) / Math.max(w!, h!);
      if (Math.abs(ratio - expected) > 0.005)
        throw new Error(
          'This camera output does not match its preview bounds. Please report this phone model.',
        );
      return photo.uri;
    });
  }, []);
  async function shutter() {
    if (shooting.current || !ready || !focused || !active || !controller.current) return;
    // Re-read account and schedule for admission. The controller retains this shot's context.
    const shot = admitShot(
      useAuthStore.getState().userId,
      eventId,
      subs,
      useCaptureMode.getState().mode,
      new Date(),
      accessible,
    );
    if (!shot) {
      close();
      return;
    }
    if (shot.mode === 'local_only' && !hasLocalNotice(shot.userId)) {
      setMode('local_only');
      return;
    }
    shooting.current = true;
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await controller.current!.capture(shot);
      if (!mounted.current || useAuthStore.getState().userId !== owner) return;
      const uri = await (
        await getCaptures()
      )
        .thumbnailUri(shot.userId, result.id)
        .catch(() => null);
      if (uri && mounted.current) setPhotos((items) => [...items, { id: result.id, uri }]);
      if (shot.mode === 'public' && !result.queued)
        setProblem(
          'Photo saved on this phone. Open My Media to finish adding it before it uploads.',
        );
    } catch (error) {
      if (mounted.current && useAuthStore.getState().userId === owner)
        setProblem(
          error instanceof Error
            ? error.message
            : 'The photo could not be saved. Check free space and try again.',
        );
    } finally {
      shooting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function cameraReady() {
    const selected = facing;
    const generation = cameraGeneration.current;
    try {
      const native =
        Platform.OS === 'ios'
          ? await cameraStillSize(selected === 'front')
          : (size ?? nativePictureSize(await camera.current!.getAvailablePictureSizesAsync()));
      if (!mounted.current || generation !== cameraGeneration.current) return;
      if (!native) throw new Error('The camera did not report its photo dimensions.');
      setSize(native);
      // Android remounts once with the selected output size before enabling the shutter.
      if (Platform.OS === 'ios' || size) setReady(true);
    } catch {
      if (mounted.current)
        setProblem(
          'The camera could not prepare its native framing. Rebuild the app and try again.',
        );
    }
  }
  const swipe = Gesture.Pan()
    .activeOffsetX([-35, 35])
    .failOffsetY([-25, 25])
    .onEnd((e) => {
      if (Platform.OS === 'ios')
        scheduleOnRN(setMode, e.translationX < 0 ? 'local_only' : 'public');
    });
  const frame =
    size && bounds.width && bounds.height ? fitPreview(size, bounds.width, bounds.height) : bounds;
  const preview = (
    <View
      className="h-full w-full items-center justify-center"
      onLayout={(e) => setBounds(e.nativeEvent.layout)}>
      {permission?.granted && focused && active && accessible && schedule.data ? (
        <GestureDetector gesture={swipe}>
          <View style={frame}>
            <CameraView
              key={`${facing}/${Platform.OS === 'android' ? (size ?? '') : ''}`}
              ref={camera}
              style={{ width: '100%', height: '100%', opacity: size ? 1 : 0 }}
              facing={facing}
              mode="picture"
              pictureSize={Platform.OS === 'ios' ? 'Photo' : (size ?? undefined)}
              mirror={false}
              flash="off"
              autofocus="on"
              onCameraReady={() => void cameraReady()}
              onMountError={() => {
                setReady(false);
                setProblem('The camera could not start. Close it and try again.');
              }}
            />
            {mode === 'local_only' ? (
              <View pointerEvents="none" className="absolute left-0 right-0 top-4 items-center">
                <View className="flex-row items-center gap-2 rounded-full bg-scrim/70 px-4 py-2">
                  <Glyph name={{ ios: 'lock.fill', android: 'lock' }} tone="onPhoto" size={15} />
                  <Text className="font-fieldLabel text-fieldLabel text-onPhoto">Local Only</Text>
                </View>
              </View>
            ) : null}
          </View>
        </GestureDetector>
      ) : (
        <View className="items-center gap-4 px-8">
          {!permission || event.isPending || schedule.isPending ? (
            <ActivityIndicator className="text-onPhoto" />
          ) : (
            <>
              <Text className="text-center font-body text-body text-onPhoto">
                {!permission.granted
                  ? 'Allow camera access to take photos.'
                  : 'The event or schedule could not be loaded.'}
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  if (!permission.granted)
                    void (
                      permission.canAskAgain ? requestPermission() : Linking.openSettings()
                    ).catch(() => setProblem('Camera access could not be requested. Try again.'));
                  else {
                    void event.refetch();
                    void schedule.refetch();
                  }
                }}
                className="min-h-12 justify-center rounded-full bg-onPhoto/15 px-6">
                <Text className="font-buttonLabel text-buttonLabel text-onPhoto">
                  {!permission.granted
                    ? permission.canAskAgain
                      ? 'Allow camera'
                      : 'Open Settings'
                    : 'Try again'}
                </Text>
              </Pressable>
            </>
          )}
        </View>
      )}
      {problem ? (
        <View className="absolute bottom-2 left-4 right-4 rounded-2xl bg-scrim/85 px-4 py-3">
          <Text
            accessibilityLiveRegion="polite"
            className="text-center font-bodySecondary text-bodySecondary text-onPhoto">
            {problem}
          </Text>
        </View>
      ) : null}
    </View>
  );
  return (
    <>
      <StatusBar style="light" />
      <Viewfinder
        name={live?.name ?? 'Camera'}
        preview={preview}
        mode={mode}
        photos={photos}
        busy={busy}
        ready={ready && accessible && Boolean(live)}
        top={insets.top}
        bottom={insets.bottom}
        onClose={close}
        onShutter={() => void shutter()}
        onMode={setMode}
        onFlip={() => {
          if (shooting.current) return;
          cameraGeneration.current++;
          setReady(false);
          setSize(null);
          setFacing((value) => (value === 'back' ? 'front' : 'back'));
        }}
      />
    </>
  );
}
