// The API's upload key builders (root invariant 12, arch §3). S-02 adds the event cover's, S-12 the
// photo's and its client thumbnail's, S-20 the profile photo's and the reference photo's.
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from '@jest/globals';

import { avatarKey, coverKey, referenceKey, uploadKeys } from '../../src/lib/keys';

const EVENT = randomUUID();
const UPLOAD = randomUUID();

describe('coverKey', () => {
  it('builds events/{event_id}/cover_{upload_id}.jpg', () => {
    expect(coverKey(EVENT, UPLOAD)).toBe(`events/${EVENT}/cover_${UPLOAD}.jpg`);
  });

  it('lowercases both ids, so an uppercase path id names the same object as the row', () => {
    expect(coverKey(EVENT.toUpperCase(), UPLOAD.toUpperCase())).toBe(
      `events/${EVENT}/cover_${UPLOAD}.jpg`,
    );
  });

  it('gives a replacement cover a new key, so no cache keeps the old image', () => {
    expect(coverKey(EVENT, randomUUID())).not.toBe(coverKey(EVENT, UPLOAD));
  });

  it.each([
    ['an empty string', ''],
    ['a path', `../${EVENT}`],
    ['a slash', `${EVENT}/x`],
    ['a uuid with a suffix', `${EVENT}.jpg`],
    ['a uuid without dashes', EVENT.replaceAll('-', '')],
  ])('refuses %s for either id, so no key leaves its family', (_case, bad) => {
    expect(() => coverKey(bad, UPLOAD)).toThrow();
    expect(() => coverKey(EVENT, bad)).toThrow();
  });
});

describe('uploadKeys', () => {
  const MEDIA = randomUUID();

  it('builds {media_id}/upload.jpg and {media_id}/upload_thumb.webp', () => {
    expect(uploadKeys(MEDIA)).toEqual({
      photo: `${MEDIA}/upload.jpg`,
      thumbnail: `${MEDIA}/upload_thumb.webp`,
    });
  });

  it('lowercases the id, so the keys match the row CHECK that compares them with id::text', () => {
    expect(uploadKeys(MEDIA.toUpperCase())).toEqual(uploadKeys(MEDIA));
  });

  it.each([
    ['an empty string', ''],
    ['a path', `../${MEDIA}`],
    ['a slash', `${MEDIA}/x`],
    ['an event cover prefix', `events/${MEDIA}`],
  ])('refuses %s, so no key leaves its family', (_case, bad) => {
    expect(() => uploadKeys(bad)).toThrow();
  });
});

describe('avatarKey', () => {
  const USER = randomUUID();

  it('builds users/{user_id}/avatar_{upload_id}.jpg, which profile_avatar_key_check accepts', () => {
    expect(avatarKey(USER, UPLOAD)).toBe(`users/${USER}/avatar_${UPLOAD}.jpg`);
  });

  it('lowercases both ids, so the key matches the CHECK that compares it with user_id::text', () => {
    expect(avatarKey(USER.toUpperCase(), UPLOAD.toUpperCase())).toBe(avatarKey(USER, UPLOAD));
  });

  it.each([
    ['an empty string', ''],
    ['a path', `../${USER}`],
    ['a slash', `${USER}/x`],
  ])('refuses %s for either id, so no key leaves its family', (_case, bad) => {
    expect(() => avatarKey(bad, UPLOAD)).toThrow();
    expect(() => avatarKey(USER, bad)).toThrow();
  });
});

describe('referenceKey', () => {
  const USER = randomUUID();

  it('builds users/{user_id}/events/{event_id}/reference_{upload_id}.jpg (D-141)', () => {
    expect(referenceKey(USER, EVENT, UPLOAD)).toBe(
      `users/${USER}/events/${EVENT}/reference_${UPLOAD}.jpg`,
    );
  });

  it('lowercases every id, so the key matches face_reference_photo_key_check', () => {
    expect(referenceKey(USER.toUpperCase(), EVENT.toUpperCase(), UPLOAD.toUpperCase())).toBe(
      referenceKey(USER, EVENT, UPLOAD),
    );
  });

  it.each([
    ['an empty string', ''],
    ['a path', `../${USER}`],
    ['a slash', `${USER}/x`],
  ])('refuses %s for any id, so no key leaves its family', (_case, bad) => {
    expect(() => referenceKey(bad, EVENT, UPLOAD)).toThrow();
    expect(() => referenceKey(USER, bad, UPLOAD)).toThrow();
    expect(() => referenceKey(USER, EVENT, bad)).toThrow();
  });
});
