import { z } from 'zod';

import { EventName, MAX_SUB_EVENTS } from './event';

// The venue's 32 random bytes, encoded without changing case or padding (D-156).
const VenueQrSecret = z.string().regex(/^[0-9a-f]{64}$/);

/** The printed JSON carries no sub-event, account or scan time (D-85, D-156). */
export const VenueQrPayload = z.strictObject({
  kind: z.literal('venue_check_in'),
  version: z.literal(1),
  venueId: z.uuid(),
  secret: VenueQrSecret,
});
export type VenueQrPayload = z.infer<typeof VenueQrPayload>;

/** The active Admin's credential for one venue. Its payload must name that venue (D-156). */
export const ManagedVenueQr = z
  .object({
    venueId: z.uuid(),
    venueName: EventName,
    payload: VenueQrPayload,
  })
  .refine((qr) => qr.venueId.toLowerCase() === qr.payload.venueId.toLowerCase(), {
    path: ['payload', 'venueId'],
    message: 'Expected the payload to name its managed venue',
  });
export type ManagedVenueQr = z.infer<typeof ManagedVenueQr>;

/**
 * GET /events/{eventId}/venue-qrs has no body. It returns one credential per venue to the active
 * Admin, including on archived events. Unknown or deleted events return 404 `not_found`, inactive
 * or absent members return 403 `not_member`, and other active roles return 403 `wrong_role`.
 * Managed credentials stay in account-scoped memory; responses use no-store (D-156, hb §5.3).
 */
export const ListVenueQrsResponse = z.object({
  venueQrs: z
    .array(ManagedVenueQr)
    .min(1)
    .max(MAX_SUB_EVENTS)
    .refine((qrs) => new Set(qrs.map((qr) => qr.venueId.toLowerCase())).size === qrs.length, {
      message: 'Expected one QR per venue',
    }),
});
export type ListVenueQrsResponse = z.infer<typeof ListVenueQrsResponse>;

/**
 * POST /events/{eventId}/venue-qrs/{venueId}/regenerate replaces the displayed secret. A stale
 * secret returns 409 `venue_qr_changed` without a write. Refetch before another explicit action
 * and after an uncertain result; never queue or retry an uncertain rotation (D-156, hb §5.3).
 */
export const RegenerateVenueQrRequest = z.strictObject({
  expectedSecret: VenueQrSecret,
});
export type RegenerateVenueQrRequest = z.infer<typeof RegenerateVenueQrRequest>;

/**
 * The replacement after commit. Access refusals match ListVenueQrsResponse; a venue outside the
 * event returns 404 `not_found`. Old posters and unsubmitted scans stop working, while recorded
 * check-ins remain. Role invites and memberships do not change (D-156).
 */
export const RegenerateVenueQrResponse = z.object({
  venueQr: ManagedVenueQr,
});
export type RegenerateVenueQrResponse = z.infer<typeof RegenerateVenueQrResponse>;
