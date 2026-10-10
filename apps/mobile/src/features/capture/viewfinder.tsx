import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { Glyph, GLYPH } from '@/components/ui/glyph';
import type { CaptureMode } from './context';
import { SessionStack, type SessionPhoto } from './session-stack';

export interface ViewfinderProps {
  name: string;
  preview: ReactNode;
  mode: CaptureMode;
  photos: SessionPhoto[];
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
      <View className="flex-1 items-center justify-center">{p.preview}</View>
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
          {(['public', 'local_only'] as const).map((mode) => (
            <Pressable
              key={mode}
              accessibilityRole="button"
              accessibilityState={{ selected: p.mode === mode }}
              accessibilityLabel={mode === 'public' ? 'Public' : 'Local Only'}
              onPress={() => p.onMode(mode)}
              className={`min-h-12 flex-row items-center gap-2 rounded-full px-5 ${p.mode === mode ? 'bg-accentTint' : ''}`}>
              <Glyph
                name={
                  mode === 'public'
                    ? { ios: 'camera.fill', android: 'photo_camera' }
                    : { ios: 'lock.fill', android: 'lock' }
                }
                tone={p.mode === mode ? 'scrim' : 'onPhoto'}
                size={20}
              />
              <Text
                className={`font-fieldLabel text-fieldLabel ${p.mode === mode ? 'text-scrim' : 'text-onPhoto'}`}>
                {mode === 'public' ? 'Public' : 'Local Only'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}
export function Shutter({
  busy,
  ready,
  onPress,
}: {
  busy: boolean;
  ready: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Take photo"
      disabled={!ready || busy}
      accessibilityState={{ disabled: !ready || busy, busy }}
      onPress={onPress}
      className={`h-20 w-20 items-center justify-center rounded-full border-[3px] border-onPhoto ${!ready ? 'opacity-40' : ''}`}>
      <View
        className={`h-16 w-16 items-center justify-center rounded-full ${busy ? 'bg-onPhoto/50' : 'bg-onPhoto'}`}>
        {busy ? <ActivityIndicator className="text-scrim" /> : null}
      </View>
    </Pressable>
  );
}
