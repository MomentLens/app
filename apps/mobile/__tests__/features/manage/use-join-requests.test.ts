import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { ListPendingRequestsResponse, PendingRequest } from '@momentlens/shared-types';
import { InfiniteQueryObserver, onlineManager, type InfiniteData } from '@tanstack/react-query';

import { eventQueryKey } from '@/features/event-shell/use-event';
import { attendeesQueryKey } from '@/features/manage/use-attendees';
import { eventSettingsQueryKey } from '@/features/manage/use-event-settings';
import {
  joinRequestsQueryKey,
  joinRequestQueryOptions,
  loadedRequests,
  pendingRequests,
  requestTarget,
  requestAge,
  selectLoadedRequests,
  retainRequestSelection,
  saveJoinRequestAction,
} from '@/features/manage/use-join-requests';
import {
  ApiError,
  approveRequests,
  rejectRequests,
  blockRequest,
  listPendingRequests,
} from '@/lib/api';
import { queryClient } from '@/lib/query-client';
import { useAuthStore } from '@/stores/auth';

jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({ getString: () => undefined, set: () => undefined, remove: () => true }),
}));
jest.mock('@/lib/supabase', () => ({ supabase: { auth: {} } }));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual<object>('@/lib/api'),
  listPendingRequests: jest.fn(),
  approveRequests: jest.fn(),
  rejectRequests: jest.fn(),
  blockRequest: jest.fn(),
}));

const EVENT = '0b6f1c2a-3d4e-4f5a-8b9c-0d1e2f3a4b5c';
const TARGET: PendingRequest = {
  userId: '11111111-1111-4111-8111-111111111111',
  fullName: 'Areeba Hussain',
  role: 'guest',
  requestedAt: '2026-10-04T13:00:00.000Z',
  accessVersion: 'opaque-1',
  avatar: null,
};
const PHOTO: PendingRequest = {
  ...TARGET,
  userId: '22222222-2222-4222-8222-222222222222',
  fullName: 'Faisal Iqbal',
  role: 'photographer',
};
const get = jest.mocked(listPendingRequests);
const approve = jest.mocked(approveRequests);
const reject = jest.mocked(rejectRequests);
const block = jest.mocked(blockRequest);
const confirm = jest.fn<() => Promise<boolean>>();
const key = joinRequestsQueryKey(EVENT);
const page = (
  requests: PendingRequest[] = [TARGET],
  guestPlacesLeft = 3,
): ListPendingRequestsResponse => ({ requests, guestPlacesLeft, nextCursor: null });
let unwatch: (() => void) | undefined;

async function seed(requests = [TARGET]) {
  queryClient.setQueryData(eventQueryKey(EVENT), { event: { role: 'admin' } });
  get.mockResolvedValue(page(requests));
  unwatch = new InfiniteQueryObserver(queryClient, joinRequestQueryOptions(EVENT)).subscribe(
    () => undefined,
  );
  await queryClient.fetchInfiniteQuery(joinRequestQueryOptions(EVENT));
  get.mockClear();
  confirm.mockResolvedValue(true);
}

afterEach(() => {
  unwatch?.();
  unwatch = undefined;
  queryClient.clear();
  onlineManager.setOnline(true);
  jest.resetAllMocks();
});

describe('pending request reads and selection', () => {
  it('moves a re-made request to its later page position instead of its old place in the queue', () => {
    const remade = { ...TARGET, requestedAt: '2026-10-04T13:01:00.000Z', accessVersion: 'remade' };
    expect(
      pendingRequests({
        pages: [page([TARGET, PHOTO]), page([remade])],
        pageParams: [undefined, 'next'],
      }),
    ).toEqual([PHOTO, remade]);
  });
  it.each([
    [-1, 'Just now'],
    [0, 'Just now'],
    [59, '59 min ago'],
    [60, '1 hour ago'],
    [120, '2 hours ago'],
    [1440, '1 day ago'],
    [2880, '2 days ago'],
  ])('shows the request age at %s minutes', (minutes, expected) => {
    expect(
      requestAge(TARGET.requestedAt, new Date(TARGET.requestedAt).getTime() + minutes * 60_000),
    ).toBe(expected);
  });
  it('passes the cursor unchanged, stops at null and never persists', async () => {
    get.mockResolvedValue({ ...page(), nextCursor: 'opaque/page+2' });
    const options = joinRequestQueryOptions(EVENT);
    await queryClient.fetchInfiniteQuery(options);
    expect(get).toHaveBeenCalledWith(EVENT, { cursor: undefined }, expect.anything());
    expect(options.getNextPageParam({ ...page(), nextCursor: 'opaque/page+2' })).toBe(
      'opaque/page+2',
    );
    expect(options.getNextPageParam(page())).toBeUndefined();
    expect(queryClient.getQueryCache().find({ queryKey: key })?.meta?.persist).not.toBe(true);
  });
  it.each([403, 404])('rechecks the shell on a %s list refusal', async (status) => {
    queryClient.setQueryData(eventQueryKey(EVENT), { event: { role: 'admin' } });
    get.mockRejectedValue(new ApiError('refused', status));
    await expect(queryClient.fetchInfiniteQuery(joinRequestQueryOptions(EVENT))).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(eventQueryKey(EVENT))?.isInvalidated).toBe(true);
  });
  it('deduplicates overlapping pages using the later version without crossing events', async () => {
    await seed();
    queryClient.setQueryData<InfiniteData<ListPendingRequestsResponse>>(key, {
      pages: [page([TARGET]), page([{ ...TARGET, accessVersion: 'new' }, PHOTO])],
      pageParams: [undefined, 'next'],
    });
    expect(loadedRequests(EVENT)).toEqual([{ ...TARGET, accessVersion: 'new' }, PHOTO]);
    expect(loadedRequests('other-event')).toEqual([]);
    expect(retainRequestSelection([requestTarget(TARGET)], loadedRequests(EVENT))).toEqual([]);
  });
  it('selects at most 50 loaded requests and drops missing or replaced selections', () => {
    const people = Array.from({ length: 51 }, (_, i) => ({ ...TARGET, userId: String(i) }));
    expect(selectLoadedRequests(people)).toHaveLength(50);
    expect(selectLoadedRequests([])).toEqual([]);
    expect(selectLoadedRequests([TARGET])).toEqual([requestTarget(TARGET)]);
    expect(retainRequestSelection([requestTarget(TARGET), requestTarget(PHOTO)], [PHOTO])).toEqual([
      requestTarget(PHOTO),
    ]);
  });
});

describe('pending request writes', () => {
  it('refuses offline, wrong roles, stale queries and stale targets without queueing', async () => {
    await seed();
    onlineManager.setOnline(false);
    await saveJoinRequestAction(EVENT, [requestTarget(TARGET)], 'approve', confirm);
    onlineManager.setOnline(true);
    for (const role of ['guest', 'photographer']) {
      queryClient.setQueryData(eventQueryKey(EVENT), { event: { role } });
      await saveJoinRequestAction(EVENT, [requestTarget(TARGET)], 'approve', confirm);
    }
    queryClient.setQueryData(eventQueryKey(EVENT), { event: { role: 'admin' } });
    await saveJoinRequestAction(
      EVENT,
      [{ ...requestTarget(TARGET), expectedVersion: 'old' }],
      'approve',
      confirm,
    );
    await queryClient.invalidateQueries({ queryKey: key, refetchType: 'none' });
    await saveJoinRequestAction(EVENT, [requestTarget(TARGET)], 'approve', confirm);
    expect(approve).not.toHaveBeenCalled();
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });
  it('rejects zero, duplicate, oversized and bulk-block targets locally', async () => {
    await seed([TARGET, PHOTO]);
    for (const targets of [
      [],
      [requestTarget(TARGET), requestTarget(TARGET)],
      Array(51).fill(requestTarget(TARGET)),
    ]) {
      expect(await saveJoinRequestAction(EVENT, targets, 'approve', confirm)).toMatchObject({
        ok: false,
      });
    }
    expect(
      await saveJoinRequestAction(
        EVENT,
        [requestTarget(TARGET), requestTarget(PHOTO)],
        'block',
        confirm,
      ),
    ).toMatchObject({ ok: false });
    expect(approve).not.toHaveBeenCalled();
    expect(block).not.toHaveBeenCalled();
  });
  it('approves Guests without confirmation, sends versions once and refreshes related lists', async () => {
    await seed();
    queryClient.setQueryData(eventSettingsQueryKey(EVENT), { pendingCount: 1 });
    queryClient.setQueryData(attendeesQueryKey(EVENT), { pages: [], pageParams: [] });
    get.mockResolvedValue(page([]));
    expect(await saveJoinRequestAction(EVENT, [requestTarget(TARGET)], 'approve', confirm)).toEqual(
      { ok: true },
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledWith(EVENT, { targets: [requestTarget(TARGET)] });
    expect(loadedRequests(EVENT)).toEqual([]);
    expect(queryClient.getQueryState(eventSettingsQueryKey(EVENT))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(attendeesQueryKey(EVENT))?.isInvalidated).toBe(true);
  });
  it('names Photographers before approval and sends nothing when cancelled', async () => {
    await seed([PHOTO]);
    confirm.mockResolvedValue(false);
    expect(await saveJoinRequestAction(EVENT, [requestTarget(PHOTO)], 'approve', confirm)).toEqual({
      ok: false,
      cancelled: true,
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Faisal Iqbal') }),
    );
    expect(approve).not.toHaveBeenCalled();
  });
  it('rechecks a request after confirmation instead of approving its replacement', async () => {
    await seed([PHOTO]);
    confirm.mockImplementation(async () => {
      queryClient.setQueryData(key, {
        pages: [page([{ ...PHOTO, accessVersion: 'rejoined' }])],
        pageParams: [undefined],
      });
      return true;
    });
    expect(
      await saveJoinRequestAction(EVENT, [requestTarget(PHOTO)], 'approve', confirm),
    ).toMatchObject({ ok: false });
    expect(approve).not.toHaveBeenCalled();
  });

  it.each(['offline', 'role', 'account'] as const)(
    'refuses approval when %s changes during confirmation',
    async (change) => {
      await seed([PHOTO]);
      const owner = useAuthStore.getState().userId;
      confirm.mockImplementation(async () => {
        if (change === 'offline') onlineManager.setOnline(false);
        if (change === 'role')
          queryClient.setQueryData(eventQueryKey(EVENT), { event: { role: 'guest' } });
        if (change === 'account') useAuthStore.setState({ userId: 'other-user' });
        return true;
      });
      try {
        expect(
          await saveJoinRequestAction(EVENT, [requestTarget(PHOTO)], 'approve', confirm),
        ).toMatchObject({ ok: false });
        expect(approve).not.toHaveBeenCalled();
      } finally {
        useAuthStore.setState({ userId: owner });
      }
    },
  );

  it('does not report cached Guest places when a cap refusal cannot refresh', async () => {
    await seed();
    approve.mockRejectedValue(new ApiError('full', 422, 'event_full'));
    get.mockRejectedValue(new ApiError('offline'));
    const result = await saveJoinRequestAction(EVENT, [requestTarget(TARGET)], 'approve', confirm);
    expect(result).toMatchObject({ ok: false, problem: expect.stringContaining('Refresh to see') });
    expect(result).not.toMatchObject({ problem: expect.stringContaining('3 Guest') });
  });
  it('rejects without asking and blocks one person only after confirmation', async () => {
    await seed();
    await saveJoinRequestAction(EVENT, [requestTarget(TARGET)], 'reject', confirm);
    expect(confirm).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledTimes(1);
    await saveJoinRequestAction(EVENT, [requestTarget(TARGET)], 'block', confirm);
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('Block') }),
    );
    expect(block).toHaveBeenCalledWith(EVENT, TARGET.userId, {
      expectedVersion: TARGET.accessVersion,
    });
  });
  it.each([
    new ApiError('stale', 409, 'membership_changed'),
    new ApiError('lost response'),
    new ApiError('timeout', undefined, undefined, true),
    new ApiError('bad JSON', 200),
    new ApiError('server', 500, 'internal_error'),
  ])(
    'never retries an uncertain write and prevents further writes if refresh fails',
    async (error) => {
      await seed();
      approve.mockRejectedValue(error);
      get.mockRejectedValue(new ApiError('offline'));
      expect(
        await saveJoinRequestAction(EVENT, [requestTarget(TARGET)], 'approve', confirm),
      ).toMatchObject({ ok: false });
      expect(get).toHaveBeenCalled();
      await saveJoinRequestAction(EVENT, [requestTarget(TARGET)], 'approve', confirm);
      expect(approve).toHaveBeenCalledTimes(1);
    },
  );
  it('shows fresh Guest places after a cap refusal and leaves the batch unchanged', async () => {
    await seed();
    approve.mockRejectedValue(new ApiError('full', 422, 'event_full'));
    get.mockResolvedValue(page([TARGET], 1));
    expect(
      await saveJoinRequestAction(EVENT, [requestTarget(TARGET)], 'approve', confirm),
    ).toMatchObject({ ok: false, problem: expect.stringContaining('1 Guest place') });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(loadedRequests(EVENT)).toEqual([TARGET]);
  });
  it.each([403, 404])('rechecks the Event shell after a %s action refusal', async (status) => {
    await seed();
    approve.mockRejectedValue(new ApiError('refused', status));
    await saveJoinRequestAction(EVENT, [requestTarget(TARGET)], 'approve', confirm);
    expect(queryClient.getQueryState(eventQueryKey(EVENT))?.isInvalidated).toBe(true);
  });
  it('blocks a second action while a Photographer confirmation is open', async () => {
    await seed([PHOTO]);
    let answer!: (value: boolean) => void;
    confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const first = saveJoinRequestAction(EVENT, [requestTarget(PHOTO)], 'approve', confirm);
    expect(
      await saveJoinRequestAction(EVENT, [requestTarget(PHOTO)], 'reject', confirm),
    ).toMatchObject({ ok: false });
    answer(true);
    await first;
    expect(approve).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();
  });
});
