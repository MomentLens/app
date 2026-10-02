import type { ReactElement, ReactNode } from 'react';
import type { RefreshControlProps } from 'react-native';

import type { GlyphName } from '@/components/ui/glyph';

export interface BarAction {
  key: string;
  // What a screen reader says, and the button's text when it has no glyph.
  label: string;
  glyph?: GlyphName;
  // A word iOS shows on the glass instead of the glyph, such as "Join". Android keeps the glyph.
  text?: string;
  onPress: () => void;
  disabled?: boolean;
}

export interface LargeTitleScreenProps {
  title: string;
  // A line under the large title, such as an event's dates and the caller's role.
  subtitle?: string;
  back?: { label: string; onPress: () => void };
  actions?: BarAction[];
  // Drawn at the bar's trailing end after the actions, such as the avatar S-29 adds.
  trailing?: ReactElement;
  refreshControl?: ReactElement<RefreshControlProps>;
  // Space under the content, to clear a floating button.
  bottomInset?: number;
  // Drawn over the content after the scroll view, such as a FAB. iOS collapses the large title only
  // when the scroll view is the screen's first view, so nothing may wrap it.
  overlay?: ReactNode;
  // Classes for the scroll view's content, under the title.
  contentClassName?: string;
  children: ReactNode;
}
