import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type {
  AttendeeWithVerification,
  ListAttendeesResponse,
  SubEvent,
} from '@momentlens/shared-types';
import { InfiniteQueryObserver, onlineManager, type InfiniteData } from '@tanstack/react-query';

import { eventQueryKey } from '@/features/event-shell/use-event';
import {
  attendeeInitials,
  attendeeCheckInLabel,
  attendeeSubEvent,
  canManuallyCheckIn,
  attendeeListItems,
  attendeeQueryOptions,
  attendeeSheetExit,
  attendeesQueryKey,
  loadedAttendee,
  saveAttendeeAction,
} from '@/features/manage/use-attendees';
import {
  ApiError,
  blockAttendee,
  changeAttendeeRole,
  listAttendees,
  listSubEvents,
  forceVerifyAttendee,
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
  listSubEvents: jest.fn(),
  forceVerifyAttendee: jest.fn(),
  changeAttendeeRole: jest.fn(),
  removeAttendee: jest.fn(),
  blockAttendee: jest.fn(),
}));

const EVENT = '0b6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
const TARGET: AttendeeWithVerification = {
  userId: '11111111-1111-4111-8111-111111111111',
  fullName: 'Hamza Siddiqui',
  role: 'guest',
  requestedAt: '2026-10-02T13:00:00.000Z',
  accessVersion: 'opaque-1',
  avatar: null,
  verification: { everySubEvent: false, subEventIds: [] },
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

let unwatch: (() => void) | undefined;

// The Attendees screen and the sheet observe the default filters, so that query is active, as it
// is on the phone. Other filters stay inactive unless a test fetches them.
async function seed() {
  queryClient.setQueryData(eventQueryKey(EVENT), { event: { role: 'admin' } });
  get.mockResolvedValue({ attendees: [TARGET], nextCursor: null });
  unwatch = new InfiniteQueryObserver(queryClient, attendeeQueryOptions(EVENT, filters)).subscribe(
    () => undefined,
  );
  await queryClient.fetchInfiniteQuery(attendeeQueryOptions(EVENT, filters));
  get.mockClear();
}

afterEach(() => {
  unwatch?.();
  unwatch = undefined;
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
    // Detach before clearing. An observer on a removed query schedules an orphaned GC timer.
    unwatch?.();
    unwatch = undefined;
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

describe('attendee sheet exit', () => {
  it('returns to the list when the loaded target is gone', () => {
    expect(attendeeSheetExit(false, 'admin', null)).toBe('list');
  });

  it('leaves for the Event shell after a role change or lost access', () => {
    expect(attendeeSheetExit(true, 'guest', null)).toBe('event');
    expect(attendeeSheetExit(true, 'admin', new ApiError('removed', 403, 'not_member'))).toBe(
      'event',
    );
    expect(attendeeSheetExit(true, 'admin', new ApiError('deleted', 404, 'not_found'))).toBe(
      'event',
    );
  });

  it.each([
    new ApiError('offline'),
    new ApiError('timeout', undefined, undefined, true),
    new ApiError('server failed', 500, 'internal_error'),
    new Error('unexpected'),
  ])('stays open on a transient event error', (error) => {
    expect(attendeeSheetExit(true, 'admin', error)).toBeNull();
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

  it('sends the loaded version once, refetches the list on screen and invalidates other filters', async () => {
    await seed();
    await queryClient.fetchInfiniteQuery(attendeeQueryOptions(EVENT, { role: 'guest' }));
    get.mockClear();
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
    expect(get).toHaveBeenCalledTimes(1);
    const other = queryClient.getQueryState(attendeesQueryKey(EVENT, { role: 'guest' }));
    expect(other?.isInvalidated).toBe(true);
    // The other filter's old rows still draw until it is opened, but cannot be acted on.
    await expect(
      saveAttendeeAction(EVENT, { role: 'guest' }, TARGET, { kind: 'block' }),
    ).resolves.toMatchObject({ ok: false });
    expect(block).not.toHaveBeenCalled();
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

describe('S-17 selected sub-event coverage', () => {
  const FIRST = '00000000-0000-4000-8000-000000000003';
  const SECOND = '00000000-0000-4000-8000-000000000004';
  const THIRD = '00000000-0000-4000-8000-000000000005';
  const at = new Date('2026-10-12T12:30:00.000Z');
  const session = (id: string, start: string, end: string): SubEvent => ({
    id,
    name: 'Mehndi',
    description: null,
    startsAt: start,
    endsAt: end,
    verificationRadiusM: 200,
    venue: { id: EVENT, name: 'Hall', lat: 31, lng: 74 },
  });
  const past = session(FIRST, '2026-10-12T10:00:00Z', '2026-10-12T11:00:00Z');
  const live = session(SECOND, '2026-10-12T12:00:00Z', '2026-10-12T13:00:00Z');
  const next = session(THIRD, '2026-10-12T14:00:00Z', '2026-10-12T15:00:00Z');

  it('chooses the shared overlapping winner, then the latest completed, then the next upcoming', () => {
    const overlap = { ...live, id: FIRST, startsAt: '2026-10-12T12:15:00Z' };
    expect(attendeeSubEvent([next, live, overlap], at)?.id).toBe(FIRST);
    expect(attendeeSubEvent([next, past], at)?.id).toBe(FIRST);
    expect(attendeeSubEvent([next], at)?.id).toBe(THIRD);
    expect(attendeeSubEvent([], at)).toBeNull();
  });

  it('keeps a valid selection and chooses again when that sub-event disappears', () => {
    expect(attendeeSubEvent([past, live, next], at, FIRST)?.id).toBe(FIRST);
    expect(attendeeSubEvent([live, next], at, FIRST)?.id).toBe(SECOND);
  });

  it('binds sub-event and check-in filters to separate queries and restarts their cursors', async () => {
    const selected = {
      search: 'Hamza',
      role: 'guest' as const,
      subEventId: FIRST,
      checkIn: 'checked_in' as const,
    };
    const otherSub = { ...selected, subEventId: SECOND };
    const otherFilter = { ...selected, checkIn: 'not_checked_in' as const };
    const options = attendeeQueryOptions(EVENT, selected);
    expect(options.queryKey).not.toEqual(attendeesQueryKey(EVENT, otherSub));
    expect(options.queryKey).not.toEqual(attendeesQueryKey(EVENT, otherFilter));
    get.mockResolvedValue({ attendees: [TARGET], nextCursor: 'bound-cursor' });
    await queryClient.fetchInfiniteQuery(options);
    await queryClient.fetchInfiniteQuery(attendeeQueryOptions(EVENT, otherSub));
    expect(get.mock.calls.map((call) => call[1]?.cursor)).toEqual([undefined, undefined]);
    expect(loadedAttendee(EVENT, otherFilter, TARGET.userId)).toBeUndefined();
    await options.queryFn({ pageParam: 'bound-cursor', signal: new AbortController().signal });
    expect(get).toHaveBeenLastCalledWith(
      EVENT,
      { ...selected, cursor: 'bound-cursor' },
      expect.anything(),
    );
  });

  it('refreshes the schedule after a deleted filter target before another filtered read', async () => {
    const selected = { subEventId: FIRST, checkIn: 'checked_in' as const };
    queryClient.setQueryData(['sub-events', EVENT], { subEvents: [past, live] });
    get.mockRejectedValue(new ApiError('deleted session', 404, 'not_found'));
    jest.mocked(listSubEvents).mockResolvedValue({ subEvents: [live] });
    await expect(
      queryClient.fetchInfiniteQuery(attendeeQueryOptions(EVENT, selected)),
    ).rejects.toThrow();
    expect(listSubEvents).toHaveBeenCalledTimes(1);
    expect(
      queryClient.getQueryCache().find({ queryKey: ['sub-events', EVENT] })?.meta?.persist,
    ).toBe(true);
    const schedule = queryClient.getQueryData<{ subEvents: SubEvent[] }>(['sub-events', EVENT]);
    expect(attendeeSubEvent(schedule!.subEvents, at, FIRST)?.id).toBe(SECOND);
    const reads = get.mock.calls.length;
    await expect(
      queryClient.fetchInfiniteQuery(attendeeQueryOptions(EVENT, selected)),
    ).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(reads);
  });

  it('reports only server coverage for the selected session and identifies manual and exempt coverage', () => {
    const checked = { ...TARGET, verification: { everySubEvent: false, subEventIds: [FIRST] } };
    expect(attendeeCheckInLabel(checked, FIRST)).toBe('Checked in');
    expect(attendeeCheckInLabel(checked, SECOND)).toBe('Not checked in');
    expect(attendeeCheckInLabel(TARGET, FIRST)).toBe('Not checked in');
    const manual = { ...TARGET, verification: { everySubEvent: true, subEventIds: [] } };
    expect(attendeeCheckInLabel(manual, SECOND)).toBe('Checked in manually');
    expect(canManuallyCheckIn(manual)).toBe(false);
    expect(canManuallyCheckIn(TARGET)).toBe(true);
    for (const role of ['admin', 'photographer'] as const) {
      expect(attendeeCheckInLabel({ ...TARGET, role }, FIRST)).toBe('Check-in not required');
      expect(canManuallyCheckIn({ ...TARGET, role })).toBe(false);
    }
  });

  it.each([0, 1, 50, 51])(
    'keeps %i paginated attendees without duplicates or invented coverage',
    (count) => {
      const rows = Array.from({ length: count }, (_, i) => ({ ...TARGET, userId: String(i) }));
      expect(attendeeListItems(rows).filter((item) => item.type === 'attendee')).toHaveLength(
        count,
      );
    },
  );
});

describe('S-17 conditional manual check-in', () => {
  const grant = {
    membership: {
      userId: TARGET.userId,
      role: 'guest' as const,
      status: 'active' as const,
      accessVersion: TARGET.accessVersion,
    },
    adminVerifiedAt: '2026-10-12T12:30:00.000Z',
  };

  it('sends only the loaded version once, cancels old reads and invalidates every loaded filter', async () => {
    await seed();
    const other = { subEventId: EVENT, checkIn: 'not_checked_in' as const };
    await queryClient.fetchInfiniteQuery(attendeeQueryOptions(EVENT, other));
    const cancel = jest.spyOn(queryClient, 'cancelQueries');
    jest.mocked(forceVerifyAttendee).mockResolvedValue(grant);
    expect(await saveAttendeeAction(EVENT, filters, TARGET, { kind: 'verify' })).toEqual({
      ok: true,
    });
    expect(forceVerifyAttendee).toHaveBeenCalledTimes(1);
    expect(forceVerifyAttendee).toHaveBeenCalledWith(EVENT, TARGET.userId, {
      expectedVersion: TARGET.accessVersion,
    });
    expect(cancel).toHaveBeenCalledWith({ queryKey: ['attendees', EVENT] });
    expect(queryClient.getQueryState(attendeesQueryKey(EVENT, other))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryData(eventQueryKey(EVENT))).toEqual({ event: { role: 'admin' } });
    cancel.mockRestore();
  });

  it('refuses manual check-in offline without queueing a write', async () => {
    await seed();
    onlineManager.setOnline(false);
    expect(await saveAttendeeAction(EVENT, filters, TARGET, { kind: 'verify' })).toMatchObject({
      ok: false,
    });
    expect(forceVerifyAttendee).not.toHaveBeenCalled();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });

  it.each(['guest', 'photographer'] as const)(
    'refuses a %s actor before manual check-in',
    async (role) => {
      await seed();
      queryClient.setQueryData(eventQueryKey(EVENT), { event: { role } });
      await saveAttendeeAction(EVENT, filters, TARGET, { kind: 'verify' });
      expect(forceVerifyAttendee).not.toHaveBeenCalled();
    },
  );

  it('refuses Admin, missing, replaced and already manually covered targets', async () => {
    await seed();
    await saveAttendeeAction(EVENT, filters, { ...TARGET, role: 'admin' }, { kind: 'verify' });
    for (const changed of [
      { ...TARGET, accessVersion: 'rejoined' },
      { ...TARGET, role: 'photographer' as const },
      { ...TARGET, verification: { everySubEvent: true, subEventIds: [] } },
    ]) {
      queryClient.setQueryData(key, {
        pages: [{ attendees: [changed], nextCursor: null }],
        pageParams: [undefined],
      });
      await saveAttendeeAction(EVENT, filters, TARGET, { kind: 'verify' });
    }
    queryClient.setQueryData(key, {
      pages: [{ attendees: [], nextCursor: null }],
      pageParams: [undefined],
    });
    expect(await saveAttendeeAction(EVENT, filters, TARGET, { kind: 'verify' })).toMatchObject({
      returnToList: true,
    });
    expect(forceVerifyAttendee).not.toHaveBeenCalled();
  });

  it.each([
    new ApiError('stale', 409, 'membership_changed'),
    new ApiError('lost answer'),
    new ApiError('timeout', undefined, undefined, true),
    new ApiError('server failed', 500, 'internal_error'),
  ])(
    'never retries a stale or uncertain manual write and requires a successful refresh',
    async (error) => {
      await seed();
      jest.mocked(forceVerifyAttendee).mockRejectedValue(error);
      get.mockRejectedValue(new ApiError('refresh failed'));
      expect(await saveAttendeeAction(EVENT, filters, TARGET, { kind: 'verify' })).toMatchObject({
        ok: false,
      });
      expect(forceVerifyAttendee).toHaveBeenCalledTimes(1);
      await saveAttendeeAction(EVENT, filters, TARGET, { kind: 'verify' });
      expect(forceVerifyAttendee).toHaveBeenCalledTimes(1);
    },
  );
});
