import type { EventSummary, EventType } from '@momentlens/shared-types';
import { randomUUID } from 'expo-crypto';
import { create } from 'zustand';

// The Create Event wizard's draft. It lives in memory only, so killing the app loses it (D-110),
// and it is client state, so it sits in Zustand rather than TanStack Query (apps/mobile/CLAUDE.md).
// The three steps and the Add Sub-Event sheet are separate screens and all read it from here.

// A venue a sub-event in this draft uses. Two sub-events hold the same `key` when the second one
// picked the first one's venue from the sheet, and the request sends that venue once, so both
// share one `venue` row and one QR (spec §4.3, D-111).
export interface DraftVenue {
  key: string;
  name: string;
  lat: number;
  lng: number;
}

export interface DraftSubEvent {
  key: string;
  name: string;
  startsAt: Date;
  endsAt: Date;
  venue: DraftVenue;
  // This sub-event's own verification radius in metres (D-111).
  radiusM: number;
}

// A cover already re-encoded to JPEG on this phone, waiting for the event to exist (arch §3).
export interface DraftCover {
  uri: string;
  width: number;
  height: number;
}

export interface EventDraft {
  // The account that started the draft. The team hands phones around, so a draft someone else
  // started is never shown, and its requestId never sent, under another account (spec §4.1).
  ownerId: string | null;
  // Made once per wizard. Every retry of the create sends it again, so a create that timed out
  // but landed comes back as the same event instead of a second one (D-110).
  requestId: string;
  name: string;
  type: EventType | null;
  description: string;
  // The Approval Mode toggle on step 1. Off sends `auto` (D-111).
  approvalRequired: boolean;
  cover: DraftCover | null;
  subEvents: DraftSubEvent[];
}

interface DraftState extends EventDraft {
  // Set once POST /events has answered. From then on the wizard can only finish, since a repeat
  // with the same requestId returns this event and would ignore any edit.
  created: EventSummary | null;
}

function emptyDraft(ownerId: string | null): DraftState {
  return {
    ownerId,
    requestId: randomUUID(),
    name: '',
    type: null,
    description: '',
    approvalRequired: false,
    cover: null,
    subEvents: [],
    created: null,
  };
}

export const useEventDraft = create<DraftState>()(() => emptyDraft(null));

// A fresh draft with a new requestId, for the "+" and "Create an event" buttons. Every way into the
// wizard starts here, so a closed wizard's draft is never seen again, and never under another
// account on a handed-around phone.
export function startDraft(ownerId: string): void {
  useEventDraft.setState(emptyDraft(ownerId), true);
}

export function updateBasics(
  basics: Partial<Pick<EventDraft, 'name' | 'type' | 'description' | 'approvalRequired' | 'cover'>>,
): void {
  useEventDraft.setState(basics);
}

// Adds a sub-event, or replaces the one with the same key after the pencil reopened it.
export function saveSubEvent(subEvent: DraftSubEvent): void {
  useEventDraft.setState((state) => {
    const at = state.subEvents.findIndex((existing) => existing.key === subEvent.key);
    if (at === -1) {
      return { subEvents: [...state.subEvents, subEvent] };
    }
    const subEvents = state.subEvents.slice();
    subEvents[at] = subEvent;
    return { subEvents };
  });
}

export function removeSubEvent(key: string): void {
  useEventDraft.setState((state) => ({
    subEvents: state.subEvents.filter((subEvent) => subEvent.key !== key),
  }));
}

// A new requestId after POST /events answered 409 duplicate: another account already used this one
// (D-110), so every retry with it would be refused the same way. Nothing was created for this
// caller, so a new one cannot make a second event.
export function renewRequestId(): void {
  useEventDraft.setState({ requestId: randomUUID() });
}

export function markCreated(event: EventSummary): void {
  useEventDraft.setState({ created: event });
}

// True once anything has been entered, so closing the wizard asks before throwing it away.
export function draftHasContent(draft: EventDraft): boolean {
  return (
    draft.name.trim() !== '' ||
    draft.type !== null ||
    draft.description.trim() !== '' ||
    draft.approvalRequired ||
    draft.cover !== null ||
    draft.subEvents.length > 0
  );
}
