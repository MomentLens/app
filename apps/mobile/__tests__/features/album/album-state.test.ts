import { describe, expect, it } from '@jest/globals';
import type { SubEvent } from '@momentlens/shared-types';

import {
  addMediaMode,
  albumProblem,
  closeAlbumConfirm,
  eventMoment,
} from '@/features/album/album-state';

describe('the Close Album confirm (spec §4.9, D-161)', () => {
  it('names the one Photographer who has uploaded nothing', () => {
    expect(closeAlbumConfirm(['Ali Raza']).message).toBe(
      "Ali Raza hasn't uploaded any photos. Closing the album will block them from uploading. Close anyway?",
    );
  });

  it('names every Photographer, with no cap', () => {
    expect(closeAlbumConfirm(['Ali Raza', 'Sara Khan', 'Bilal Ahmed']).message).toBe(
      "Ali Raza, Sara Khan and Bilal Ahmed haven't uploaded any photos. Closing the album will block them from uploading. Close anyway?",
    );
  });

  it('is a plain confirm when every Photographer has uploaded', () => {
    expect(closeAlbumConfirm([])).toEqual({
      title: 'Close the album?',
      message:
        'New photos will wait on each phone until you open it again. Photos already uploading still finish.',
    });
  });
});

describe('+ Add Media while the album is closed (D-161)', () => {
  it('adds as before while the album is open, or before the event has loaded', () => {
    expect(addMediaMode('guest', true)).toBe('add');
    expect(addMediaMode('photographer', true)).toBe('add');
    expect(addMediaMode('admin', true)).toBe('add');
    expect(addMediaMode(undefined, undefined)).toBe('add');
  });

  it("disables a Guest's and a Photographer's button and asks the Admin to open it", () => {
    expect(addMediaMode('guest', false)).toBe('disabled');
    expect(addMediaMode('photographer', false)).toBe('disabled');
    expect(addMediaMode('admin', false)).toBe('ask-to-open');
  });
});

describe('the status card line (spec §2.5.7, D-161)', () => {
  const sub = (id: string, startsAt: string, endsAt: string) =>
    ({ id, name: id, startsAt, endsAt }) as SubEvent;
  const schedule = [
    sub('mehndi', '2026-10-20T14:00:00.000Z', '2026-10-20T18:00:00.000Z'),
    sub('baraat', '2026-10-21T14:00:00.000Z', '2026-10-21T18:00:00.000Z'),
  ];

  it('shows the sub-event In Progress', () => {
    expect(eventMoment(schedule, new Date('2026-10-20T15:00:00.000Z'))).toEqual({
      kind: 'live',
      subEvent: schedule[0],
    });
  });

  it('shows the next one as Upcoming before the first and between two', () => {
    expect(eventMoment(schedule, new Date('2026-10-19T15:00:00.000Z'))).toEqual({
      kind: 'next',
      subEvent: schedule[0],
    });
    expect(eventMoment(schedule, new Date('2026-10-20T20:00:00.000Z'))).toEqual({
      kind: 'next',
      subEvent: schedule[1],
    });
  });

  it('says the event has ended after the last', () => {
    expect(eventMoment(schedule, new Date('2026-10-22T00:00:00.000Z'))).toEqual({ kind: 'ended' });
  });

  it('has nothing to say before the schedule loads', () => {
    expect(eventMoment([], new Date())).toEqual({ kind: 'unknown' });
  });
});

describe('what a failed switch says', () => {
  it('says a timed-out write may have landed', () => {
    expect(albumProblem({ timedOut: true }, 'close')).toBe(
      'MomentLens did not answer in time, so the album may or may not have closed. It shows the current state once it refreshes.',
    );
  });

  it('says nothing changed when MomentLens could not be reached', () => {
    expect(albumProblem({}, 'open')).toBe(
      'MomentLens could not be reached, so the album is still closed. Check the connection and try again.',
    );
    expect(albumProblem({}, 'check')).toBe(
      'MomentLens could not be reached, so the album is still open. Check the connection and try again.',
    );
  });

  it('reads a refusal', () => {
    expect(albumProblem({ status: 403, code: 'wrong_role' }, 'open')).toBe(
      'You can no longer change this event.',
    );
    expect(albumProblem({ status: 404, code: 'not_found' }, 'close')).toBe(
      'This event is no longer available.',
    );
    expect(albumProblem({ status: 500 }, 'open')).toBe(
      'Something went wrong on our side. Try again in a moment.',
    );
  });
});
