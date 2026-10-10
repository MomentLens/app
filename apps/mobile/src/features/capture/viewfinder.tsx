import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Glyph, GLYPH } from '@/components/ui/glyph';
import { PreviewArea, Shutter } from './camera-controls';
import type { CaptureMode } from './context';
import { SessionStack, type SessionPhoto } from './session-stack';

export interface ViewfinderProps {
  name: string;
  preview: ReactNode;
  mode: CaptureMode;
  photos: SessionPhoto[];
  // Counts the photos the camera has taken this session, so the preview blinks on each one.
  shots: number;
  busy: boolean;
  ready: boolean;
  top: number;
  bottom: number;
  onClose: () => void;
  onShutter: () => void;
  onFlip: () => void;
  onMode: (mode: CaptureMode) => void;
}
export const FLIP = {
  ios: 'arrow.triangle.2.circlepath.camera',
  android: 'flip_camera_android',
} as const;
// Pixel Camera's layout (D-134): close and the name at the top, the preview under them, flip
// leading and the session stack trailing the shutter, and the Public / Local Only pill below.
export default function Viewfinder(p: ViewfinderProps) {
  return (
    <View className="flex-1 bg-scrim" style={{ paddingTop: p.top, paddingBottom: p.bottom }}>
      <View className="h-16 flex-row items-center gap-3 px-4">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close camera"
          onPress={p.onClose}
          className="h-12 w-12 items-center justify-center rounded-2xl bg-onPhoto/10">
          <Glyph name={GLYPH.close} tone="onPhoto" />
        </Pressable>
        <Text numberOfLines={1} className="flex-1 font-fieldLabel text-fieldLabel text-onPhoto">
          {p.name}
        </Text>
      </View>
      <PreviewArea preview={p.preview} shots={p.shots} />
      <View className="h-28 flex-row items-center justify-between px-8">
        <Pressable
          disabled={p.busy || !p.ready}
          accessibilityRole="button"
          accessibilityLabel="Flip camera"
          onPress={p.onFlip}
          className="h-14 w-14 items-center justify-center rounded-2xl bg-onPhoto/10">
          <Glyph name={FLIP} size={28} tone="onPhoto" />
        </Pressable>
        <Shutter busy={p.busy} ready={p.ready} onPress={p.onShutter} />
        <SessionStack photos={p.photos} onPress={p.onClose} round={false} />
      </View>
      <View className="h-20 items-center justify-center">
        <View className="flex-row rounded-full bg-onPhoto/10 p-1">
          {(['public', 'local_only'] as const).map((mode) => {
            const selected = p.mode === mode;
            return (
              <Pressable
                key={mode}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={mode === 'public' ? 'Public' : 'Local Only'}
                onPress={() => p.onMode(mode)}
                className={`min-h-12 flex-row items-center gap-2 rounded-full px-5 ${selected ? 'bg-accent' : ''}`}>
                <Glyph
                  name={
                    mode === 'public'
                      ? { ios: 'camera.fill', android: 'photo_camera' }
                      : { ios: 'lock.fill', android: 'lock' }
                  }
                  tone={selected ? 'scrim' : 'onPhoto'}
                  size={20}
                />
                <Text
                  className={`font-fieldLabel text-fieldLabel ${selected ? 'text-scrim' : 'text-onPhoto'}`}>
                  {mode === 'public' ? 'Public' : 'Local Only'}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </View>
  );
}
