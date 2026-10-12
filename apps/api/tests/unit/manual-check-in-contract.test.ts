import { randomUUID } from 'node:crypto';

import { describe, expect, it, jest } from '@jest/globals';

import {
  ForceVerifyAttendeeRequest,
  ForceVerifyAttendeeResponse,
  ListAttendeesRequest,
  ListAttendeesResponse,
} from '@momentlens/shared-types';

import type { Supabase } from '../../src/db/supabase';
import { accessVersion, createAttendeeStore } from '../../src/services/attendees';

const eventId = randomUUID();
const actorId = randomUUID();
const userId = randomUUID();
const id = randomUUID();
const subEventId = randomUUID();
const counter = '9007199254740993';
const member = { id, user_id: userId, role: 'guest', status: 'active', access_version: counter };
const rpc = () =>
  jest.fn<(name: string, params: object) => Promise<{ data: unknown; error: unknown }>>();
const store = (call: ReturnType<typeof rpc>) =>
  createAttendeeStore({ rpc: call } as unknown as Supabase);

describe('S-17 manual check-in contract', () => {
  it('accepts only an expected access version and rejects client grant fields', () => {
    const body = { expectedVersion: accessVersion(id, counter) };
    expect(ForceVerifyAttendeeRequest.parse(body)).toEqual(body);
    for (const extra of [
      { role: 'admin' },
      { verified: true },
      { userId },
      { actorId },
      { eventId },
      { adminVerifiedAt: '2026-10-12T10:00:00.000Z' },
    ]) {
      expect(ForceVerifyAttendeeRequest.safeParse({ ...body, ...extra }).success).toBe(false);
    }
  });

  it('requires a selected sub-event for either check-in filter', () => {
    for (const checkIn of ['checked_in', 'not_checked_in']) {
      expect(ListAttendeesRequest.safeParse({ checkIn }).success).toBe(false);
      expect(ListAttendeesRequest.parse({ subEventId, checkIn })).toEqual({ subEventId, checkIn });
    }
  });

  it('requires server coverage in attendee responses', () => {
    const attendee = {
      userId,
      fullName: 'Guest',
      role: 'guest',
      requestedAt: '2026-10-12T10:00:00.000Z',
      accessVersion: accessVersion(id, counter),
      avatar: null,
    };
    expect(
      ListAttendeesResponse.safeParse({ attendees: [attendee], nextCursor: null }).success,
    ).toBe(false);
    expect(
      ListAttendeesResponse.parse({
        attendees: [
          { ...attendee, verification: { everySubEvent: false, subEventIds: [subEventId] } },
        ],
        nextCursor: null,
      }).attendees[0]!.verification.subEventIds,
    ).toEqual([subEventId]);
  });

  it('uses one manual RPC with server actor identity and an exact bigint counter', async () => {
    const call = rpc().mockResolvedValue({
      data: {
        outcome: 'verified',
        membership: member,
        admin_verified_at: '2026-10-12T10:00:00+00:00',
      },
      error: null,
    });
    const result = await store(call).forceVerify(eventId, actorId, userId, {
      id,
      version: counter,
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('force_verify_attendee', {
      p_event_id: eventId,
      p_actor_id: actorId,
      p_user_id: userId,
      p_expected_id: id,
      p_expected_version: counter,
    });
    expect(result).toEqual({
      outcome: 'verified',
      membership: {
        userId,
        role: 'guest',
        status: 'active',
        accessVersion: accessVersion(id, counter),
      },
      adminVerifiedAt: '2026-10-12T10:00:00.000Z',
    });
    if (result.outcome !== 'verified') throw new Error('Manual grant refused');
    expect(ForceVerifyAttendeeResponse.parse(result).membership.accessVersion).toBe(
      accessVersion(id, counter),
    );
  });

  it.each(['not_found', 'not_member', 'wrong_role', 'invalid_request', 'membership_changed'])(
    'maps manual refusal %s without a second RPC',
    async (outcome) => {
      const call = rpc().mockResolvedValue({ data: { outcome }, error: null });
      await expect(
        store(call).forceVerify(eventId, actorId, userId, { id, version: '1' }),
      ).resolves.toEqual({ outcome });
      expect(call).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { ...member, role: 'admin' },
    { ...member, status: 'removed' },
    { ...member, access_version: '0' },
  ])('rejects an invalid successful manual membership %j', async (membership) => {
    const call = rpc().mockResolvedValue({
      data: { outcome: 'verified', membership, admin_verified_at: '2026-10-12T10:00:00+00:00' },
      error: null,
    });
    await expect(
      store(call).forceVerify(eventId, actorId, userId, { id, version: '1' }),
    ).rejects.toThrow();
  });

  it('maps list coverage from a single RPC without profile or evidence lookups', async () => {
    const call = rpc().mockResolvedValue({
      data: {
        outcome: 'listed',
        attendees: [
          {
            ...member,
            full_name: 'Guest',
            requested_at: '2026-10-12T10:00:00+00:00',
            every_sub_event: false,
            verified_sub_event_ids: [subEventId],
            avatar_key: 'private',
            qr_secret: 'private',
          },
        ],
      },
      error: null,
    });
    const result = await store(call).list(eventId, actorId, {
      search: '',
      role: null,
      subEventId,
      checkIn: 'not_checked_in',
      after: null,
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('list_attendees', {
      p_event_id: eventId,
      p_actor_id: actorId,
      p_search: '',
      p_role: null,
      p_after_name: null,
      p_after_user_id: null,
      p_sub_event_id: subEventId,
      p_check_in: 'not_checked_in',
    });
    expect(result).toEqual({
      outcome: 'listed',
      rows: [
        {
          id,
          userId,
          fullName: 'Guest',
          role: 'guest',
          requestedAt: '2026-10-12T10:00:00.000Z',
          version: counter,
          verification: { everySubEvent: false, subEventIds: [subEventId] },
        },
      ],
    });
  });
});
