import { create } from 'zustand';

import { useAuthStore } from '@/stores/auth';

// The identity filters on Home (spec §2.5.2): one People filter and one Uploader filter, which
// stack, one pill each (D-176). They live here rather than in Home's state because the Recognized
// Faces strip sets the People filter from another screen and then returns to Home (spec §2.5.6).
// The sub-event chip stays Home's own state.

// Find My Photos is kept as `me`, never as a user id, so it always means the account that is
// signed in now. A named person or an Unknown cluster keeps the name it was picked with, so the
// pill still reads right after that person leaves the People list (D-148).
export type PeopleFilter =
  | { kind: 'me' }
  | { kind: 'person'; userId: string; name: string }
  | { kind: 'unknown'; clusterId: string };

export interface UploaderFilter {
  id: string;
  name: string;
}

export interface EventFilters {
  people?: PeopleFilter;
  uploader?: UploaderFilter;
}

interface FilterState {
  byKey: Record<string, EventFilters>;
  setPeople: (key: string, people: PeopleFilter | undefined) => void;
  setUploader: (key: string, uploader: UploaderFilter | undefined) => void;
}

// Keyed by account as well as event: the team hands phones around, and the next account must not
// open an event already filtered by the last one's choices (spec §4.1).
export function filterKey(owner: string | null, eventId: string): string {
  return `${owner ?? ''}:${eventId}`;
}

export const useFilterStore = create<FilterState>()((set) => ({
  byKey: {},
  setPeople: (key, people) =>
    set((state) => ({ byKey: { ...state.byKey, [key]: { ...state.byKey[key], people } } })),
  setUploader: (key, uploader) =>
    set((state) => ({ byKey: { ...state.byKey, [key]: { ...state.byKey[key], uploader } } })),
}));

const NONE: EventFilters = {};

// The album query's parameters for a People filter. `personId` and `clusterId` are exclusive in
// ListAlbumRequest, and a PeopleFilter holds one or the other, never both.
export function peopleParams(
  people: PeopleFilter | undefined,
  owner: string | null,
): { personId?: string; clusterId?: string } {
  if (people === undefined) return {};
  switch (people.kind) {
    case 'me':
      return owner === null ? {} : { personId: owner };
    case 'person':
      return { personId: people.userId };
    case 'unknown':
      return { clusterId: people.clusterId };
  }
}

// The signed-in account's filters in one event, and the two setters bound to it.
export function useEventFilters(eventId: string) {
  const owner = useAuthStore((state) => state.userId);
  const key = filterKey(owner, eventId);
  const filters = useFilterStore((state) => state.byKey[key] ?? NONE);
  const setPeopleFor = useFilterStore((state) => state.setPeople);
  const setUploaderFor = useFilterStore((state) => state.setUploader);
  return {
    owner,
    people: filters.people,
    uploader: filters.uploader,
    setPeople: (people: PeopleFilter | undefined) => setPeopleFor(key, people),
    setUploader: (uploader: UploaderFilter | undefined) => setUploaderFor(key, uploader),
  };
}

// Sets the People filter from outside Home, as the strip does before it returns there.
export function setPeopleFilter(eventId: string, people: PeopleFilter): void {
  const owner = useAuthStore.getState().userId;
  useFilterStore.getState().setPeople(filterKey(owner, eventId), people);
}
