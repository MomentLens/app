import { describe, expect, it, jest } from '@jest/globals';
import { QueryClient } from '@tanstack/react-query';

import { albumChangeListener, newestInAlbums } from '@/features/blur-regions/use-blur-regions';

jest.mock('@/lib/api', () => ({ ApiError: class ApiError extends Error {} }));
jest.mock('@/features/event-shell/use-event', () => ({
  recheckEvent: () => undefined,
  retryUnlessRefused: () => false,
}));

const eventId = '11111111-1111-4111-8111-111111111111';

describe('albumChangeListener', () => {
  it('ignores a query being added, which happens during a render', () => {
    const client = new QueryClient();
    const onChange = jest.fn();
    const unsubscribe = client.getQueryCache().subscribe(albumChangeListener(eventId, onChange));
    client.getQueryCache().build(client, { queryKey: ['album', eventId, {}] });
    client.getQueryCache().build(client, { queryKey: ['media-images', eventId, 'full'] });
    expect(onChange).not.toHaveBeenCalled();
    unsubscribe();
    client.clear();
  });

  it('answers new data on this event’s album and nothing else', () => {
    const client = new QueryClient();
    const onChange = jest.fn();
    const unsubscribe = client.getQueryCache().subscribe(albumChangeListener(eventId, onChange));
    client.setQueryData(['album', 'another-event', {}], { media: [] });
    client.setQueryData(['blur-regions', 'm'], { regions: [] });
    expect(onChange).not.toHaveBeenCalled();
    client.setQueryData(['album', eventId, {}], { media: [] });
    expect(onChange).toHaveBeenCalled();
    unsubscribe();
    client.clear();
  });
});

describe('newestInAlbums', () => {
  const mediaId = '22222222-2222-4222-8222-222222222222';
  const copy = (variantVersion: number) => ({ id: mediaId, variantVersion }) as never;

  it('picks the highest variant_version when a stale filtered album lists the photo first', () => {
    const staleFiltered = { pages: [{ media: [copy(1)] }] } as never;
    const refetched = { pages: [{ media: [copy(2)] }] } as never;
    expect(newestInAlbums([staleFiltered, refetched], mediaId)?.variantVersion).toBe(2);
  });

  it('reads a single page, skips albums without the photo, and answers undefined when none has it', () => {
    const page = { media: [copy(3)] } as never;
    const other = { pages: [{ media: [] }] } as never;
    expect(newestInAlbums([undefined, other, page], mediaId)?.variantVersion).toBe(3);
    expect(newestInAlbums([other], mediaId)).toBeUndefined();
  });
});
