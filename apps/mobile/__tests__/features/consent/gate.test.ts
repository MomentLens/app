import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PRIVACY_POLICY_VERSION } from '@momentlens/shared-types';
import { QueryClient } from '@tanstack/react-query';

import type * as AcceptModule from '@/features/consent/accept';
import { PROFILE_QUERY_KEY } from '@/hooks/use-my-profile';
import type * as GateModule from '@/features/consent/gate';

// One Map stands in for the MMKV instance that keeps each account's last answer.
const mockStorage = new Map<string, number>();
jest.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getNumber: (key: string) => mockStorage.get(key),
    set: (key: string, value: number) => {
      mockStorage.set(key, value);
    },
    remove: (key: string) => mockStorage.delete(key),
  }),
  useMMKVNumber: () => [undefined, () => undefined],
}));
const mockQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
jest.mock('@/lib/query-client', () => ({ queryClient: mockQueryClient }));
const mockAccept = jest.fn<(owner: string, body: unknown) => Promise<unknown>>();
jest.mock('@/lib/api', () => ({
  acceptConsent: (owner: string, body: unknown) => mockAccept(owner, body),
}));

let mockOwner = 'A';
jest.mock('@/stores/auth', () => ({ useAuthStore: { getState: () => ({ userId: mockOwner }) } }));

let gate: typeof GateModule;
let accept: typeof AcceptModule;
beforeEach(() => {
  mockOwner = 'A';
  mockStorage.clear();
  mockQueryClient.clear();
  mockAccept.mockReset();
  jest.isolateModules(() => {
    gate = jest.requireActual<typeof GateModule>('@/features/consent/gate');
    accept = jest.requireActual<typeof AcceptModule>('@/features/consent/accept');
  });
});

// A cached query holds a garbage-collection timer, which would keep Jest running after the suite.
afterAll(() => {
  mockQueryClient.clear();
});

const profile = (userId: string, consentRequired: boolean) => ({
  userId,
  fullName: 'Ayesha Khan',
  avatar: null,
  consentRequired,
});

describe('the consent gate (spec §4.18, D-161)', () => {
  it('opens on a kept answer for the current version before the server has answered', () => {
    expect(gate.consentGate('A', PRIVACY_POLICY_VERSION, { data: undefined, failed: false })).toBe(
      'accepted',
    );
  });

  it('waits on the server with nothing kept, and shows the screen when it cannot be asked', () => {
    expect(gate.consentGate('A', undefined, { data: undefined, failed: false })).toBe('checking');
    expect(gate.consentGate('A', undefined, { data: undefined, failed: true })).toBe('required');
  });

  it('pauses an account whose kept answer is an older version', () => {
    expect(
      gate.consentGate('A', PRIVACY_POLICY_VERSION - 1, { data: undefined, failed: true }),
    ).toBe('required');
  });

  it("follows the server's answer once it has one, over the kept answer", () => {
    expect(
      gate.consentGate('A', PRIVACY_POLICY_VERSION, {
        data: profile('A', true),
        failed: false,
      }),
    ).toBe('required');
    expect(gate.consentGate('A', undefined, { data: profile('A', false), failed: false })).toBe(
      'accepted',
    );
  });

  it("never reads another account's profile as this account's answer", () => {
    expect(gate.consentGate('B', undefined, { data: profile('A', false), failed: false })).toBe(
      'checking',
    );
  });
});

describe('kept answers belong to one account', () => {
  it("never gives account B account A's acceptance", () => {
    gate.keepConsent('A');
    expect(gate.readKeptConsent('A')).toBe(PRIVACY_POLICY_VERSION);
    expect(gate.readKeptConsent('B')).toBeUndefined();
    expect(
      gate.consentGate('B', gate.readKeptConsent('B'), { data: undefined, failed: true }),
    ).toBe('required');
  });

  it("keeps the server's yes and drops a kept answer the server no longer has", () => {
    gate.reconcileConsent('A', profile('A', false));
    expect(gate.readKeptConsent('A')).toBe(PRIVACY_POLICY_VERSION);
    gate.reconcileConsent('A', profile('A', true));
    expect(gate.readKeptConsent('A')).toBeUndefined();
  });

  it('ignores a profile answer for another account', () => {
    gate.reconcileConsent('B', profile('A', false));
    expect(gate.readKeptConsent('B')).toBeUndefined();
    expect(gate.readKeptConsent('A')).toBeUndefined();
  });

  it('reads the gate outside React from the kept answer and the cached profile', () => {
    expect(gate.currentConsentGate('A')).toBe('checking');
    mockQueryClient.setQueryData(PROFILE_QUERY_KEY, profile('A', false));
    expect(gate.currentConsentGate('A')).toBe('accepted');
    expect(gate.currentConsentGate('B')).toBe('checking');
  });
});

describe('accepting', () => {
  it('records the current version for the account the screen showed, then opens', async () => {
    mockQueryClient.setQueryData(PROFILE_QUERY_KEY, profile('A', true));
    mockAccept.mockResolvedValue({ policyVersion: PRIVACY_POLICY_VERSION });
    await accept.acceptCurrentConsent('A');
    expect(mockAccept).toHaveBeenCalledWith('A', { policyVersion: PRIVACY_POLICY_VERSION });
    expect(gate.readKeptConsent('A')).toBe(PRIVACY_POLICY_VERSION);
    expect(gate.currentConsentGate('A')).toBe('accepted');
  });

  it('keeps nothing and leaves the screen up when the POST fails', async () => {
    mockQueryClient.setQueryData(PROFILE_QUERY_KEY, profile('A', true));
    mockAccept.mockRejectedValue(new Error('offline'));
    await expect(accept.acceptCurrentConsent('A')).rejects.toThrow('offline');
    expect(gate.readKeptConsent('A')).toBeUndefined();
    expect(gate.currentConsentGate('A')).toBe('required');
  });

  it("never marks another account's cached profile as accepted", async () => {
    mockQueryClient.setQueryData(PROFILE_QUERY_KEY, profile('B', true));
    mockAccept.mockResolvedValue({ policyVersion: PRIVACY_POLICY_VERSION });
    await accept.acceptCurrentConsent('A');
    expect(gate.currentConsentGate('B')).toBe('required');
    expect(gate.readKeptConsent('B')).toBeUndefined();
  });
});

it('does not cancel or modify the new account profile after a late acceptance', async () => {
  let finish!: (value: unknown) => void;
  mockAccept.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = accept.acceptCurrentConsent('A');
  mockOwner = 'B';
  mockQueryClient.setQueryData(PROFILE_QUERY_KEY, profile('B', true));
  const cancelled = jest.spyOn(mockQueryClient, 'cancelQueries');
  finish({ policyVersion: PRIVACY_POLICY_VERSION });
  await pending;
  expect(cancelled).not.toHaveBeenCalled();
  expect(gate.currentConsentGate('B')).toBe('required');
  cancelled.mockRestore();
});
