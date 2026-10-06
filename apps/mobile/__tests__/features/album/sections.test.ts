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
  variantVersion: 1,
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

  it('draws a section only once one of its photos has loaded, whatever its count says', () => {
    // Page one holds part of sub-1. sub-2 and sub-3 have photos on later pages.
    const photos = [makePhoto('p1', 'sub-1', '2026-10-01T15:00:00Z')];

    const { items, stickyIndices } = buildAlbumListItems(
      photos,
      subEvents,
      { 'sub-1': 60, 'sub-2': 30, 'sub-3': 5 },
      null,
    );

    expect(items.map((item) => item.key)).toEqual(['header-sub-1', 'p1']);
    expect(items[0]).toMatchObject({ count: 60 });
    expect(stickyIndices).toEqual([0]);
  });

  it('leaves the list empty for a chip whose sub-event has no photos, so its empty state shows', () => {
    const { items } = buildAlbumListItems([], subEvents, {}, 'sub-2');
    expect(items).toEqual([]);
  });

  it('keeps the schedule numeral when only one sub-event is loaded, as under its chip', () => {
    const photos = [makePhoto('p2', 'sub-2', '2026-10-02T16:00:00Z')];

    const { items } = buildAlbumListItems(photos, subEvents, { 'sub-2': 1 }, null);

    expect(items[0]).toMatchObject({ type: 'header', subEventId: 'sub-2', numeral: 2 });
  });

  it('drops a photo the serving endpoint left out, and a section left with none', () => {
    const photos = [
      makePhoto('p1', 'sub-1', '2026-10-01T15:00:00Z'),
      makePhoto('p2', 'sub-2', '2026-10-02T16:00:00Z'),
      makePhoto('p3', 'sub-2', '2026-10-02T15:00:00Z'),
    ];

    const { items, stickyIndices } = buildAlbumListItems(
      photos,
      subEvents,
      { 'sub-1': 1, 'sub-2': 2 },
      null,
      new Set(['p1', 'p3']),
    );

    expect(items.map((item) => item.key)).toEqual(['header-sub-2', 'p2']);
    expect(stickyIndices).toEqual([0]);
  });

  it("orders sections that start together by id, as the album's pages arrive", () => {
    // The schedule breaks the tie by end, which puts sub-b first. The pages put sub-a first.
    const tied: SubEvent[] = [
      { ...subEvents[0]!, id: 'sub-b', endsAt: '2026-10-01T16:00:00Z' },
      { ...subEvents[0]!, id: 'sub-a', endsAt: '2026-10-01T18:00:00Z' },
    ];
    const photos = [
      makePhoto('pa', 'sub-a', '2026-10-01T15:00:00Z'),
      makePhoto('pb', 'sub-b', '2026-10-01T15:00:00Z'),
    ];

    const { items } = buildAlbumListItems(photos, tied, { 'sub-a': 1, 'sub-b': 1 }, null);

    expect(items.map((item) => item.key)).toEqual(['header-sub-a', 'pa', 'header-sub-b', 'pb']);
    expect(items[0]).toMatchObject({ numeral: 2 });
  });

  it('flags a photo whose sub-event the loaded schedule does not hold', () => {
    const photos = [
      makePhoto('p1', 'sub-1', '2026-10-01T15:00:00Z'),
      makePhoto('p9', 'sub-new', '2026-10-04T15:00:00Z'),
    ];

    const result = buildAlbumListItems(photos, subEvents, { 'sub-1': 1, 'sub-new': 1 }, null);

    expect(result.unknownSubEvent).toBe(true);
    expect(result.items.map((item) => item.key)).toEqual(['header-sub-1', 'p1']);
    expect(buildAlbumListItems(photos.slice(0, 1), subEvents, {}, null).unknownSubEvent).toBe(
      false,
    );
  });
});
