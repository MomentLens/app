import {
  EventName,
  InviteLookup,
  InviteRole,
  type InviteLookup as Lookup,
} from '@momentlens/shared-types';
import { useMemo } from 'react';
import { createMMKV, useMMKVString } from 'react-native-mmkv';

// The invite someone opened and has not yet joined, dismissed or logged out on (D-115). It lives in
// MMKV so killing the app during signup loses nothing: the signup banner and Join Confirmation
// both read it back. The name and role are kept only for the banner, which shows before a session
// exists; Join Confirmation asks the API again.
export interface PendingInvite {
  lookup: Lookup;
  eventName: string;
  role: InviteRole;
}

const KEY = 'pending-invite';
const storage = createMMKV({ id: 'join' });

// Anything in storage that is not a whole, valid invite reads as none. It came from an older build
// or a bug, and a join through it would only fail.
function parse(raw: string | undefined): PendingInvite | null {
  if (raw === undefined) {
    return null;
  }
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof stored !== 'object' || stored === null) {
    return null;
  }
  const fields = stored as Record<string, unknown>;
  const lookup = InviteLookup.safeParse(fields.lookup);
  const eventName = EventName.safeParse(fields.eventName);
  const role = InviteRole.safeParse(fields.role);
  if (!lookup.success || !eventName.success || !role.success) {
    return null;
  }
  return { lookup: lookup.data, eventName: eventName.data, role: role.data };
}

export function savePendingInvite(invite: PendingInvite): void {
  storage.set(KEY, JSON.stringify(invite));
}

export function readPendingInvite(): PendingInvite | null {
  return parse(storage.getString(KEY));
}

export function clearPendingInvite(): void {
  storage.remove(KEY);
}

// The same, as a hook that re-renders when the invite is saved or cleared, for the banner.
export function usePendingInvite(): PendingInvite | null {
  const [raw] = useMMKVString(KEY, storage);
  return useMemo(() => parse(raw), [raw]);
}
