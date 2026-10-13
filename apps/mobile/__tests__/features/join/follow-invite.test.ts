import { beforeEach, expect, it, jest } from '@jest/globals';
import type { ResolveInviteResponse } from '@momentlens/shared-types';
import { createRequire } from 'node:module';
import { createElement, useEffect, type ReactElement } from 'react';
import { useFollowInvite } from '@/features/join/follow-invite';

let mockGate = 'required';
const mockSave = jest.fn();
const mockDismiss = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ dismissTo: mockDismiss, replace: jest.fn() }),
}));
jest.mock('@/features/consent/gate', () => ({ currentConsentGate: () => mockGate }));
jest.mock('@/features/join/pending-invite', () => ({
  savePendingInvite: (value: unknown) => mockSave(value),
  clearPendingInvite: jest.fn(),
}));
jest.mock('@/features/events/use-events', () => ({ EVENTS_QUERY_KEY: ['events'] }));
jest.mock('@/lib/query-client', () => ({ queryClient: { invalidateQueries: jest.fn() } }));
jest.mock('@/stores/auth', () => ({
  useAuthStore: { getState: () => ({ status: 'signedIn', userId: 'A' }) },
}));
interface Renderer {
  create(element: ReactElement): { unmount(): void };
  act(run: () => Promise<void>): Promise<void>;
}
const renderer = jest.requireActual<Renderer>(
  createRequire(require.resolve('jest-expo/package.json')).resolve('react-test-renderer'),
);
let follow: ReturnType<typeof useFollowInvite>;
function Probe() {
  const value = useFollowInvite();
  useEffect(() => {
    follow = value;
  }, [value]);
  return null;
}
const answer = {
  event: { id: 'event', name: 'Mehndi' },
  role: 'guest',
  membership: null,
} as ResolveInviteResponse;
beforeEach(() => {
  mockGate = 'required';
  jest.clearAllMocks();
});
async function openInvite() {
  let tree!: ReturnType<Renderer['create']>;
  await renderer.act(async () => {
    tree = renderer.create(createElement(Probe));
  });
  follow({ code: 'K7Q2XP' }, answer);
  await renderer.act(async () => tree.unmount());
}
it('keeps the invite and shows consent before Join Confirmation', async () => {
  await openInvite();
  expect(mockSave).toHaveBeenCalledWith({
    lookup: { code: 'K7Q2XP' },
    eventName: 'Mehndi',
    role: 'guest',
  });
  expect(mockDismiss).toHaveBeenCalledWith('/consent');
});
it('opens Join Confirmation once consent is accepted', async () => {
  mockGate = 'accepted';
  await openInvite();
  expect(mockDismiss).toHaveBeenCalledWith('/join/confirm');
});
