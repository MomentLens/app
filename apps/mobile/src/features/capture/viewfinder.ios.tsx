import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Glyph, GLYPH } from '@/components/ui/glyph';
import { FLIP, PreviewArea, Shutter } from './camera-controls';
import { SessionStack } from './session-stack';
import type { ViewfinderProps } from './viewfinder';

function Glass({ children, circle = false }: { children: ReactNode; circle?: boolean }) {
  const style = {
    borderRadius: 50,
    minHeight: 44,
    minWidth: circle ? 44 : undefined,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    paddingHorizontal: circle ? 0 : 18,
  };
  return isLiquidGlassAvailable() ? (
    <GlassView style={style} glassEffectStyle="regular" colorScheme="dark" isInteractive>
      {children}
    </GlassView>
  ) : (
    <View className="bg-onPhoto/15" style={style}>
      {children}
    </View>
  );
}
// The Camera app's layout from iOS 26 (D-134): close and the name on glass at the top, the stack
// leading and flip trailing the shutter, and the two mode labels below it.
export default function Viewfinder(p: ViewfinderProps) {
  return (
    <View className="flex-1 bg-scrim" style={{ paddingTop: p.top, paddingBottom: p.bottom }}>
      <View className="h-16 flex-row items-center gap-4 px-5">
        <Pressable accessibilityRole="button" accessibilityLabel="Close camera" onPress={p.onClose}>
          <Glass circle>
            <Glyph name={GLYPH.close} tone="onPhoto" size={20} />
          </Glass>
        </Pressable>
        <View className="flex-1 items-center">
          <Glass>
            <Text numberOfLines={1} className="font-fieldLabel text-fieldLabel text-onPhoto">
              {p.name}
            </Text>
          </Glass>
        </View>
        <View style={{ width: 44 }} />
      </View>
      <PreviewArea preview={p.preview} shots={p.shots} />
      <View className="h-28 flex-row items-center justify-between px-8">
        <SessionStack photos={p.photos} onPress={p.onClose} round />
        <Shutter busy={p.busy} ready={p.ready} onPress={p.onShutter} />
        <Pressable
          disabled={p.busy || !p.ready}
          accessibilityRole="button"
          accessibilityLabel="Flip camera"
          onPress={p.onFlip}>
          <Glass circle>
            <Glyph name={FLIP} tone="onPhoto" size={28} />
          </Glass>
        </Pressable>
      </View>
      <View className="h-20 flex-row items-center justify-center gap-3">
        {(['public', 'local_only'] as const).map((mode) => (
          <Pressable
            key={mode}
            accessibilityRole="button"
            accessibilityState={{ selected: p.mode === mode }}
            accessibilityLabel={mode === 'public' ? 'Public' : 'Local Only'}
            onPress={() => p.onMode(mode)}
            className="min-h-11 justify-center rounded-full px-4">
            <Text
              className={`font-fieldLabel text-fieldLabel ${p.mode === mode ? 'text-accent' : 'text-onPhoto'}`}>
              {mode === 'public' ? 'Public' : 'Local Only'}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
