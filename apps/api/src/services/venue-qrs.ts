import { z } from 'zod';

import { ListVenueQrsResponse, ManagedVenueQr, VenueQrPayload } from '@momentlens/shared-types';
import type { RegenerateVenueQrRequest, RegenerateVenueQrResponse } from '@momentlens/shared-types';

import type { Supabase } from '../db/supabase';
import { ApiError } from '../middleware/errors';

const Refusal = z.enum(['not_found', 'not_member', 'wrong_role']);
const Credential = z
  .object({
    venue_id: z.uuid(),
    venue_name: z.string(),
    secret: VenueQrPayload.shape.secret,
  })
  .transform((row) => ({
    venueId: row.venue_id,
    venueName: row.venue_name,
    payload: {
      kind: 'venue_check_in' as const,
      version: 1 as const,
      venueId: row.venue_id,
      secret: row.secret,
    },
  }))
  .pipe(ManagedVenueQr);
const ListResult = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('listed'),
      venue_qrs: z.array(Credential).pipe(ListVenueQrsResponse.shape.venueQrs),
    })
    .transform((row) => ({ outcome: row.outcome, venueQrs: row.venue_qrs })),
  z.object({ outcome: Refusal }),
]);
const RegenerateResult = z.discriminatedUnion('outcome', [
  z
    .object({ outcome: z.literal('regenerated'), venue_qr: Credential })
    .transform((row) => ({ outcome: row.outcome, venueQr: row.venue_qr })),
  z.object({ outcome: Refusal.or(z.enum(['invalid_request', 'venue_qr_changed'])) }),
]);

export interface VenueQrStore {
  list(eventId: string, actorId: string): Promise<z.infer<typeof ListResult>>;
  regenerate(
    eventId: string,
    actorId: string,
    venueId: string,
    request: RegenerateVenueQrRequest,
  ): Promise<z.infer<typeof RegenerateResult>>;
}

// Database errors and invalid results can contain credential values. Drop those details before
// errors reach the logger or Sentry (D-156). Refusals remain typed outcomes.
async function call<T extends z.ZodType>(
  supabase: Supabase,
  name: string,
  params: Record<string, unknown>,
  schema: T,
): Promise<z.output<T>> {
  try {
    const result = await supabase.rpc(name, params);
    if (result.error) throw new Error('RPC refused');
    return schema.parse(result.data as unknown);
  } catch {
    throw new Error(`${name} failed`);
  }
}

// SQL checks the authenticated actor in the same snapshot as the list, or under the event lock
// for rotation. These RPCs execute only with the service key (D-73, D-95, D-156).
export function createVenueQrStore(supabase: Supabase): VenueQrStore {
  return {
    list: (eventId, actorId) =>
      call(supabase, 'list_venue_qrs', { p_event_id: eventId, p_actor_id: actorId }, ListResult),
    async regenerate(eventId, actorId, venueId, request) {
      const row = await call(
        supabase,
        'regenerate_venue_qr',
        {
          p_event_id: eventId,
          p_actor_id: actorId,
          p_venue_id: venueId,
          p_expected_secret: request.expectedSecret,
        },
        RegenerateResult,
      );
      if (
        row.outcome === 'regenerated' &&
        row.venueQr.venueId.toLowerCase() !== venueId.toLowerCase()
      ) {
        throw new Error('regenerate_venue_qr returned another venue');
      }
      return row;
    },
  };
}

export async function listVenueQrs(
  store: VenueQrStore,
  eventId: string,
  actorId: string,
): Promise<ListVenueQrsResponse> {
  const result = await store.list(eventId, actorId);
  if (result.outcome !== 'listed') throw new ApiError(result.outcome, 'Venue QR list refused');
  return { venueQrs: result.venueQrs };
}

export async function regenerateVenueQr(
  store: VenueQrStore,
  eventId: string,
  actorId: string,
  venueId: string,
  request: RegenerateVenueQrRequest,
): Promise<RegenerateVenueQrResponse> {
  const result = await store.regenerate(eventId, actorId, venueId, request);
  if (result.outcome !== 'regenerated')
    throw new ApiError(result.outcome, 'Venue QR replacement refused');
  return { venueQr: result.venueQr };
}
