import type { ListVenueQrsResponse, ManagedVenueQr } from '@momentlens/shared-types';
import { onlineManager, useQuery } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { recheckEvent } from '@/features/event-shell/use-event';
import { AccountChangedError, ApiError, listVenueQrs, regenerateVenueQr } from '@/lib/api';
import { queryClient } from '@/lib/query-client';
import { useAuthStore } from '@/stores/auth';
import { venueQrProblem, type QrOutcome } from './venue-qr';

let generation = 0;
useAuthStore.subscribe((current, previous) => {
  if (current.userId !== previous.userId || current.status !== previous.status) generation++;
});
const rotating = new Set<string>();
export function venueQrQueryKey(eventId: string, owner: string | null) {
  return ['managed-venue-qrs', owner, eventId] as const;
}
function requireAccount(owner: string | null, started = generation): asserts owner is string {
  const state = useAuthStore.getState();
  if (!owner || state.userId !== owner || state.status !== 'signedIn' || started !== generation)
    throw new AccountChangedError();
}
function requireOnline() {
  if (!onlineManager.isOnline()) throw new ApiError('Venue codes require an online read.');
}
function recheck(eventId: string, error: unknown) {
  if (error instanceof ApiError && (error.status === 403 || error.status === 404))
    recheckEvent(eventId);
}
function problem(error: unknown, action: 'read' | 'replace' | 'export') {
  return error instanceof AccountChangedError
    ? 'The signed-in account changed. Open this screen again.'
    : venueQrProblem(error instanceof ApiError ? error : {}, action);
}
export function venueQrQueryOptions(eventId: string, owner: string | null) {
  return {
    queryKey: venueQrQueryKey(eventId, owner),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const started = generation;
      requireAccount(owner);
      requireOnline();
      try {
        const data = await listVenueQrs(owner, eventId, signal);
        requireAccount(owner, started);
        return data;
      } catch (error) {
        recheck(eventId, error);
        throw error;
      }
    },
    enabled: owner !== null,
    staleTime: 0,
    gcTime: 0,
    meta: { persist: false },
    networkMode: 'always' as const,
    retry: false as const,
    refetchOnMount: 'always' as const,
    refetchOnWindowFocus: 'always' as const,
    refetchOnReconnect: 'always' as const,
  };
}
export function useVenueQrs(eventId: string, enabled = true) {
  const owner = useAuthStore((state) => state.userId);
  return useQuery({ ...venueQrQueryOptions(eventId, owner), enabled: enabled && owner !== null });
}
export async function freshVenueQrs(eventId: string, owner: string): Promise<ListVenueQrsResponse> {
  const started = generation;
  requireAccount(owner);
  requireOnline();
  const queryKey = venueQrQueryKey(eventId, owner);
  await queryClient.cancelQueries({ queryKey, exact: true });
  requireAccount(owner, started);
  return queryClient.fetchQuery(venueQrQueryOptions(eventId, owner));
}
export async function rotateVenueQr(
  eventId: string,
  displayed: ManagedVenueQr,
  owner: string,
): Promise<QrOutcome<ManagedVenueQr>> {
  const queryKey = venueQrQueryKey(eventId, owner);
  const operation = JSON.stringify(queryKey);
  const started = generation;
  let sent = false;
  let locked = false;
  try {
    requireAccount(owner);
    requireOnline();
    if (rotating.has(operation))
      return { ok: false, problem: 'A replacement is already running. Wait for its result.' };
    const state = queryClient.getQueryState<ListVenueQrsResponse>(queryKey);
    if (!state?.data || state.error || state.isInvalidated)
      return { ok: false, problem: 'Refresh the venue codes before replacing one.' };
    if (
      !state.data.venueQrs.some(
        (qr) => qr.venueId === displayed.venueId && qr.payload.secret === displayed.payload.secret,
      )
    )
      return { ok: false, problem: venueQrProblem({ code: 'venue_qr_changed' }, 'replace') };
    rotating.add(operation);
    locked = true;
    await queryClient.cancelQueries({ queryKey, exact: true });
    await queryClient.invalidateQueries({ queryKey, exact: true, refetchType: 'none' });
    requireAccount(owner, started);
    requireOnline();
    sent = true;
    const { venueQr } = await regenerateVenueQr(owner, eventId, displayed.venueId, {
      expectedSecret: displayed.payload.secret,
    });
    requireAccount(owner, started);
    await queryClient.cancelQueries({ queryKey, exact: true });
    requireAccount(owner, started);
    const current = queryClient.getQueryData<ListVenueQrsResponse>(queryKey);
    if (current)
      queryClient.setQueryData<ListVenueQrsResponse>(queryKey, {
        venueQrs: current.venueQrs.map((qr) => (qr.venueId === venueQr.venueId ? venueQr : qr)),
      });
    return { ok: true, value: venueQr };
  } catch (error) {
    recheck(eventId, error);
    if (sent && generation === started && useAuthStore.getState().userId === owner) {
      await queryClient.cancelQueries({ queryKey, exact: true });
      await queryClient.invalidateQueries({ queryKey, exact: true, refetchType: 'none' });
      await freshVenueQrs(eventId, owner).catch(() => undefined);
    }
    return { ok: false, problem: problem(error, sent ? 'replace' : 'read') };
  } finally {
    if (locked) rotating.delete(operation);
  }
}

export async function exportVenueQr(
  eventId: string,
  venueId: string,
  owner: string,
  render: (qr: ManagedVenueQr) => Promise<string>,
): Promise<QrOutcome<null>> {
  const started = generation;
  let file: File | undefined;
  try {
    requireAccount(owner);
    requireOnline();
    if (rotating.has(JSON.stringify(venueQrQueryKey(eventId, owner))))
      throw new ApiError('A replacement is running.');
    const fresh = await freshVenueQrs(eventId, owner);
    requireAccount(owner, started);
    requireOnline();
    const qr = fresh.venueQrs.find((item) => item.venueId.toLowerCase() === venueId.toLowerCase());
    if (!qr) throw new ApiError('The venue is missing.', 404, 'not_found');
    const png = await render(qr);
    requireAccount(owner, started);
    requireOnline();
    if (!(await Sharing.isAvailableAsync())) throw new ApiError('File sharing is unavailable.');
    requireAccount(owner, started);
    file = new File(Paths.cache, `venue-check-in-${randomUUID()}.png`);
    file.create();
    file.write(png, { encoding: 'base64' });
    await Sharing.shareAsync(file.uri, {
      mimeType: 'image/png',
      UTI: 'public.png',
      dialogTitle: `Print venue QR for ${qr.venueName}`,
    });
    return { ok: true, value: null };
  } catch (error) {
    recheck(eventId, error);
    return { ok: false, problem: problem(error, 'export') };
  } finally {
    // The exported poster carries the credential. Keep the cache file only while the native
    // share sheet needs it; the user's saved or printed copy belongs to the chosen destination.
    try {
      file?.delete();
    } catch {
      /* A cache cleanup failure must not retry sharing. */
    }
  }
}
