import { describe, expect, it } from '@jest/globals';

import { joinDestination } from '@/features/join/route';

// Where a resolved invite sends a signed-in caller, by their own membership (D-115).
describe('joinDestination', () => {
  it('shows Join Confirmation to someone with no row in the event', () => {
    expect(joinDestination(null)).toBe('confirm');
  });

  it('shows Join Confirmation to a removed member, who may join again (D-102)', () => {
    expect(joinDestination({ role: 'guest', status: 'removed' })).toBe('confirm');
  });

  it('skips the join for an active member, whatever their role', () => {
    expect(joinDestination({ role: 'guest', status: 'active' })).toBe('event');
    expect(joinDestination({ role: 'admin', status: 'active' })).toBe('event');
    expect(joinDestination({ role: 'photographer', status: 'active' })).toBe('event');
  });

  it('sends a requester back to Pending Approval', () => {
    expect(joinDestination({ role: 'guest', status: 'pending' })).toBe('pending');
  });

  it('shows Join Blocked to a blocked person, never Join Confirmation', () => {
    expect(joinDestination({ role: 'guest', status: 'blocked' })).toBe('blocked');
  });
});
