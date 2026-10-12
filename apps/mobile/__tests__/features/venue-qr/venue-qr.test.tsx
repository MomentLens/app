import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import { createElement, type ReactElement } from 'react';
import { VenueQrImage } from '@/features/venue-qr/venue-qr-screen';
import { VenueQrSection } from '@/features/venue-qr/venue-qr-section';
import {
  printedPayload,
  PRINT_QR_SIZE,
  PRINT_QUIET_ZONE,
  ROTATION_MESSAGE,
} from '@/features/venue-qr/venue-qr';
import type { ManagedVenueQr } from '@momentlens/shared-types';

let mockProps: {
  value: string;
  size: number;
  quietZone: number;
  color: string;
  backgroundColor: string;
  logo?: unknown;
};
let mockQrCount = 0;
let mockRefusal: { status: number } | undefined;
jest.mock('expo-router', () => ({ Stack: { Screen: () => null }, useRouter: () => ({}) }));
jest.mock('react-native-qrcode-svg', () => (props: typeof mockProps) => {
  mockQrCount++;
  mockProps = props;
  return null;
});
jest.mock('@/hooks/use-token-color', () => ({
  useTokenColor: (name: string) => (name === 'printInk' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)'),
}));
jest.mock('@/features/venue-qr/use-venue-qrs', () => ({
  useVenueQrs: () => ({
    data: { venueQrs: [mockQr] },
    error: mockRefusal,
    isError: Boolean(mockRefusal),
  }),
}));
jest.mock('@/features/event-shell/use-event', () => ({
  useEvent: () => ({ data: { event: { role: 'admin' } } }),
  lostAccess: (error: { status?: number } | undefined) =>
    error?.status === 403 ? 'not_member' : null,
}));
jest.mock('@/lib/api', () => ({ ApiError: class extends Error {} }));
jest.mock('@/stores/auth', () => ({}));
jest.mock('@/components/ui/bar-icon-button', () => ({}));
jest.mock('@/components/ui/button', () => ({ Button: () => null }));
jest.mock('@/components/ui/form-message', () => ({ FormMessage: () => null }));
jest.mock('@/components/ui/glyph', () => ({}));
const renderer = jest.requireActual<{
  act(action: () => void): void;
  create(element: ReactElement): { unmount(): void };
}>(createRequire(require.resolve('jest-expo/package.json')).resolve('react-test-renderer'));
const mockQr: ManagedVenueQr = {
  venueId: '11111111-1111-4111-8111-111111111111',
  venueName: 'Hall',
  payload: {
    kind: 'venue_check_in',
    version: 1,
    venueId: '11111111-1111-4111-8111-111111111111',
    secret: 'a'.repeat(64),
  },
};
beforeEach(() => {
  mockQrCount = 0;
  mockRefusal = undefined;
});
describe('printable venue QR', () => {
  it('hides the cached credential after the QR endpoint refuses membership', () => {
    mockRefusal = { status: 403 };
    let tree!: { unmount(): void };
    renderer.act(() => {
      tree = renderer.create(createElement(VenueQrSection, { eventId: mockQr.venueId }));
    });
    expect(mockQrCount).toBe(0);
    renderer.act(() => tree.unmount());
  });
  it('exports the versioned JSON as a high-contrast code with a quiet zone and no logo', () => {
    let tree!: { unmount(): void };
    renderer.act(() => {
      tree = renderer.create(createElement(VenueQrImage, { qr: mockQr, print: true }));
    });
    expect(JSON.parse(mockProps.value)).toEqual(mockQr.payload);
    expect(mockProps.size).toBe(PRINT_QR_SIZE);
    expect(mockProps.quietZone).toBe(PRINT_QUIET_ZONE);
    expect(mockProps.color).toBe('rgb(0, 0, 0)');
    expect(mockProps.backgroundColor).toBe('rgb(255, 255, 255)');
    expect(mockProps.logo).toBeUndefined();
    renderer.act(() => tree.unmount());
  });
  it('the poster and rotation warning preserve the approved credential rules', () => {
    expect(JSON.parse(printedPayload(mockQr.payload))).toEqual(mockQr.payload);
    expect(PRINT_QR_SIZE).toBe(1024);
    expect(PRINT_QUIET_ZONE).toBeGreaterThan(0);
    expect(ROTATION_MESSAGE).toContain('People already checked in stay checked in');
  });
});
