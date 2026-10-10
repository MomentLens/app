import { create } from 'zustand';
import type { CaptureMode } from './context';

// The starting preference belongs to S-29. This store holds only the open session's mode.
export const useCaptureMode = create<{ mode: CaptureMode; setMode: (mode: CaptureMode) => void }>(
  (set) => ({
    mode: 'public',
    setMode: (mode) => set({ mode }),
  }),
);
