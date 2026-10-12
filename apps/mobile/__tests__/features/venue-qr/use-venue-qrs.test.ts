import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ListVenueQrsResponse, ManagedVenueQr } from '@momentlens/shared-types';
import { onlineManager } from '@tanstack/react-query';
import {
  freshVenueQrs,
  rotateVenueQr,
  venueQrQueryKey,
  venueQrQueryOptions,
  exportVenueQr,
} from '@/features/venue-qr/use-venue-qrs';
import { ApiError, listVenueQrs, regenerateVenueQr } from '@/lib/api';
import { persistOptions, queryClient } from '@/lib/query-client';
import { useAuthStore } from '@/stores/auth';

jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({ getString: () => undefined, set: () => {}, remove: () => true }),
}));
jest.mock('@/lib/supabase', () => ({ supabase: { auth: {} } }));
jest.mock('@/lib/api', () => ({
  ...jest.requireActual<object>('@/lib/api'),
  listVenueQrs: jest.fn(),
  regenerateVenueQr: jest.fn(),
}));
jest.mock('expo-file-system', () => ({
  File: class {
    uri = 'file:///qr.png';
    create() {}
    write() {}
    delete() {}
  },
  Paths: { cache: 'file:///cache' },
}));
const mockShare = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
jest.mock('expo-sharing', () => ({
  isAvailableAsync: async () => true,
  shareAsync: () => mockShare(),
}));
const EVENT = '11111111-1111-4111-8111-111111111111';
const VENUE = '22222222-2222-4222-8222-222222222222';
const OWNER = 'A';
const qr: ManagedVenueQr = {
  venueId: VENUE,
  venueName: 'Hall',
  payload: { kind: 'venue_check_in', version: 1, venueId: VENUE, secret: 'a'.repeat(64) },
};
const replacement = { ...qr, payload: { ...qr.payload, secret: 'b'.repeat(64) } };
const mockList = jest.mocked(listVenueQrs);
const mockRotate = jest.mocked(regenerateVenueQr);
beforeEach(() => {
  useAuthStore.setState({ userId: OWNER, status: 'signedIn' });
  onlineManager.setOnline(true);
  mockList.mockResolvedValue({ venueQrs: [qr] });
  mockRotate.mockResolvedValue({ venueQr: replacement });
});
afterEach(() => {
  queryClient.clear();
  jest.clearAllMocks();
  onlineManager.setOnline(true);
});
function seed() {
  queryClient.setQueryData(venueQrQueryKey(EVENT, OWNER), { venueQrs: [qr] });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('managed venue credentials', () => {
  it('refetches on mount, foreground and reconnect without persisting a secret', async () => {
    const options = venueQrQueryOptions(EVENT, OWNER);
    expect(options.refetchOnMount).toBe('always');
    expect(options.refetchOnWindowFocus).toBe('always');
    expect(options.refetchOnReconnect).toBe('always');
    await queryClient.fetchQuery(options);
    const query = queryClient.getQueryCache().find({ queryKey: options.queryKey });
    expect(persistOptions.dehydrateOptions?.shouldDehydrateQuery?.(query!)).toBe(false);
    expect(venueQrQueryKey(EVENT, 'B')).not.toEqual(options.queryKey);
  });
  it('refuses print export offline despite a cached secret', async () => {
    seed();
    onlineManager.setOnline(false);
    const render = jest.fn(async () => 'png');
    expect((await exportVenueQr(EVENT, VENUE, OWNER, render)).ok).toBe(false);
    expect(render).not.toHaveBeenCalled();
    expect(mockShare).not.toHaveBeenCalled();
  });
  it('prints only a fresh online credential', async () => {
    seed();
    mockList.mockResolvedValue({ venueQrs: [replacement] });
    const render = jest.fn(async () => 'cG5n');
    expect((await exportVenueQr(EVENT, VENUE, OWNER, render)).ok).toBe(true);
    expect(render).toHaveBeenCalledWith(replacement);
    expect(mockShare).toHaveBeenCalledTimes(1);
  });
  it('does not export a late result under another account', async () => {
    const pending = deferred<ListVenueQrsResponse>();
    const started = deferred<void>();
    mockList.mockImplementation(() => {
      started.resolve();
      return pending.promise;
    });
    const render = jest.fn(async () => 'png');
    const printing = exportVenueQr(EVENT, VENUE, OWNER, render);
    await started.promise;
    useAuthStore.setState({ userId: 'B' });
    pending.resolve({ venueQrs: [qr] });
    expect((await printing).ok).toBe(false);
    expect(render).not.toHaveBeenCalled();
    expect(mockShare).not.toHaveBeenCalled();
  });
  it('never retries an uncertain rotation, and refreshes before another action', async () => {
    seed();
    mockRotate.mockRejectedValue(new ApiError('timeout', undefined, undefined, true));
    expect((await rotateVenueQr(EVENT, qr, OWNER)).ok).toBe(false);
    expect(mockRotate).toHaveBeenCalledTimes(1);
    expect(mockList).toHaveBeenCalledTimes(1);
  });
  it('refuses stale displayed credentials without rotating', async () => {
    seed();
    expect((await rotateVenueQr(EVENT, replacement, OWNER)).ok).toBe(false);
    expect(mockRotate).not.toHaveBeenCalled();
  });
  it('a read started before rotation cannot overwrite the new credential', async () => {
    seed();
    const pending = deferred<ListVenueQrsResponse>();
    const started = deferred<void>();
    mockList.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    const oldRead = freshVenueQrs(EVENT, OWNER).catch(() => undefined);
    await started.promise;
    expect((await rotateVenueQr(EVENT, qr, OWNER)).ok).toBe(true);
    pending.resolve({ venueQrs: [qr] });
    await oldRead;
    expect(
      queryClient.getQueryData<ListVenueQrsResponse>(venueQrQueryKey(EVENT, OWNER))?.venueQrs[0]
        ?.payload.secret,
    ).toBe(replacement.payload.secret);
  });
});
