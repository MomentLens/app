import { describe, expect, it } from '@jest/globals';
import type { Reference } from '@momentlens/shared-types';

import {
  REJECT_MESSAGE,
  isChecking,
  referenceProblem,
  statusLabel,
  summarize,
} from '@/features/references/reference-state';
import { PhotoUploadError } from '@/lib/photo-upload-error';

const IMAGE = {
  url: 'https://r2.example.test/get?sig=1',
  cacheKey: 'users/u/events/e/reference_1.jpg',
};
let next = 0;
function reference(
  status: Reference['status'],
  rejectReason: Reference['rejectReason'] = null,
): Reference {
  next++;
  return {
    id: `00000000-0000-4000-8000-${String(next).padStart(12, '0')}`,
    status,
    rejectReason,
    image: IMAGE,
    createdAt: '2026-11-22T10:00:00.000Z',
  };
}

describe('summarize', () => {
  it('counts every reference that is not rejected toward the limit of 5', () => {
    const summary = summarize([
      reference('accepted'),
      reference('accepted'),
      reference('pending'),
      reference('rejected', 'multiple_faces'),
    ]);
    expect(summary).toEqual({
      ready: 2,
      checking: 1,
      notUsed: [{ reason: 'multiple_faces', count: 1 }],
      counted: 3,
      canAdd: true,
    });
  });

  it('refuses a 6th, but a rejected photo leaves room for its replacement', () => {
    const five = [1, 2, 3, 4, 5].map(() => reference('accepted'));
    expect(summarize(five).canAdd).toBe(false);
    const fourAndRejected = [...five.slice(0, 4), reference('rejected', 'no_face')];
    expect(summarize(fourAndRejected).canAdd).toBe(true);
  });

  it('groups rejected photos by reason', () => {
    const summary = summarize([
      reference('rejected', 'no_face'),
      reference('rejected', 'failed'),
      reference('rejected', 'no_face'),
    ]);
    expect(summary.notUsed).toEqual([
      { reason: 'no_face', count: 2 },
      { reason: 'failed', count: 1 },
    ]);
    expect(summary.counted).toBe(0);
  });
});

describe('isChecking', () => {
  it('polls only while the worker has not decided a photo (D-91)', () => {
    expect(isChecking(undefined)).toBe(false);
    expect(isChecking([])).toBe(false);
    expect(isChecking([reference('accepted'), reference('rejected', 'no_face')])).toBe(false);
    expect(isChecking([reference('accepted'), reference('pending')])).toBe(true);
  });

  it('stops once a final failure arrives as failed (D-172)', () => {
    expect(isChecking([reference('rejected', 'failed')])).toBe(false);
  });
});

describe('statusLabel', () => {
  it('names each status as the frames do', () => {
    expect(statusLabel(reference('accepted'))).toBe('Ready');
    expect(statusLabel(reference('pending'))).toBe('Checking');
    expect(statusLabel(reference('rejected', 'no_face'))).toMatch(/^Not [Uu]sed$/);
  });
});

describe('REJECT_MESSAGE', () => {
  it('uses spec §4.2 wording for several faces', () => {
    expect(REJECT_MESSAGE.multiple_faces).toBe(
      'Multiple faces detected. Please upload a solo photo where only your face is visible.',
    );
  });
});

describe('referenceProblem', () => {
  it('names the limit on too_many_references', () => {
    expect(referenceProblem({ status: 422, code: 'too_many_references' }, 'add')).toMatch(/5/);
  });

  it('tells a non-member why, for any action', () => {
    expect(referenceProblem({ status: 403, code: 'not_member' }, 'read')).toMatch(/members/);
  });

  it('tells a missing upload apart from a refused one', () => {
    expect(referenceProblem({ status: 409, code: 'upload_missing' }, 'add')).toMatch(
      /did not finish/,
    );
    expect(referenceProblem(new PhotoUploadError('file_missing', 'gone'), 'add')).toMatch(
      /Pick it again/,
    );
    expect(referenceProblem(new PhotoUploadError('refused', 'HTTP 403'), 'add')).toMatch(/expired/);
  });

  it('falls back to the action when nothing more is known', () => {
    expect(referenceProblem(new Error('offline'), 'delete')).toMatch(/could not be deleted/);
  });
});
