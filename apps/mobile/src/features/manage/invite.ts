import type { InviteRole, ManagedInvite } from '@momentlens/shared-types';

export type InviteOutcome<T> = { ok: true; value: T } | { ok: false; problem: string };
export type InviteAction = 'code' | 'link' | 'share';

export function inviteRoleName(role: InviteRole): string {
  return role === 'guest' ? 'Guest' : 'Photographer';
}

export function inviteLink(invite: ManagedInvite): string {
  return `momentlens://invite/${invite.token}`;
}

export function inviteShareMessage(eventName: string, invite: ManagedInvite): string {
  return `${inviteRoleName(invite.role)} invite for ${eventName}\n${inviteLink(invite)}\nJoin with code ${invite.code}`;
}

export function replacementMessage(role: InviteRole): string {
  return `The current ${inviteRoleName(role)} link and code will stop working. Existing members keep their access. Share the new link or code afterward.`;
}

export function inviteProblem(
  failure: { status?: number; code?: string; timedOut?: boolean },
  action: 'read' | 'replace',
): string {
  if (failure.status === 401) return 'Sign in again to manage invites.';
  if (failure.status === 403) return 'You can no longer manage invites for this event.';
  if (failure.status === 404) return 'This event is no longer available.';
  if (failure.code === 'invite_changed') {
    return 'This invite changed on another device. Refresh before replacing it again.';
  }
  if (action === 'replace') {
    return 'The invite may have changed. Refresh to check its current link and code before another action.';
  }
  return 'Could not refresh the invites. Check your connection and try again.';
}
