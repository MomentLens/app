import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { Attendee, ListAttendeesResponse } from '@momentlens/shared-types';
import { onlineManager, type InfiniteData } from '@tanstack/react-query';

import { eventQueryKey } from '@/features/event-shell/use-event';
import {
  attendeeInitials,
  attendeeListItems,
  attendeeQueryOptions,
  attendeesQueryKey,
  loadedAttendee,
  saveAttendeeAction,
} from '@/features/manage/use-attendees';
import {
  ApiError,
  blockAttendee,
  changeAttendeeRole,
  listAttendees,
  removeAttendee,
} from '@/lib/api';
import { queryClient } from '@/lib/query-client';

jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({ getString: () => undefined, set: () => undefined, remove: () => true }),
}));
jest.mock('@/lib/supabase', () => ({ supabase: { auth: {} } }));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual<object>('@/lib/api'),
  listAttendees: jest.fn(),
  changeAttendeeRole: jest.fn(),
  removeAttendee: jest.fn(),
  blockAttendee: jest.fn(),
}));

const EVENT = '0b6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
const TARGET: Attendee = {
  userId: '11111111-1111-4111-8111-111111111111',
  fullName: 'Hamza Siddiqui',
  role: 'guest',
  requestedAt: '2026-10-02T13:00:00.000Z',
  accessVersion: 'opaque-1',
  avatar: null,
};
const get = jest.mocked(listAttendees);
const remove = jest.mocked(removeAttendee);
const change = jest.mocked(changeAttendeeRole);
const block = jest.mocked(blockAttendee);
const filters = { search: '', role: undefined };
const key = attendeesQueryKey(EVENT, filters);

describe('attendee presentation', () => {
  it.each([
    ['Hamza Siddiqui', 'HS'],
    ['  Sara  Noor Qadir ', 'SQ'],
    ['علی رضا', 'عر'],
    ['𝒜yesha', '𝒜'],
    ['', ''],
  ])('draws name initials for %s', (name, expected) => {
    expect(attendeeInitials(name)).toBe(expected);
  });

  it('groups roles without empty sections, preserves each role order and deduplicates page overlap', () => {
    const second = {
      ...TARGET,
      userId: '22222222-2222-4222-8222-222222222222',
      fullName: 'Hira Shah',
    };
    const changed = { ...TARGET, fullName: 'Hamza Khan', accessVersion: 'new' };
    const items = attendeeListItems([TARGET, second, changed]);
    expect(items.filter((item) => item.type === 'header').map((item) => item.title)).toEqual([
      'Guests',
    ]);
    expect(items.filter((item) => item.type === 'attendee')).toMatchObject([
      { attendee: changed, first: true, last: false },
      { attendee: second, first: false, last: true },
    ]);
    expect(attendeeListItems([])).toEqual([]);
  });
});

async function seed() {
  queryClient.setQueryData(eventQueryKey(EVENT), { event: { role: 'admin' } });
  get.mockResolvedValue({ attendees: [TARGET], nextCursor: null });
  await queryClient.fetchInfiniteQuery(attendeeQueryOptions(EVENT, filters));
  get.mockClear();
}

afterEach(() => {
  queryClient.clear();
  onlineManager.setOnline(true);
  jest.resetAllMocks();
});

describe('attendee reads', () => {
  it('keeps filters in the key, passes opaque cursors and does not persist', async () => {
    const selected = { search: '% Ali_', role: 'photographer' as const };
    const options = attendeeQueryOptions(EVENT, selected);
    get.mockResolvedValue({ attendees: [TARGET], nextCursor: 'opaque-page-2' });
    await queryClient.fetchInfiniteQuery(options);
    expect(get).toHaveBeenCalledWith(EVENT, { ...selected, cursor: undefined }, expect.anything());
    expect(options.getNextPageParam({ attendees: [], nextCursor: 'opaque-page-2' })).toBe(
      'opaque-page-2',
    );
    expect(options.getNextPageParam({ attendees: [], nextCursor: null })).toBeUndefined();
    expect(
      queryClient.getQueryCache().find({ queryKey: options.queryKey })?.meta?.persist,
    ).not.toBe(true);
    expect(options.queryKey).not.toEqual(key);
  });

  it.each(['not_member', 'wrong_role'] as const)(
    'rechecks the shell after %s on a read',
    async (code) => {
      queryClient.setQueryData(eventQueryKey(EVENT), { event: { role: 'admin' } });
      get.mockRejectedValue(new ApiError('refused', 403, code));
      await expect(
        queryClient.fetchInfiniteQuery(attendeeQueryOptions(EVENT, filters)),
      ).rejects.toThrow();
      expect(queryClient.getQueryState(eventQueryKey(EVENT))?.isInvalidated).toBe(true);
      expect(get).toHaveBeenCalledTimes(1);
    },
  );

  it('finds a target on a later page and never falls back to another event or filter', async () => {
    await seed();
    queryClient.setQueryData<InfiniteData<ListAttendeesResponse>>(key, {
      pages: [
        { attendees: [], nextCursor: 'next' },
        { attendees: [TARGET], nextCursor: null },
      ],
      pageParams: [undefined, 'next'],
    });
    expect(loadedAttendee(EVENT, filters, TARGET.userId)).toEqual(TARGET);
    expect(loadedAttendee('other-event', filters, TARGET.userId)).toBeUndefined();
    expect(loadedAttendee(EVENT, { search: 'other' }, TARGET.userId)).toBeUndefined();
    queryClient.clear();
    expect(loadedAttendee(EVENT, filters, TARGET.userId)).toBeUndefined();
  });

  it('uses the later row when a name change repeats a person across page boundaries', async () => {
    await seed();
    const latest = { ...TARGET, fullName: 'Hamza Khan', accessVersion: 'changed' };
    queryClient.setQueryData<InfiniteData<ListAttendeesResponse>>(key, {
      pages: [
        { attendees: [TARGET], nextCursor: 'next' },
        { attendees: [latest], nextCursor: null },
      ],
      pageParams: [undefined, 'next'],
    });
    expect(loadedAttendee(EVENT, filters, TARGET.userId)).toEqual(latest);
    await saveAttendeeAction(EVENT, filters, TARGET, { kind: 'remove' });
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('attendee actions', () => {
  it('refuses another action while the loaded query awaits a refresh', async () => {
    await seed();
    await queryClient.invalidateQueries({ queryKey: key, refetchType: 'none' });
    await saveAttendeeAction(EVENT, filters, TARGET, { kind: 'remove' });
    expect(remove).not.toHaveBeenCalled();
  });
  it('refuses offline without sending or queueing a write', async () => {
    await seed();
    onlineManager.setOnline(false);
    expect(await saveAttendeeAction(EVENT, filters, TARGET, { kind: 'remove' })).toMatchObject({
      ok: false,
    });
    expect(remove).not.toHaveBeenCalled();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it.each(['guest', 'photographer'] as const)('refuses a %s actor locally', async (role) => {
    await seed();
    queryClient.setQueryData(eventQueryKey(EVENT), { event: { role } });
    expect(await saveAttendeeAction(EVENT, filters, TARGET, { kind: 'remove' })).toMatchObject({
      ok: false,
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it('protects the Admin and rejects a missing or replaced target', async () => {
    await seed();
    expect(
      await saveAttendeeAction(EVENT, filters, { ...TARGET, role: 'admin' }, { kind: 'remove' }),
    ).toMatchObject({ ok: false });
    queryClient.setQueryData(key, {
      pages: [{ attendees: [{ ...TARGET, accessVersion: 'rejoined' }], nextCursor: null }],
      pageParams: [undefined],
    });
    expect(await saveAttendeeAction(EVENT, filters, TARGET, { kind: 'remove' })).toMatchObject({
      ok: false,
    });
    queryClient.setQueryData(key, {
      pages: [{ attendees: [], nextCursor: null }],
      pageParams: [undefined],
    });
    expect(await saveAttendeeAction(EVENT, filters, TARGET, { kind: 'remove' })).toMatchObject({
      ok: false,
      returnToList: true,
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it('sends the loaded version once and refreshes every loaded filter on success', async () => {
    await seed();
    await queryClient.fetchInfiniteQuery(attendeeQueryOptions(EVENT, { role: 'guest' }));
    get.mockResolvedValue({ attendees: [], nextCursor: null });
    remove.mockResolvedValue({
      membership: {
        userId: TARGET.userId,
        role: 'guest',
        status: 'removed',
        accessVersion: 'opaque-2',
      },
    });
    expect(await saveAttendeeAction(EVENT, filters, TARGET, { kind: 'remove' })).toEqual({
      ok: true,
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(EVENT, TARGET.userId, { expectedVersion: 'opaque-1' });
    expect(loadedAttendee(EVENT, filters, TARGET.userId)).toBeUndefined();
    expect(loadedAttendee(EVENT, { role: 'guest' }, TARGET.userId)).toBeUndefined();
  });

  it.each([
    new ApiError('stale', 409, 'membership_changed'),
    new ApiError('lost response'),
    new ApiError('timeout', undefined, undefined, true),
    new ApiError('bad JSON', 200),
    new ApiError('server failed', 500, 'internal_error'),
  ])(
    'refreshes after a stale or uncertain result and blocks writes when refresh fails',
    async (error) => {
      await seed();
      remove.mockRejectedValue(error);
      get.mockRejectedValue(new ApiError('still offline'));
      const result = await saveAttendeeAction(EVENT, filters, TARGET, { kind: 'remove' });
      expect(result).toMatchObject({ ok: false });
      expect(get).toHaveBeenCalled();
      expect(remove).toHaveBeenCalledTimes(1);
      await saveAttendeeAction(EVENT, filters, TARGET, { kind: 'remove' });
      expect(remove).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['not_member', 'wrong_role', 'not_found'] as const)(
    'rechecks the shell after %s on a write',
    async (code) => {
      await seed();
      remove.mockRejectedValue(new ApiError('refused', code === 'not_found' ? 404 : 403, code));
      await saveAttendeeAction(EVENT, filters, TARGET, { kind: 'remove' });
      expect(queryClient.getQueryState(eventQueryKey(EVENT))?.isInvalidated).toBe(true);
      expect(remove).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps the role after event_full and sends no automatic retry', async () => {
    await seed();
    change.mockRejectedValue(new ApiError('full', 422, 'event_full'));
    expect(
      await saveAttendeeAction(EVENT, filters, TARGET, { kind: 'role', role: 'photographer' }),
    ).toMatchObject({ ok: false, problem: expect.stringContaining('150') });
    expect(change).toHaveBeenCalledTimes(1);
    expect(loadedAttendee(EVENT, filters, TARGET.userId)?.role).toBe('guest');
  });

  it('blocks a second tap while a write is running', async () => {
    await seed();
    let finish!: (value: Awaited<ReturnType<typeof blockAttendee>>) => void;
    block.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = saveAttendeeAction(EVENT, filters, TARGET, { kind: 'block' });
    await Promise.resolve();
    const second = await saveAttendeeAction(EVENT, filters, TARGET, { kind: 'block' });
    expect(second).toMatchObject({ ok: false });
    finish({
      membership: {
        userId: TARGET.userId,
        role: 'guest',
        status: 'blocked',
        accessVersion: 'opaque-2',
      },
    });
    await first;
    expect(block).toHaveBeenCalledTimes(1);
  });
});
