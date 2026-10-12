import type { VenueQrPayload } from '@momentlens/shared-types';

export const PRINT_QR_SIZE = 1024;
export const PRINT_QUIET_ZONE = 128;
export type QrOutcome<T> = { ok: true; value: T } | { ok: false; problem: string };

export function printedPayload(payload: VenueQrPayload): string {
  return JSON.stringify(payload);
}
export const ROTATION_MESSAGE =
  'Old posters and scans not yet sent to the server will stop working. People already checked in stay checked in. Print and display the new code after replacing it.';

export function venueQrProblem(
  error: { status?: number; code?: unknown },
  action: 'read' | 'replace' | 'export',
): string {
  if (error.code === 'venue_qr_changed')
    return 'This venue code changed on another phone. Refresh it before trying again.';
  if (error.status === 403)
    return "Only this event's Admin can manage its venue codes. Your access may have changed.";
  if (error.status === 404) return 'This event or venue is no longer available.';
  if (error.status === 401) return 'Sign in again before managing venue codes.';
  if (action === 'replace')
    return 'The replacement could not be confirmed. Refresh the code before another action.';
  if (action === 'export')
    return 'The print image could not be shared. Check the connection and try again.';
  return 'Venue codes need a connection. Reconnect and refresh.';
}
