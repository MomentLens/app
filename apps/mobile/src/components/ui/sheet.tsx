import { BottomSheet, RNHostView } from '@expo/ui';
import { cssInterop } from 'nativewind';
import { Fragment, useState, type ReactNode } from 'react';
import { View } from 'react-native';

// The sheet's own chrome takes a color prop. Painting it with the surface token, and dropping its
// default inset, stops the platform's grey showing as a frame around the content.
const SurfaceSheet = cssInterop(BottomSheet, {
  className: { target: false, nativeStyleToProp: { backgroundColor: 'containerColor' } },
});

interface SheetProps<T> {
  // What the sheet is open on, or null while it is closed.
  target: T | null;
  onClose: () => void;
  children: (target: T) => ReactNode;
}

// @expo/ui's BottomSheet at full height, with React Native content in its RNHostView
// (apps/mobile/AGENTS.md), for a form that scrolls. Left to fit its content, the sheet takes the
// content's own width on iOS rather than its own, so a short sheet is a native formSheet route
// instead, as Sub-event Detail and Delay are.
//
// What the sheet shows outlives `target`, so the content stays put while the sheet slides away
// instead of blanking first. Each opening gets its own number, so a second opening starts fresh
// rather than keeping the first one's typing.
export function Sheet<T>({ target, onClose, children }: SheetProps<T>) {
  const [shown, setShown] = useState<{ target: T; opening: number } | null>(null);
  if (target !== null && target !== shown?.target) {
    setShown({ target, opening: (shown?.opening ?? 0) + 1 });
  }

  return (
    <SurfaceSheet
      isPresented={target !== null}
      onDismiss={onClose}
      snapPoints={['full']}
      contentPadding={0}
      className="bg-surface">
      <RNHostView>
        <View className="flex-1 bg-surface">
          {shown ? <Fragment key={shown.opening}>{children(shown.target)}</Fragment> : null}
        </View>
      </RNHostView>
    </SurfaceSheet>
  );
}
