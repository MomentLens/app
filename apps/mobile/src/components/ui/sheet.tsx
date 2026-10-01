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
  // Full height, for a form that scrolls. Left out, the sheet fits its content.
  full?: boolean;
  children: (target: T) => ReactNode;
}

// @expo/ui's BottomSheet with React Native content in its RNHostView (apps/mobile/AGENTS.md).
//
// What the sheet shows outlives `target`, so the content stays put while the sheet slides away
// instead of blanking first. Each opening gets its own number, so a second opening starts fresh
// rather than keeping the first one's typing.
export function Sheet<T>({ target, onClose, full = false, children }: SheetProps<T>) {
  const [shown, setShown] = useState<{ target: T; opening: number } | null>(null);
  if (target !== null && target !== shown?.target) {
    setShown({ target, opening: (shown?.opening ?? 0) + 1 });
  }

  return (
    <SurfaceSheet
      isPresented={target !== null}
      onDismiss={onClose}
      snapPoints={full ? ['full'] : undefined}
      contentPadding={0}
      className="bg-surface">
      <RNHostView matchContents={!full}>
        <View className={full ? 'flex-1 bg-surface' : 'bg-surface'}>
          {shown ? <Fragment key={shown.opening}>{children(shown.target)}</Fragment> : null}
        </View>
      </RNHostView>
    </SurfaceSheet>
  );
}
