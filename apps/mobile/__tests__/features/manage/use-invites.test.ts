import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { EventSummary, ListInvitesResponse, ManagedInvite } from '@momentlens/shared-types';
import { onlineManager } from '@tanstack/react-query';
import { setStringAsync } from 'expo-clipboard';
import { Share } from 'react-native';

import {
  freshInvites,
  inviteQueryKey,
  inviteQueryOptions,
  rotateInvite,
  sendInvite,
} from '@/features/manage/use-invites';
import { ApiError, getEvent, listInvites, regenerateInvite } from '@/lib/api';
import { persistOptions, queryClient } from '@/lib/query-client';
import { useAuthStore } from '@/stores/auth';

jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({ getString: () => undefined, set: () => undefined, remove: () => true }),
}));
jest.mock('@/lib/supabase', () => ({ supabase: { auth: {} } }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual<object>('@/lib/api'),
  listInvites: jest.fn(),
  regenerateInvite: jest.fn(),
  getEvent: jest.fn(),
}));

const mockList = jest.mocked(listInvites);
const mockRotate = jest.mocked(regenerateInvite);
const mockEvent = jest.mocked(getEvent);
const mockCopy = jest.mocked(setStringAsync);
const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = 'admin-a';
const guest: ManagedInvite = {
  id: '22222222-2222-4222-8222-222222222222',
  role: 'guest',
  token: 'a'.repeat(43),
  code: 'K7Q2XP',
};
const photographer: ManagedInvite = {
  id: '33333333-3333-4333-8333-333333333333',
  role: 'photographer',
  token: 'b'.repeat(43),
  code: 'M4T8RW',
};
const replacement: ManagedInvite = {
  ...guest,
  id: '44444444-4444-4444-8444-444444444444',
  token: 'c'.repeat(43),
  code: 'AB3K7X',
};
const listed: ListInvitesResponse = { invites: [guest, photographer] };
const event: EventSummary = {
  id: EVENT_ID,
  name: 'Ayesha & Bilal',
  role: 'admin',
  type: 'wedding',
  cover: null,
  startsAt: '2026-10-29T13:00:00.000Z',
  endsAt: '2026-10-31T18:00:00.000Z',
  archivedAt: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function cached() {
  return queryClient.getQueryData<ListInvitesResponse>(inviteQueryKey(EVENT_ID, OWNER));
}
function seed() {
  queryClient.setQueryData(inviteQueryKey(EVENT_ID, OWNER), listed);
}

beforeEach(() => {
  useAuthStore.setState({ status: 'signedIn', userId: OWNER });
  onlineManager.setOnline(true);
  mockList.mockResolvedValue(listed);
  mockEvent.mockResolvedValue({ event });
  mockCopy.mockResolvedValue(true);
});
afterEach(() => {
  queryClient.clear();
  jest.restoreAllMocks();
  jest.clearAllMocks();
  onlineManager.setOnline(true);
});

describe('managed credentials in memory', () => {
  it('refetches on mount, foreground and reconnect and never persists across a restart', async () => {
    const options = inviteQueryOptions(EVENT_ID, OWNER);
    expect(options.refetchOnMount).toBe('always');
    expect(options.refetchOnWindowFocus).toBe('always');
    expect(options.refetchOnReconnect).toBe('always');
    await queryClient.fetchQuery(options);
    const query = queryClient.getQueryCache().find({ queryKey: options.queryKey });
    expect(query).toBeDefined();
    expect(persistOptions.dehydrateOptions?.shouldDehydrateQuery?.(query!)).toBe(false);
    queryClient.clear();
    expect(cached()).toBeUndefined();
    expect(inviteQueryKey(EVENT_ID, 'admin-b')).not.toEqual(options.queryKey);
  });

  it('does not restore a late credential read after logout', async () => {
    const read = deferred<ListInvitesResponse>();
    const started = deferred<void>();
    mockList.mockImplementation(() => {
      started.resolve();
      return read.promise;
    });
    const fetching = freshInvites(EVENT_ID, OWNER).catch((error: unknown) => error);
    await started.promise;
    useAuthStore.setState({ status: 'signedOut', userId: null });
    queryClient.clear();
    read.resolve(listed);
    await fetching;
    expect(cached()).toBeUndefined();
  });
});

describe('Copy and Share', () => {
  it.each(['code', 'link', 'share'] as const)(
    'refuses %s offline despite cached credentials',
    async (action) => {
      seed();
      onlineManager.setOnline(false);
      const share = jest.spyOn(Share, 'share');
      expect((await sendInvite(EVENT_ID, 'guest', action, OWNER)).ok).toBe(false);
      expect(mockList).not.toHaveBeenCalled();
      expect(mockCopy).not.toHaveBeenCalled();
      expect(share).not.toHaveBeenCalled();
    },
  );

  it.each(['code', 'link'] as const)(
    'copies the fresh %s instead of the cached old credential',
    async (action) => {
      seed();
      mockList.mockResolvedValue({ invites: [replacement, photographer] });
      expect((await sendInvite(EVENT_ID, 'guest', action, OWNER)).ok).toBe(true);
      expect(mockList).toHaveBeenCalledTimes(1);
      expect(mockCopy).toHaveBeenCalledWith(
        action === 'code' ? replacement.code : `momentlens://invite/${replacement.token}`,
      );
    },
  );

  it('sends the complete role, fresh event name, link and code to the native share sheet', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
    await sendInvite(EVENT_ID, 'photographer', 'share', OWNER);
    const message = share.mock.calls[0]?.[0].message;
    expect(message).toContain('Photographer');
    expect(message).toContain(event.name);
    expect(message).toContain(`momentlens://invite/${photographer.token}`);
    expect(message).toContain(photographer.code);
  });

  it('refuses sharing an event archived after the screen loaded', async () => {
    mockEvent.mockResolvedValue({ event: { ...event, archivedAt: '2026-10-09T12:00:00.000Z' } });
    expect((await sendInvite(EVENT_ID, 'guest', 'code', OWNER)).ok).toBe(false);
    expect(mockCopy).not.toHaveBeenCalled();
  });

  it('never copies an old credential when the fresh read fails', async () => {
    seed();
    mockList.mockRejectedValue(new ApiError('unreachable'));
    expect((await sendInvite(EVENT_ID, 'guest', 'code', OWNER)).ok).toBe(false);
    expect(mockCopy).not.toHaveBeenCalled();
  });

  it('does not copy a late response after the account changes', async () => {
    const read = deferred<ListInvitesResponse>();
    const started = deferred<void>();
    mockList.mockImplementation(() => {
      started.resolve();
      return read.promise;
    });
    const sending = sendInvite(EVENT_ID, 'guest', 'code', OWNER);
    await started.promise;
    useAuthStore.setState({ status: 'signedIn', userId: 'admin-b' });
    read.resolve(listed);
    expect((await sending).ok).toBe(false);
    expect(mockCopy).not.toHaveBeenCalled();
  });

  it('does not resume sharing after logout and login to the same account', async () => {
    const read = deferred<ListInvitesResponse>();
    const started = deferred<void>();
    mockList.mockImplementation(() => {
      started.resolve();
      return read.promise;
    });
    const share = jest.spyOn(Share, 'share');
    const sending = sendInvite(EVENT_ID, 'guest', 'share', OWNER);
    await started.promise;
    useAuthStore.setState({ status: 'signedOut', userId: null });
    queryClient.clear();
    useAuthStore.setState({ status: 'signedIn', userId: OWNER });
    read.resolve(listed);
    expect((await sending).ok).toBe(false);
    expect(share).not.toHaveBeenCalled();
  });
});

describe('confirmed invite replacement', () => {
  it('permits replacement for an archived event without enabling sharing', async () => {
    seed();
    mockRotate.mockResolvedValue({ invite: replacement });
    mockEvent.mockResolvedValue({
      event: { ...event, archivedAt: '2026-10-09T12:00:00.000Z' },
    });
    expect((await rotateInvite(EVENT_ID, guest, OWNER)).ok).toBe(true);
    expect((await sendInvite(EVENT_ID, 'guest', 'code', OWNER)).ok).toBe(false);
    expect(mockCopy).not.toHaveBeenCalled();
  });

  it('cancels a foreground read that started while the POST was pending', async () => {
    seed();
    const started = deferred<void>();
    const write = deferred<{ invite: ManagedInvite }>();
    mockRotate.mockImplementation(() => {
      started.resolve();
      return write.promise;
    });
    const rotating = rotateInvite(EVENT_ID, guest, OWNER);
    await started.promise;
    const old = deferred<ListInvitesResponse>();
    mockList.mockReturnValue(old.promise);
    const fetching = queryClient
      .fetchQuery(inviteQueryOptions(EVENT_ID, OWNER))
      .catch(() => undefined);
    write.resolve({ invite: replacement });
    expect((await rotating).ok).toBe(true);
    old.resolve(listed);
    await fetching;
    expect(cached()?.invites).toEqual([replacement, photographer]);
  });

  it('retains a newer other-role invite read while the POST was pending', async () => {
    seed();
    const started = deferred<void>();
    const write = deferred<{ invite: ManagedInvite }>();
    mockRotate.mockImplementation(() => {
      started.resolve();
      return write.promise;
    });
    const rotating = rotateInvite(EVENT_ID, guest, OWNER);
    await started.promise;
    const newerPhotographer = {
      ...photographer,
      id: '55555555-5555-4555-8555-555555555555',
      token: 'd'.repeat(43),
      code: 'FG3K7X',
    };
    mockList.mockResolvedValue({ invites: [guest, newerPhotographer] });
    await queryClient.fetchQuery(inviteQueryOptions(EVENT_ID, OWNER));
    write.resolve({ invite: replacement });
    expect((await rotating).ok).toBe(true);
    expect(cached()?.invites).toEqual([replacement, newerPhotographer]);
  });

  it('refuses a displayed id superseded by a newer read without issuing a POST', async () => {
    queryClient.setQueryData(inviteQueryKey(EVENT_ID, OWNER), {
      invites: [replacement, photographer],
    });
    expect((await rotateInvite(EVENT_ID, guest, OWNER)).ok).toBe(false);
    expect(mockRotate).not.toHaveBeenCalled();
  });

  it('refuses offline rotation without queueing or calling the writer', async () => {
    seed();
    onlineManager.setOnline(false);
    expect((await rotateInvite(EVENT_ID, guest, OWNER)).ok).toBe(false);
    expect(mockRotate).not.toHaveBeenCalled();
  });

  it('cancels an older fetch and retains the other role when a replacement succeeds', async () => {
    seed();
    const old = deferred<ListInvitesResponse>();
    mockList.mockReturnValue(old.promise);
    const fetching = queryClient
      .fetchQuery(inviteQueryOptions(EVENT_ID, OWNER))
      .catch(() => undefined);
    mockRotate.mockResolvedValue({ invite: replacement });
    expect((await rotateInvite(EVENT_ID, guest, OWNER)).ok).toBe(true);
    old.resolve(listed);
    await fetching;
    expect(cached()?.invites).toEqual([replacement, photographer]);
    expect(mockRotate).toHaveBeenCalledWith(OWNER, EVENT_ID, {
      role: 'guest',
      expectedInviteId: guest.id,
    });
  });

  it('never retries an uncertain POST and blocks another rotation until recovery succeeds', async () => {
    seed();
    mockRotate.mockRejectedValue(new ApiError('timeout', undefined, undefined, true));
    mockList.mockRejectedValue(new ApiError('unreachable'));
    const result = await rotateInvite(EVENT_ID, guest, OWNER);
    expect(result.ok).toBe(false);
    expect(mockRotate).toHaveBeenCalledTimes(1);
    expect((await rotateInvite(EVENT_ID, guest, OWNER)).ok).toBe(false);
    expect(mockRotate).toHaveBeenCalledTimes(1);
    mockList.mockResolvedValue({ invites: [replacement, photographer] });
    await freshInvites(EVENT_ID, OWNER);
    expect(cached()?.invites[0]).toEqual(replacement);
  });

  it('refetches a conflict and requires another explicit action', async () => {
    seed();
    mockRotate.mockRejectedValue(new ApiError('changed', 409, 'invite_changed'));
    mockList.mockResolvedValue({ invites: [replacement, photographer] });
    expect((await rotateInvite(EVENT_ID, guest, OWNER)).ok).toBe(false);
    expect(mockRotate).toHaveBeenCalledTimes(1);
    expect(cached()?.invites[0]).toEqual(replacement);
  });

  it('never restores a late mutation response after logout clears the cache', async () => {
    seed();
    const write = deferred<{ invite: ManagedInvite }>();
    const started = deferred<void>();
    mockRotate.mockImplementation(() => {
      started.resolve();
      return write.promise;
    });
    const rotating = rotateInvite(EVENT_ID, guest, OWNER);
    await started.promise;
    useAuthStore.setState({ status: 'signedOut', userId: null });
    queryClient.clear();
    write.resolve({ invite: replacement });
    expect((await rotating).ok).toBe(false);
    expect(cached()).toBeUndefined();
  });
});
