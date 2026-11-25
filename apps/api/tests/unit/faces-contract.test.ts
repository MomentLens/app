import { describe, expect, it } from '@jest/globals';

import {
  ListAlbumRequest,
  ListPeopleResponse,
  ListPhotoFacesResponse,
  PhotoFace,
} from '@momentlens/shared-types';

const userId = 'c0000000-0000-4000-8000-000000000001';
const clusterId = 'd0000000-0000-4000-8000-000000000001';
const subEventId = 'a0000000-0000-4000-8000-000000000001';

describe('S-23 contract', () => {
  it('takes a person or a cluster on the album, never both', () => {
    expect(ListAlbumRequest.safeParse({ personId: userId }).success).toBe(true);
    expect(ListAlbumRequest.safeParse({ clusterId }).success).toBe(true);
    expect(ListAlbumRequest.safeParse({ personId: userId, clusterId }).success).toBe(false);
  });

  it('stacks a person or a cluster with the sub-event and uploader filters', () => {
    expect(
      ListAlbumRequest.safeParse({ personId: userId, subEventId, uploaderId: userId }).success,
    ).toBe(true);
    expect(ListAlbumRequest.safeParse({ clusterId, subEventId, uploaderId: userId }).success).toBe(
      true,
    );
  });

  it('still refuses an unknown query parameter', () => {
    expect(ListAlbumRequest.safeParse({ viewerId: userId }).success).toBe(false);
  });

  it('carries no box and no crop in a strip entry', () => {
    const person = { kind: 'person', userId, fullName: 'Ayesha Khan' };
    expect(PhotoFace.parse({ ...person, x: 0.1 })).toEqual(person);
    expect(PhotoFace.safeParse({ kind: 'unknown', userId }).success).toBe(false);
    expect(
      ListPhotoFacesResponse.parse({ faces: [person, { kind: 'unknown', clusterId }] }).faces,
    ).toHaveLength(2);
  });

  it('lists a person with a null avatar until S-29', () => {
    const people = { people: [{ userId, fullName: 'Ayesha Khan', photoCount: 3, avatar: null }] };
    expect(ListPeopleResponse.parse(people)).toEqual(people);
    expect(
      ListPeopleResponse.safeParse({ people: [{ ...people.people[0], photoCount: 0 }] }).success,
    ).toBe(false);
  });
});
