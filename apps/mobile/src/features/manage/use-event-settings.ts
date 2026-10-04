import type {
  EventSettings,
  EventSummary,
  GetEventResponse,
  PresignedImage,
  UpdateEventSettingsRequest,
} from '@momentlens/shared-types';
import { useQuery } from '@tanstack/react-query';

import { eventQueryKey, recheckEvent, retryUnlessRefused } from '@/features/event-shell/use-event';
import { uploadCover } from '@/features/events/cover';
import type { DraftCover } from '@/features/events/draft';
import { rememberEventChanges } from '@/features/events/use-events';
import { saveProblem, type SaveFailure, type SavePart } from '@/features/manage/settings';
import { ApiError, getEventSettings, updateEventSettings } from '@/lib/api';
import { queryClient } from '@/lib/query-client';

// A key of its own rather than one under ['event', eventId], so the event's refetches leave the
// form alone, as the schedule's key does.
export function eventSettingsQueryKey(eventId: string) {
  return ['event-settings', eventId] as const;
}

async function fetchSettings(eventId: string, signal?: AbortSignal): Promise<EventSettings> {
  try {
    return (await getEventSettings(eventId, signal)).settings;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      recheckEvent(eventId);
    }
    throw error;
  }
}

// GET /events/{eventId}/settings as server state, for the Admin's Event Settings form (D-142). It
// refetches on mount, foreground and reconnect. It is not kept across a restart as the event is:
// only the Admin reads it, and nothing it shows can be saved without a connection (D-121).
export function useEventSettings(eventId: string) {
  return useQuery({
    queryKey: eventSettingsQueryKey(eventId),
    queryFn: ({ signal }) => fetchSettings(eventId, signal),
    retry: retryUnlessRefused,
  });
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; problem: string };

// Whatever went wrong, the cached settings may be out of date: another phone changed them, or a
// write that timed out landed anyway. They refetch either way. Anything but an ApiError is the
// cover's own PUT to R2, which never reached the API, so it reads as no answer at all.
function failure(eventId: string, error: unknown, part: SavePart, detailsSaved = false) {
  void queryClient.invalidateQueries({ queryKey: eventSettingsQueryKey(eventId), exact: true });
  const refusal: SaveFailure =
    error instanceof ApiError ? error : part === 'cover' ? {} : { status: 500 };
  if (refusal.status === 403 || refusal.status === 404) {
    recheckEvent(eventId);
  }
  return { ok: false as const, problem: saveProblem(refusal, part, detailsSaved) };
}

// The settings as they are now, read again just before a switch to auto asks its question, so the
// confirm names whoever is pending at that moment. A request that arrives after this read and
// before the PATCH is still let in unnamed (D-142).
export async function freshSettings(eventId: string): Promise<Outcome<EventSettings>> {
  try {
    const settings = await queryClient.fetchQuery({
      queryKey: eventSettingsQueryKey(eventId),
      queryFn: ({ signal }) => fetchSettings(eventId, signal),
      staleTime: 0,
    });
    return { ok: true, value: settings };
  } catch (error) {
    return failure(eventId, error, 'check');
  }
}

// Puts the event's new name or cover into the Event shell's copy and the Events list, so the
// header and the card change at once rather than at their next fetch. A new cover comes with the
// cacheKey of its own upload, so neither keeps showing the old one (root invariant 2).
function rememberEvent(eventId: string, changes: Partial<Pick<EventSummary, 'name' | 'cover'>>) {
  queryClient.setQueryData<GetEventResponse>(eventQueryKey(eventId), (current) =>
    current ? { event: { ...current.event, ...changes } } : current,
  );
  rememberEventChanges(eventId, changes);
}

export interface SavedDetails {
  // How many pending requests a switch to auto let in, and how many the guest cap left waiting.
  admitted: number;
  pendingCount: number;
}

// PATCH /events/{eventId}/settings with the fields the Admin changed (D-142). The answer replaces
// the cached settings. It needs a connection and is never queued; offline it fails at once and
// says so (D-121).
export async function saveDetails(
  eventId: string,
  body: UpdateEventSettingsRequest,
): Promise<Outcome<SavedDetails>> {
  try {
    const { settings, admitted } = await updateEventSettings(eventId, body);
    const queryKey = eventSettingsQueryKey(eventId);
    // A fetch already in flight would land an older answer over this one.
    await queryClient.cancelQueries({ queryKey, exact: true });
    queryClient.setQueryData(queryKey, settings);
    rememberEvent(eventId, { name: settings.name });
    return { ok: true, value: { admitted, pendingCount: settings.pendingCount } };
  } catch (error) {
    return failure(eventId, error, 'details');
  }
}

// Uploads a picked cover straight to R2 and sets it, through S-02's two endpoints (D-110, D-142).
// The old cover's object stays in R2 (D-114). Killing the app between the upload and the PUT
// /cover leaves the old cover in place.
export async function saveCover(
  eventId: string,
  cover: DraftCover,
  detailsSaved: boolean,
): Promise<Outcome<PresignedImage>> {
  try {
    const presigned = await uploadCover(eventId, cover);
    const queryKey = eventSettingsQueryKey(eventId);
    await queryClient.cancelQueries({ queryKey, exact: true });
    queryClient.setQueryData<EventSettings>(queryKey, (current) =>
      current ? { ...current, cover: presigned } : current,
    );
    rememberEvent(eventId, { cover: presigned });
    return { ok: true, value: presigned };
  } catch (error) {
    return failure(eventId, error, 'cover', detailsSaved);
  }
}
