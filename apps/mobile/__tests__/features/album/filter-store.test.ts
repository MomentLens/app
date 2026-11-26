import { beforeEach, describe, expect, it } from '@jest/globals';

import {
  filterKey,
  peopleParams,
  setPeopleFilter,
  useFilterStore,
} from '@/features/album/filter-store';
import { useAuthStore } from '@/stores/auth';

const EVENT = '00000000-0000-4000-8000-0000000000e1';
const OTHER_EVENT = '00000000-0000-4000-8000-0000000000e2';
const ME = '00000000-0000-4000-8000-0000000000a1';
const NEXT_ACCOUNT = '00000000-0000-4000-8000-0000000000a2';
const SARAH = '00000000-0000-4000-8000-0000000000b1';
const CLUSTER = '00000000-0000-4000-8000-0000000000c1';

beforeEach(() => {
  useFilterStore.setState({ byKey: {} });
  useAuthStore.setState({ status: 'signedIn', userId: ME });
});

describe('peopleParams', () => {
  it('sends Find My Photos as the signed-in account, never a stored id', () => {
    expect(peopleParams({ kind: 'me' }, ME)).toEqual({ personId: ME });
    expect(peopleParams({ kind: 'me' }, NEXT_ACCOUNT)).toEqual({ personId: NEXT_ACCOUNT });
  });

  it('sends nothing for Find My Photos with no account', () => {
    expect(peopleParams({ kind: 'me' }, null)).toEqual({});
  });

  it('sends a named person as personId and an Unknown cluster as clusterId, never both', () => {
    expect(peopleParams({ kind: 'person', userId: SARAH, name: 'Sarah' }, ME)).toEqual({
      personId: SARAH,
    });
    expect(peopleParams({ kind: 'unknown', clusterId: CLUSTER }, ME)).toEqual({
      clusterId: CLUSTER,
    });
  });

  it('sends nothing with no People filter', () => {
    expect(peopleParams(undefined, ME)).toEqual({});
  });
});

describe('useFilterStore', () => {
  it('keeps a People filter and an Uploader filter side by side', () => {
    const key = filterKey(ME, EVENT);
    const { setPeople, setUploader } = useFilterStore.getState();
    setPeople(key, { kind: 'person', userId: SARAH, name: 'Sarah' });
    setUploader(key, { id: SARAH, name: 'Sarah' });
    expect(useFilterStore.getState().byKey[key]).toEqual({
      people: { kind: 'person', userId: SARAH, name: 'Sarah' },
      uploader: { id: SARAH, name: 'Sarah' },
    });
  });

  it('replaces a person with a cluster, so the two are never sent together', () => {
    const key = filterKey(ME, EVENT);
    const { setPeople } = useFilterStore.getState();
    setPeople(key, { kind: 'person', userId: SARAH, name: 'Sarah' });
    setPeople(key, { kind: 'unknown', clusterId: CLUSTER });
    expect(useFilterStore.getState().byKey[key]?.people).toEqual({
      kind: 'unknown',
      clusterId: CLUSTER,
    });
  });

  it('clears the People filter without touching the Uploader filter', () => {
    const key = filterKey(ME, EVENT);
    const { setPeople, setUploader } = useFilterStore.getState();
    setPeople(key, { kind: 'me' });
    setUploader(key, { id: SARAH, name: 'Sarah' });
    setPeople(key, undefined);
    expect(useFilterStore.getState().byKey[key]).toEqual({
      people: undefined,
      uploader: { id: SARAH, name: 'Sarah' },
    });
  });
});

describe('setPeopleFilter', () => {
  it("sets the signed-in account's filter in that event only", () => {
    setPeopleFilter(EVENT, { kind: 'unknown', clusterId: CLUSTER });
    const { byKey } = useFilterStore.getState();
    expect(byKey[filterKey(ME, EVENT)]?.people).toEqual({ kind: 'unknown', clusterId: CLUSTER });
    expect(byKey[filterKey(ME, OTHER_EVENT)]).toBeUndefined();
  });

  it('leaves the next account on a shared phone with no filter', () => {
    setPeopleFilter(EVENT, { kind: 'person', userId: SARAH, name: 'Sarah' });
    useAuthStore.setState({ status: 'signedIn', userId: NEXT_ACCOUNT });
    expect(useFilterStore.getState().byKey[filterKey(NEXT_ACCOUNT, EVENT)]).toBeUndefined();
  });
});
