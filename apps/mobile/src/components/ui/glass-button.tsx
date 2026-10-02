import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';

const GLASS = isLiquidGlassAvailable();

// A round 44pt button on Liquid Glass, as iOS 26 draws a sheet's toolbar items, with a plain
// translucent circle before iOS 26.
export function GlassButton({
  label,
  onPress,
  disabled = false,
  tint,
  wide = false,
  children,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tint?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  const shape = { height: 44, minWidth: 44, borderRadius: 22, paddingHorizontal: wide ? 16 : 0 };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      // The active: modifier stays in both states. NativeWind upgrades a component the first time
      // its classes gain one, and its development warning then crashed inside the sheets.
      className={`active:opacity-70 ${disabled ? 'opacity-40' : ''}`}>
      {GLASS ? (
        <GlassView
          isInteractive
          tintColor={tint}
          style={[shape, { alignItems: 'center', justifyContent: 'center' }]}>
          {children}
        </GlassView>
      ) : (
        <View
          style={shape}
          className={`items-center justify-center ${tint ? 'bg-accent' : 'bg-textPrimary/10'}`}>
          {children}
        </View>
      )}
    </Pressable>
  );
}
