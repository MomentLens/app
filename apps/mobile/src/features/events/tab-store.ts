import type { EventTiming } from '@momentlens/shared-types';
import { create } from 'zustand';

// Which of Active, Upcoming and Past the Events tab shows. UI state, so Zustand (apps/mobile/CLAUDE.md).
interface EventsTabState {
  tab: EventTiming;
}

export const useEventsTab = create<EventsTabState>()(() => ({ tab: 'active' }));

export function showEventsTab(tab: EventTiming): void {
  useEventsTab.setState({ tab });
}
