// The API's upload key builders (root invariant 12, arch §3). S-02 adds the event cover's.
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from '@jest/globals';

import { coverKey } from '../../src/lib/keys';

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
