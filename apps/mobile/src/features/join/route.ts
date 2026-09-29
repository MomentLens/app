import type { Membership } from '@momentlens/shared-types';

export type JoinDestination = 'confirm' | 'event' | 'pending' | 'blocked';

// Where a resolved invite sends a signed-in caller, by their own membership in its event (D-115).
// Someone with no row, or a removed member, sees Join Confirmation. A member skips the join
// whatever their role, so an Admin who opens their own Guest Link lands on the event (spec §2.4).
export function joinDestination(membership: Membership | null): JoinDestination {
  if (membership === null) {
    return 'confirm';
  }
  switch (membership.status) {
    case 'active':
      return 'event';
    case 'pending':
      return 'pending';
    case 'blocked':
      return 'blocked';
    case 'removed':
      return 'confirm';
  }
}
