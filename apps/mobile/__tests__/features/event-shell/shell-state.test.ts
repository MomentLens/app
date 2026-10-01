import { describe, expect, it } from '@jest/globals';

import { lostBody, shellBody } from '@/features/event-shell/shell-state';

const SETTLED = { lost: null, hasData: true, isError: false, isFetching: false } as const;

describe('shellBody', () => {
  it('shows the tabs for an event the query has', () => {
    expect(shellBody(SETTLED)).toBe('tabs');
  });

  it('keeps showing the copy it has when a refetch fails offline (spec §4.14)', () => {
    expect(shellBody({ ...SETTLED, isError: true })).toBe('tabs');
  });

  it('shows the refusal once the API has refused the caller', () => {
    expect(shellBody({ ...SETTLED, lost: 'not_member', isError: true })).toBe('lost');
    expect(shellBody({ ...SETTLED, lost: 'not_found', isError: true })).toBe('lost');
  });

  it('waits for the new answer rather than show an old refusal while it refetches', () => {
    // A member refused once and since rejoined: TanStack Query keeps the 403 while the query
    // refetches over data it already has.
    expect(shellBody({ ...SETTLED, lost: 'not_member', isError: true, isFetching: true })).toBe(
      'loading',
    );
  });

  it('never shows the tabs to a caller the last answer refused, even with data cached', () => {
    for (const isFetching of [true, false]) {
      expect(shellBody({ ...SETTLED, lost: 'not_member', isError: true, isFetching })).not.toBe(
        'tabs',
      );
    }
  });

  it('offers to try again when nothing loaded and the fetch failed', () => {
    expect(shellBody({ ...SETTLED, hasData: false, isError: true })).toBe('failed');
  });

  it('loads while there is nothing to show yet', () => {
    expect(shellBody({ ...SETTLED, hasData: false, isFetching: true })).toBe('loading');
  });
});

const FRESH = { fetchedAfterMount: true, isSuccess: true, isError: false, hasRequest: false };

describe('lostBody', () => {
  it('treats a deleted or unknown event as final, whatever the list holds', () => {
    expect(lostBody('not_found', { ...FRESH, hasRequest: true })).toBe('no-access');
    expect(lostBody('not_found', { ...FRESH, fetchedAfterMount: false })).toBe('no-access');
  });

  it('waits for a list fetched since the refusal before deciding', () => {
    // The copy restored at launch can hold a join request that has since been rejected.
    expect(lostBody('not_member', { ...FRESH, fetchedAfterMount: false, hasRequest: true })).toBe(
      'loading',
    );
  });

  it('sends a caller whose fresh list holds their join request to Pending Approval', () => {
    expect(lostBody('not_member', { ...FRESH, hasRequest: true })).toBe('pending');
  });

  it('tells a caller with no join request in the fresh list that access is gone', () => {
    expect(lostBody('not_member', FRESH)).toBe('no-access');
  });

  it('offers to try again, rather than trust the copy it had, when the fresh fetch failed', () => {
    const failed = { ...FRESH, isSuccess: false, isError: true };
    expect(lostBody('not_member', { ...failed, hasRequest: true })).toBe('failed');
    expect(lostBody('not_member', failed)).toBe('failed');
  });

  it('waits while a retry runs with no list to read', () => {
    expect(lostBody('not_member', { ...FRESH, isSuccess: false })).toBe('loading');
  });
});
