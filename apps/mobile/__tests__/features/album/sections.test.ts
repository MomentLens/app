import { describe, expect, it } from '@jest/globals';
import type { AlbumMediaItem, SubEvent } from '@momentlens/shared-types';

import { buildAlbumListItems } from '@/features/album/sections';

const subEvents: SubEvent[] = [
  {
    id: 'sub-1',
    name: 'Dholki',
    startsAt: '2026-10-01T14:00:00Z',
    endsAt: '2026-10-01T18:00:00Z',
    description: null,
    verificationRadiusM: 200,
    venue: { id: 'v1', name: 'Residence DHA', lat: 31.5, lng: 74.3 },
  },
  {
    id: 'sub-2',
    name: 'Mayun',
    startsAt: '2026-10-02T14:00:00Z',
    endsAt: '2026-10-02T18:00:00Z',
    description: null,
    verificationRadiusM: 200,
    venue: { id: 'v1', name: 'Residence DHA', lat: 31.5, lng: 74.3 },
  },
  {
    id: 'sub-3',
    name: 'Mehndi',
    startsAt: '2026-10-03T14:00:00Z',
    endsAt: '2026-10-03T18:00:00Z',
    description: null,
    verificationRadiusM: 200,
    venue: { id: 'v2', name: 'Royal Palm', lat: 31.5, lng: 74.3 },
  },
];

const makePhoto = (id: string, subEventId: string, capturedAt: string): AlbumMediaItem => ({
  id,
  subEventId,
  capturedAt,
  uploaderRole: 'guest',
  width: 1200,
  height: 800,
});

describe('Album sections (D-137, D-147, D-148)', () => {
  it('groups photos into sub-event sections ordered by schedule start (D-137)', () => {
    const photos = [
      makePhoto('p2', 'sub-2', '2026-10-02T16:00:00Z'),
      makePhoto('p1', 'sub-1', '2026-10-01T15:00:00Z'),
    ];

    const { items, stickyIndices } = buildAlbumListItems(
      photos,
      subEvents,
      { 'sub-1': 1, 'sub-2': 1 },
      null,
    );

    // Header 1 for sub-1, photo p1, Header 2 for sub-2, photo p2
    expect(items.length).toBe(4);
    expect(items[0]).toMatchObject({ type: 'header', subEventId: 'sub-1', numeral: 1 });
    expect(items[1]).toMatchObject({ type: 'media', key: 'p1' });
    expect(items[2]).toMatchObject({ type: 'header', subEventId: 'sub-2', numeral: 2 });
    expect(items[3]).toMatchObject({ type: 'media', key: 'p2' });
    expect(stickyIndices).toEqual([0, 2]);
  });

  it('omits a sub-event with no photos under All (D-148)', () => {
    const photos = [makePhoto('p1', 'sub-1', '2026-10-01T15:00:00Z')];

    const { items } = buildAlbumListItems(
      photos,
      subEvents,
      { 'sub-1': 1, 'sub-2': 0, 'sub-3': 0 },
      null,
    );

    // Only sub-1 section should be present
    const headers = items.filter((i) => i.type === 'header');
    expect(headers.length).toBe(1);
    expect(headers[0]).toMatchObject({ subEventId: 'sub-1' });
  });

  it('keeps photos in order inside each section (newest capture first, D-147)', () => {
    const photos = [
      makePhoto('p-new', 'sub-1', '2026-10-01T17:00:00Z'),
      makePhoto('p-old', 'sub-1', '2026-10-01T15:00:00Z'),
    ];

    const { items } = buildAlbumListItems(photos, subEvents, { 'sub-1': 2 }, null);

    expect(items[1]).toMatchObject({ key: 'p-new' });
    expect(items[2]).toMatchObject({ key: 'p-old' });
  });

  it('marks the live sub-event header with isLive: true', () => {
    const photos = [makePhoto('p1', 'sub-2', '2026-10-02T15:00:00Z')];

    const { items } = buildAlbumListItems(photos, subEvents, { 'sub-2': 1 }, 'sub-2');

    expect(items[0]).toMatchObject({ type: 'header', subEventId: 'sub-2', isLive: true });
  });

  it('filters to a single sub-event when activeSubEventId is set', () => {
    const photos = [
      makePhoto('p1', 'sub-1', '2026-10-01T15:00:00Z'),
      makePhoto('p2', 'sub-2', '2026-10-02T16:00:00Z'),
    ];

    const { items } = buildAlbumListItems(
      photos,
      subEvents,
      { 'sub-1': 1, 'sub-2': 1 },
      null,
      'sub-2',
    );

    const headers = items.filter((i) => i.type === 'header');
    expect(headers.length).toBe(1);
    expect(headers[0]).toMatchObject({ subEventId: 'sub-2', numeral: 2 });
    expect(items.filter((i) => i.type === 'media').map((i) => i.key)).toEqual(['p2']);
  });
});
