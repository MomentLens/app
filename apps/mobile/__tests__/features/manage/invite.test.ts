import { describe, expect, it } from '@jest/globals';
import type { ManagedInvite } from '@momentlens/shared-types';

import {
  inviteLink,
  inviteProblem,
  inviteShareMessage,
  replacementMessage,
} from '@/features/manage/invite';

const invite: ManagedInvite = {
  id: '11111111-1111-4111-8111-111111111111',
  role: 'photographer',
  token: 'a'.repeat(43),
  code: 'K7Q2XP',
};

describe('managed invite copy', () => {
  it('shares the role, event name, complete app link and six-character code', () => {
    const message = inviteShareMessage('Ayesha & Bilal', invite);
    expect(message).toContain('Photographer');
    expect(message).toContain('Ayesha & Bilal');
    expect(message).toContain(`momentlens://invite/${invite.token}`);
    expect(message).toContain('K7Q2XP');
    expect(inviteLink(invite)).toBe(`momentlens://invite/${invite.token}`);
  });

  it('labels the Guest payload separately', () => {
    expect(inviteShareMessage('Ayesha & Bilal', { ...invite, role: 'guest' })).toContain('Guest');
  });

  it('explains that both old credentials stop working and members keep access', () => {
    const message = replacementMessage('photographer');
    expect(message).toContain('link and code');
    expect(message).toContain('stop working');
    expect(message).toContain('Existing members keep their access');
  });

  it('never claims a timed-out or unreachable replacement did not happen', () => {
    for (const failure of [{ timedOut: true }, {}]) {
      expect(inviteProblem(failure, 'replace')).toContain('may have changed');
      expect(inviteProblem(failure, 'replace')).not.toContain('nothing');
    }
  });

  it('requires a refresh after a conflicting replacement', () => {
    expect(inviteProblem({ code: 'invite_changed', status: 409 }, 'replace')).toContain('changed');
  });
});
