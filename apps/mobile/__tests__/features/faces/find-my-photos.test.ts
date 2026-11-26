import { describe, expect, it } from '@jest/globals';
import type { Reference } from '@momentlens/shared-types';

import { findMyPhotosAction } from '@/features/faces/find-my-photos';

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
    image: { url: 'https://r2.example.test/get?sig=1', cacheKey: `ref_${next}.jpg` },
    createdAt: '2026-11-22T10:00:00.000Z',
  };
}

describe('findMyPhotosAction', () => {
  it('filters once any reference is accepted, whatever else is pending', () => {
    expect(findMyPhotosAction([reference('pending'), reference('accepted')])).toBe('filter');
  });

  it('says still checking while one is pending and none is accepted', () => {
    expect(findMyPhotosAction([reference('rejected', 'no_face'), reference('pending')])).toBe(
      'checking',
    );
  });

  it('offers to add a photo with no references', () => {
    expect(findMyPhotosAction([])).toBe('add');
  });

  it('offers to add a photo when every reference was rejected', () => {
    expect(
      findMyPhotosAction([
        reference('rejected', 'multiple_faces'),
        reference('rejected', 'failed'),
      ]),
    ).toBe('add');
  });

  it('is unknown before the list loads', () => {
    expect(findMyPhotosAction(undefined)).toBe('unknown');
  });
});
