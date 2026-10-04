import type { ReactNode } from 'react';

export interface SettingsFrameProps {
  title: string;
  save: { label: string; onPress: () => void; disabled: boolean; busy: boolean };
  // Android's back arrow. iOS draws the native back button, which pops the screen itself.
  onBack: () => void;
  children: ReactNode;
}
