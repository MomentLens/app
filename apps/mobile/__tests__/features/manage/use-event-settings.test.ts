import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type {
  EventSettings,
  EventSummary,
  GetEventResponse,
  ListEventsResponse,
  PresignedImage,
} from '@momentlens/shared-types';

import { eventQueryKey } from '@/features/event-shell/use-event';
import { uploadCover } from '@/features/events/cover';
import { CoverUploadError } from '@/features/events/cover-error';
import { EVENTS_QUERY_KEY } from '@/features/events/use-events';
import {
  eventSettingsQueryKey,
  freshSettings,
  saveCover,
  saveDetails,
} from '@/features/manage/use-event-settings';
import { ApiError, getEventSettings, updateEventSettings } from '@/lib/api';
import { queryClient } from '@/lib/query-client';

// lib/query-client keeps its saved cache in MMKV, which needs native code Jest does not have.
jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({ getString: () => undefined, set: () => undefined, remove: () => true }),
}));
// lib/supabase throws for want of its environment variables, and nothing here signs in.
jest.mock('@/lib/supabase', () => ({ supabase: { auth: {} } }));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual<object>('@/lib/api'),
  getEventSettings: jest.fn(),
  updateEventSettings: jest.fn(),
}));
jest.mock('@/features/events/cover', () => ({ uploadCover: jest.fn() }));

const mockGet = jest.mocked(getEventSettings);
const mockUpdate = jest.mocked(updateEventSettings);
const mockUpload = jest.mocked(uploadCover);

const EVENT_ID = '0b6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
const OLD_COVER: PresignedImage = {
  url: 'https://r2.example.test/old?sig=1',
  cacheKey: `events/${EVENT_ID}/cover_11111111-1111-4111-8111-111111111111.jpg`,
};
const NEW_COVER: PresignedImage = {
  url: 'https://r2.example.test/new?sig=2',
  cacheKey: `events/${EVENT_ID}/cover_22222222-2222-4222-8222-222222222222.jpg`,
};
const SETTINGS: EventSettings = {
  name: 'Him & Her',
  description: null,
  approvalMode: 'manual',
  cover: OLD_COVER,
  pendingCount: 4,
  pendingPhotographers: ['Sara Ahmed'],
};
const EVENT: EventSummary = {
  id: EVENT_ID,
  name: 'Him & Her',
  type: 'wedding',
  role: 'admin',
  cover: OLD_COVER,
  startsAt: '2026-10-29T13:00:00.000Z',
  endsAt: '2026-10-31T18:00:00.000Z',
  archivedAt: null,
};
const PICKED = { uri: 'file:///cover.jpg', width: 1200, height: 800 };

function seed() {
  queryClient.setQueryData<EventSettings>(eventSettingsQueryKey(EVENT_ID), SETTINGS);
  queryClient.setQueryData<GetEventResponse>(eventQueryKey(EVENT_ID), { event: EVENT });
  queryClient.setQueryData<ListEventsResponse>(EVENTS_QUERY_KEY, {
    events: [EVENT],
    joinRequests: [],
  });
}

function cached() {
  return {
    settings: queryClient.getQueryData<EventSettings>(eventSettingsQueryKey(EVENT_ID)),
    event: queryClient.getQueryData<GetEventResponse>(eventQueryKey(EVENT_ID))?.event,
    listed: queryClient
      .getQueryData<ListEventsResponse>(EVENTS_QUERY_KEY)
      ?.events.find((event) => event.id === EVENT_ID),
  };
}

afterEach(() => {
  queryClient.clear();
  jest.clearAllMocks();
});

describe('saveDetails', () => {
  it('replaces the cached settings and puts the new name in the shell and the Events list', async () => {
    seed();
    const after = { ...SETTINGS, name: 'Ayesha & Bilal', approvalMode: 'auto' as const };
    mockUpdate.mockResolvedValue({
      settings: { ...after, pendingCount: 1, pendingPhotographers: [] },
      admitted: 3,
    });

    const result = await saveDetails(EVENT_ID, { name: 'Ayesha & Bilal', approvalMode: 'auto' });

    expect(result).toEqual({ ok: true, value: { admitted: 3, pendingCount: 1 } });
    expect(mockUpdate).toHaveBeenCalledWith(EVENT_ID, {
      name: 'Ayesha & Bilal',
      approvalMode: 'auto',
    });
    const { settings, event, listed } = cached();
    expect(settings?.approvalMode).toBe('auto');
    expect(event?.name).toBe('Ayesha & Bilal');
    expect(listed?.name).toBe('Ayesha & Bilal');
    // A PATCH never touches the cover.
    expect(event?.cover).toEqual(OLD_COVER);
  });

  // hb §5.3: the shell learns of a lost place in the event from its own query.
  it('refetches the event after a refusal and changes no cached value', async () => {
    seed();
    mockUpdate.mockRejectedValue(new ApiError('refused', 403, 'not_member'));

    const result = await saveDetails(EVENT_ID, { name: 'Ayesha & Bilal' });

    expect(result).toEqual({ ok: false, problem: 'You can no longer change this event.' });
    expect(queryClient.getQueryState(eventQueryKey(EVENT_ID))?.isInvalidated).toBe(true);
    expect(cached().event?.name).toBe('Him & Her');
    expect(cached().settings).toEqual(SETTINGS);
  });

  it('says nothing was saved when the API cannot be reached', async () => {
    seed();
    mockUpdate.mockRejectedValue(new ApiError('offline'));

    const result = await saveDetails(EVENT_ID, { approvalMode: 'auto' });

    expect(result).toEqual({
      ok: false,
      problem:
        'MomentLens could not be reached, so nothing was saved. Check the connection and try again.',
    });
    expect(queryClient.getQueryState(eventQueryKey(EVENT_ID))?.isInvalidated).toBe(false);
  });

  // The PATCH went out and no answer came, so a switch to auto may have let people in.
  it('never says nothing was saved when the PATCH timed out', async () => {
    seed();
    mockUpdate.mockRejectedValue(new ApiError('slow', undefined, undefined, true));

    const result = await saveDetails(EVENT_ID, { approvalMode: 'auto' });

    expect(result).toEqual({
      ok: false,
      problem:
        'MomentLens did not answer in time, so the changes may or may not have saved. If Save is still on once the form refreshes, try again.',
    });
    expect(queryClient.getQueryState(eventSettingsQueryKey(EVENT_ID))?.isInvalidated).toBe(true);
  });
});

describe('freshSettings', () => {
  it('answers the settings as the API has them now, and caches them', async () => {
    seed();
    const now = { ...SETTINGS, pendingCount: 5, pendingPhotographers: ['Sara Ahmed', 'Ali Khan'] };
    mockGet.mockResolvedValue({ settings: now });

    await expect(freshSettings(EVENT_ID)).resolves.toEqual({ ok: true, value: now });
    expect(cached().settings).toEqual(now);
  });

  // The read writes nothing, so even a timeout saved nothing.
  it('says nothing was saved when the read before a switch times out', async () => {
    seed();
    mockGet.mockRejectedValue(new ApiError('slow', undefined, undefined, true));

    await expect(freshSettings(EVENT_ID)).resolves.toEqual({
      ok: false,
      problem:
        'MomentLens could not be reached, so nothing was saved. Check the connection and try again.',
    });
  });
});

// Root invariant 2: a cover is cached under the key its own upload carries, so every cached copy of
// the event has to move to the new one or the old cover keeps showing.
describe('saveCover', () => {
  it('puts the new cover, with its own cache key, in all three cached copies', async () => {
    seed();
    mockUpload.mockResolvedValue(NEW_COVER);

    const result = await saveCover(EVENT_ID, PICKED, false);

    expect(result).toEqual({ ok: true, value: NEW_COVER });
    expect(mockUpload).toHaveBeenCalledWith(EVENT_ID, PICKED);
    const { settings, event, listed } = cached();
    expect(settings?.cover).toEqual(NEW_COVER);
    expect(event?.cover).toEqual(NEW_COVER);
    expect(listed?.cover).toEqual(NEW_COVER);
  });

  // The PUT to R2 throws CoverUploadError, never an ApiError (features/events/cover.ts).
  it('keeps the old cover when the upload fails, and says the details went through', async () => {
    seed();
    mockUpload.mockRejectedValue(new CoverUploadError('unreachable', 'offline'));

    const result = await saveCover(EVENT_ID, PICKED, true);

    expect(result).toEqual({
      ok: false,
      problem:
        'Your other changes are saved. The cover did not upload. Check the connection and try again.',
    });
    const { settings, event, listed } = cached();
    expect(settings?.cover).toEqual(OLD_COVER);
    expect(event?.cover).toEqual(OLD_COVER);
    expect(listed?.cover).toEqual(OLD_COVER);
  });

  it('asks for the photo again when the prepared file is gone', async () => {
    seed();
    mockUpload.mockRejectedValue(new CoverUploadError('file_missing', 'gone'));

    expect(await saveCover(EVENT_ID, PICKED, false)).toEqual({
      ok: false,
      problem: 'The photo you picked is no longer on this phone. Pick it again.',
    });
  });

  // Not the API and not R2: a bug in the app, which no connection check would fix.
  it('reads any other error as a failure on our side', async () => {
    seed();
    mockUpload.mockRejectedValue(new TypeError('undefined is not a function'));

    expect(await saveCover(EVENT_ID, PICKED, false)).toEqual({
      ok: false,
      problem: 'Something went wrong on our side. Try again in a moment.',
    });
  });

  it('says the cover did not finish uploading when the API cannot find it in R2', async () => {
    seed();
    mockUpload.mockRejectedValue(new ApiError('missing', 409, 'upload_missing'));

    expect(await saveCover(EVENT_ID, PICKED, false)).toEqual({
      ok: false,
      problem: 'The cover did not finish uploading. Try again.',
    });
  });
});
