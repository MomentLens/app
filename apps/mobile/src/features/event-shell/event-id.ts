import { createContext, useContext } from 'react';

// The open event's id, from the Event shell's own route. A tab that holds a stack of its own, as
// the Schedule does, gets no `[id]` param when the tab bar opens it, so every screen inside the
// shell reads the id from here instead of from its route.
export const EventIdContext = createContext<string | null>(null);

export function useEventId(): string {
  const eventId = useContext(EventIdContext);
  if (eventId === null) {
    throw new Error('useEventId is only for screens inside the Event shell, app/(app)/event/[id].');
  }
  return eventId;
}
