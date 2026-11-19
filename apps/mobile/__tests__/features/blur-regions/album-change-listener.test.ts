import { describe, expect, it, jest } from '@jest/globals';
import { QueryClient } from '@tanstack/react-query';

import { albumChangeListener } from '@/features/blur-regions/use-blur-regions';

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
