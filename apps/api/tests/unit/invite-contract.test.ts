import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from '@jest/globals';

import {
  ErrorResponse,
  ListInvitesResponse,
  ManagedInvite,
  RegenerateInviteRequest,
  RegenerateInviteResponse,
} from '@momentlens/shared-types';

const guest = {
  id: randomUUID(),
  role: 'guest',
  token: randomBytes(32).toString('base64url'),
  code: 'AB3K7X',
};
const photographer = {
  ...guest,
  id: randomUUID(),
  role: 'photographer',
  token: randomBytes(32).toString('base64url'),
  code: 'CD4N8Y',
};

it('accepts exactly one current invite per role in either order', () => {
  for (const invites of [
    [guest, photographer],
    [photographer, guest],
  ]) {
    expect(ListInvitesResponse.parse({ invites })).toEqual({ invites });
  }
});
it.each(
  [[], [guest], [guest, guest], [guest, photographer, guest]].map((invites) => ({ invites })),
)('refuses missing or duplicate roles $invites', ({ invites }) => {
  expect(ListInvitesResponse.safeParse({ invites }).success).toBe(false);
});
describe.each(['id', 'role', 'token', 'code'])('managed invite %s', (field) => {
  it('refuses a malformed credential', () => {
    expect(ManagedInvite.safeParse({ ...guest, [field]: 'bad' }).success).toBe(false);
  });
  it('requires the field', () => {
    const input: Record<string, unknown> = { ...guest };
    delete input[field];
    expect(ManagedInvite.safeParse(input).success).toBe(false);
  });
});
it.each([
  {},
  { role: 'admin', expectedInviteId: guest.id },
  { role: 'guest', expectedInviteId: 'bad' },
  { role: 'guest', expectedInviteId: guest.id, actorId: randomUUID() },
])('refuses malformed or extra rotation input %j', (input) => {
  expect(RegenerateInviteRequest.safeParse(input).success).toBe(false);
});
it('accepts both role requests and replacement envelopes', () => {
  for (const invite of [guest, photographer]) {
    expect(
      RegenerateInviteRequest.parse({ role: invite.role, expectedInviteId: invite.id }),
    ).toEqual({ role: invite.role, expectedInviteId: invite.id });
    expect(RegenerateInviteResponse.parse({ invite })).toEqual({ invite });
  }
});
it('drops unknown response fields and supports invite_changed', () => {
  expect(
    RegenerateInviteResponse.parse({ invite: { ...guest, faces: ['private'] }, image: 'private' }),
  ).toEqual({ invite: guest });
  expect(
    ErrorResponse.parse({ error: { code: 'invite_changed', message: 'Refresh the invite' } }).error
      .code,
  ).toBe('invite_changed');
});
