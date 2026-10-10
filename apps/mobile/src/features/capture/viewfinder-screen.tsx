import {
  currentSubEvent,
  type GetEventResponse,
  type ListSubEventsResponse,
  type SubEvent,
} from '@momentlens/shared-types';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { isDevice } from 'expo-device';
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
import { eventQueryKey, lostAccess, useEvent } from '@/features/event-shell/use-event';
import { nextStatusChange } from '@/features/schedule/schedule';
import { subEventsQueryKey, useSubEvents } from '@/features/schedule/use-sub-events';
import { queryClient } from '@/lib/query-client';
import { useNow } from '@/hooks/use-now';
import { useAuthStore } from '@/stores/auth';
import {
  admitShot,
  fitPreview,
  matchesShape,
  nativePictureSize,
  type CaptureMode,
} from './context';
import { CameraReadiness } from './camera-readiness';
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
const IOS_SIMULATOR = Platform.OS === 'ios' && !isDevice;
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
  const currentSize = useRef<string | null>(null);
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
  const focusedRef = useRef(false);
  const readiness = useRef(new CameraReadiness());
  const cameraGeneration = useRef(0);
  const preparing = useRef<number | null>(null);
  const markReady = useCallback((value: boolean) => {
    readiness.current.setReady(value);
    setReady(value);
  }, []);
  const bindCamera = useCallback(
    (view: CameraView | null) => {
      camera.current = view;
      if (!view) {
        cameraGeneration.current++;
        markReady(false);
      }
    },
    [markReady],
  );
  const lastCaptureSubEvent = useRef<string | null>(null);
  const close = useCallback(() => {
    router.dismissTo({
      pathname: '/event/[id]/media',
      params: {
        id: eventId,
        captureSubEventId: live?.id ?? lastCaptureSubEvent.current ?? undefined,
      },
    });
  }, [router, eventId, live?.id]);
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      setFocused(true);
      return () => {
        focusedRef.current = false;
        cameraGeneration.current++;
        readiness.current.cancel();
        setReady(false);
        setFocused(false);
      };
    }, []),
  );
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setActive(state === 'active');
      if (state !== 'active') {
        markReady(false);
        cameraGeneration.current++;
      }
    });
    return () => subscription.remove();
  }, [markReady]);
  useEffect(() => {
    const gate = readiness.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      gate.cancel();
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

  useEffect(() => {
    if (!permission?.granted || !accessible || !schedule.data) {
      cameraGeneration.current++;
      readiness.current.cancel();
    }
  }, [permission?.granted, accessible, schedule.data]);
  const controller = useRef<ReturnType<typeof captureController> | null>(null);
  useEffect(() => {
    controller.current = captureController(async () => {
      if (!mounted.current || !focusedRef.current)
        throw new Error('The camera closed before it could take the photo.');
      // Gallery permission can pause the camera after the shutter admits this shot.
      await readiness.current.wait();
      const selectedCamera = camera.current;
      const selectedSize = currentSize.current;
      if (
        !mounted.current ||
        !focusedRef.current ||
        !readiness.current.isReady() ||
        !selectedCamera ||
        !selectedSize ||
        useAuthStore.getState().userId !== owner
      )
        throw new Error('The camera is no longer ready to take this photo.');
      const photo = await selectedCamera.takePictureAsync({ quality: 1, exif: true });
      if (!photo) throw new Error('The camera could not take the photo.');
      if (!matchesShape(selectedSize, photo.width, photo.height))
        throw new Error(
          `This camera output (${photo.width}x${photo.height}) does not match its preview bounds (${selectedSize}). Please report these dimensions.`,
        );
      return photo.uri;
    });
  }, [owner]);
  async function shutter() {
    if (
      shooting.current ||
      !readiness.current.isReady() ||
      !focused ||
      !active ||
      !controller.current
    )
      return;
    if (useAuthStore.getState().userId !== owner) return;
    // Re-read account and schedule for admission. The controller retains this shot's context.
    const scheduleKey = subEventsQueryKey(eventId);
    const eventKey = eventQueryKey(eventId);
    const currentSchedule =
      queryClient.getQueryData<ListSubEventsResponse>(scheduleKey)?.subEvents ?? [];
    const currentEvent = queryClient.getQueryData<GetEventResponse>(eventKey);
    const accessibleNow =
      currentEvent?.event.id === eventId &&
      !lostAccess(queryClient.getQueryState(eventKey)?.error) &&
      !lostAccess(queryClient.getQueryState(scheduleKey)?.error);
    const shot = admitShot(
      useAuthStore.getState().userId,
      eventId,
      currentSchedule,
      useCaptureMode.getState().mode,
      new Date(),
      accessibleNow,
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
      lastCaptureSubEvent.current = shot.subEventId;
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
    const selectedCamera = camera.current;
    if (!selectedCamera || !focusedRef.current || preparing.current === generation) return;
    preparing.current = generation;
    try {
      const native =
        Platform.OS === 'ios'
          ? await cameraStillSize(selected === 'front')
          : (size ?? nativePictureSize(await selectedCamera.getAvailablePictureSizesAsync()));
      if (
        !mounted.current ||
        generation !== cameraGeneration.current ||
        selectedCamera !== camera.current
      )
        return;
      if (!native) throw new Error('The camera did not report its photo dimensions.');
      currentSize.current = native;
      setSize(native);
      // Android binds the chosen output on this same native view, then reports readiness again.
      if (Platform.OS === 'ios' || size) markReady(true);
      setProblem(undefined);
    } catch {
      if (mounted.current && generation === cameraGeneration.current) {
        markReady(false);
        readiness.current.cancel();
        setProblem('The camera could not prepare its photo size. Close it and try again.');
      }
    } finally {
      if (preparing.current === generation) preparing.current = null;
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
      {IOS_SIMULATOR ? (
        <View className="items-center gap-3 px-8">
          <Glyph name={{ ios: 'camera', android: 'photo_camera' }} tone="onPhoto" size={32} />
          <Text className="text-center font-h2 text-h2 text-onPhoto">Use a physical iPhone</Text>
          <Text className="text-center font-body text-body text-onPhoto">
            The iOS Simulator has no camera. You can inspect the controls here, but photo capture
            and framing need a physical iPhone.
          </Text>
        </View>
      ) : permission?.granted && focused && active && accessible && schedule.data ? (
        <GestureDetector gesture={swipe}>
          <View style={frame}>
            <CameraView
              ref={bindCamera}
              style={{ width: '100%', height: '100%', opacity: size ? 1 : 0 }}
              facing={facing}
              mode="picture"
              pictureSize={Platform.OS === 'ios' ? 'Photo' : (size ?? undefined)}
              // Android applies ratio alongside pictureSize, despite the prop docs.
              ratio={Platform.OS === 'android' ? '4:3' : undefined}
              mirror={false}
              flash="off"
              autofocus="on"
              onCameraReady={() => void cameraReady()}
              onMountError={() => {
                cameraGeneration.current++;
                markReady(false);
                readiness.current.cancel();
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
        ready={ready && focused && active && accessible && Boolean(live)}
        top={insets.top}
        bottom={insets.bottom}
        onClose={close}
        onShutter={() => void shutter()}
        onMode={setMode}
        onFlip={() => {
          if (shooting.current || !readiness.current.isReady()) return;
          cameraGeneration.current++;
          markReady(false);
          currentSize.current = null;
          setSize(null);
          setFacing((value) => (value === 'back' ? 'front' : 'back'));
        }}
      />
    </>
  );
}
