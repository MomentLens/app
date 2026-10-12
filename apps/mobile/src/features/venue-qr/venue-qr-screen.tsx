import type { ManagedVenueQr } from '@momentlens/shared-types';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import type Svg from 'react-native-svg';

import { BarIconButton } from '@/components/ui/bar-icon-button';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { GLYPH } from '@/components/ui/glyph';
import { lostAccess, useEvent } from '@/features/event-shell/use-event';
import { useTokenColor } from '@/hooks/use-token-color';
import { ApiError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import {
  PRINT_QR_SIZE,
  PRINT_QUIET_ZONE,
  ROTATION_MESSAGE,
  printedPayload,
  venueQrProblem,
} from './venue-qr';
import { exportVenueQr, freshVenueQrs, rotateVenueQr, useVenueQrs } from './use-venue-qrs';

export function VenueQrImage({
  qr,
  print = false,
  onRef,
  onError,
}: {
  qr: ManagedVenueQr;
  print?: boolean;
  onRef?: (svg: Svg | null) => void;
  onError?: () => void;
}) {
  const ink = useTokenColor('printInk');
  const paper = useTokenColor('printPaper');
  const { width } = useWindowDimensions();
  const previewSize = Math.min(240, Math.max(120, width - 152));
  return (
    <QRCode
      value={printedPayload(qr.payload)}
      size={print ? PRINT_QR_SIZE : previewSize}
      quietZone={print ? PRINT_QUIET_ZONE : 32}
      color={ink}
      backgroundColor={paper}
      getRef={onRef}
      onError={onError}
    />
  );
}
function confirmRotation(): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(
      'Replace this venue code?',
      ROTATION_MESSAGE,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Replace code', style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    ),
  );
}
export function VenueQrScreen({ eventId, venueId }: { eventId: string; venueId: string }) {
  const owner = useAuthStore((state) => state.userId);
  return (
    <QrContent
      key={`${owner}/${eventId}/${venueId}`}
      owner={owner}
      eventId={eventId}
      venueId={venueId}
    />
  );
}
function QrContent({
  eventId,
  venueId,
  owner,
}: {
  eventId: string;
  venueId: string;
  owner: string | null;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const event = useEvent(eventId);
  const admin = event.data?.event.role === 'admin' && !lostAccess(event.error);
  const query = useVenueQrs(eventId, admin);
  const qr =
    admin && !lostAccess(query.error)
      ? query.data?.venueQrs.find((item) => item.venueId.toLowerCase() === venueId.toLowerCase())
      : undefined;
  const background = useTokenColor('background');
  const foreground = useTokenColor('textPrimary');
  const mounted = useRef(true);
  const working = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [printing, setPrinting] = useState<ManagedVenueQr | null>(null);
  const pending = useRef<{
    resolve(data: string): void;
    reject(): void;
    requested: boolean;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.reject();
    };
  }, []);
  function begin() {
    if (working.current || !owner || !admin) return false;
    working.current = true;
    setBusy(true);
    setMessage(undefined);
    return true;
  }
  function finish(text?: string) {
    working.current = false;
    if (mounted.current && useAuthStore.getState().userId === owner) {
      setBusy(false);
      setPrinting(null);
      setMessage(text);
    }
  }
  function render(fresh: ManagedVenueQr): Promise<string> {
    return new Promise((resolve, reject) => {
      const fail = () => {
        if (!pending.current) return;
        clearTimeout(pending.current.timer);
        pending.current = null;
        reject(new Error('QR rendering failed.'));
      };
      pending.current = {
        requested: false,
        timer: setTimeout(fail, 10_000),
        reject: fail,
        resolve: (data) => {
          if (!pending.current) return;
          clearTimeout(pending.current.timer);
          pending.current = null;
          resolve(data);
        },
      };
      setPrinting(fresh);
    });
  }
  function printRef(svg: Svg | null) {
    if (!svg || !pending.current || pending.current.requested) return;
    const request = pending.current;
    request.requested = true;
    requestAnimationFrame(() => {
      if (!mounted.current || pending.current !== request) return;
      try {
        svg.toDataURL((png) => {
          if (pending.current === request) request.resolve(png);
        });
      } catch {
        if (pending.current === request) request.reject();
      }
    });
  }
  async function print() {
    if (!begin() || !owner) return;
    const result = await exportVenueQr(eventId, venueId, owner, render);
    finish(result.ok ? undefined : result.problem);
  }
  async function rotate() {
    if (!qr || !begin() || !owner) return;
    if (
      !(await confirmRotation()) ||
      !mounted.current ||
      useAuthStore.getState().userId !== owner
    ) {
      finish();
      return;
    }
    const result = await rotateVenueQr(eventId, qr, owner);
    finish(result.ok ? 'New code ready. Print and display it at the venue.' : result.problem);
  }
  async function refresh() {
    if (!begin() || !owner) return;
    try {
      await freshVenueQrs(eventId, owner);
      finish();
    } catch (error) {
      finish(venueQrProblem(error instanceof ApiError ? error : {}, 'read'));
    }
  }
  const disabled = busy || query.isFetching || query.isError || !qr;
  return (
    <View className="flex-1 bg-background">
      <Stack.Screen
        options={
          Platform.OS === 'ios'
            ? {
                headerShown: true,
                title: 'Venue check-in QR',
                headerTintColor: foreground,
                headerShadowVisible: false,
                headerBackButtonDisplayMode: 'minimal',
                headerStyle: { backgroundColor: background },
              }
            : { headerShown: false }
        }
      />
      {Platform.OS === 'android' ? (
        <View style={{ paddingTop: insets.top }}>
          <View className="h-16 flex-row items-center gap-1 pl-1 pr-4">
            <BarIconButton glyph={GLYPH.back} label="Back" onPress={() => router.back()} />
            <Text accessibilityRole="header" className="flex-1 font-h2 text-h2 text-textPrimary">
              Venue check-in QR
            </Text>
          </View>
        </View>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="items-stretch gap-5 px-5 pb-10 pt-6">
        {!admin && !event.isPending ? (
          <FormMessage message="Only this event's Admin can manage venue codes." />
        ) : null}
        {event.isPending || (admin && query.isPending && !query.isError) ? (
          <ActivityIndicator
            className="text-textSecondary"
            accessibilityLabel="Loading venue code"
          />
        ) : null}
        {query.isError ? (
          <FormMessage
            message={venueQrProblem(query.error instanceof ApiError ? query.error : {}, 'read')}
          />
        ) : null}
        {message ? <FormMessage tone="info" message={message} /> : null}
        {qr ? (
          <>
            <View className="items-center gap-4 rounded-3xl bg-surface p-5">
              <Text
                accessibilityRole="header"
                className="text-center font-h1 text-h1 text-textPrimary">
                {qr.venueName}
              </Text>
              <View
                accessible
                accessibilityLabel={`Venue check-in QR for ${qr.venueName}`}
                className="bg-printPaper p-1">
                <VenueQrImage qr={qr} />
              </View>
              <Text className="text-center font-bodySecondary text-bodySecondary text-textSecondary">
                Display this code at the venue. It checks a Guest in for the sub-event live there
                when they scan.
              </Text>
            </View>
            <Button
              label="Download for printing"
              icon="qr-code"
              disabled={disabled}
              busy={busy}
              onPress={() => {
                void print();
              }}
            />
            <Text className="font-caption text-caption text-textSecondary">
              Printing refreshes the code online, then opens your phone&apos;s share sheet with a
              PNG. Choose where to save or print it.
            </Text>
            <Button
              label="Replace venue code"
              variant="destructive"
              disabled={disabled}
              onPress={() => {
                void rotate();
              }}
            />
          </>
        ) : admin && query.data && !query.isError ? (
          <FormMessage message="This venue is no longer in the event. Return to the schedule for its current venue." />
        ) : null}
        {admin ? (
          <Button
            label="Refresh code"
            variant="quiet"
            busy={query.isFetching}
            disabled={busy}
            onPress={() => {
              void refresh();
            }}
          />
        ) : null}
      </ScrollView>
      {printing ? (
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ position: 'absolute', left: -2 * (PRINT_QR_SIZE + PRINT_QUIET_ZONE * 2) }}>
          <VenueQrImage
            qr={printing}
            print
            onRef={printRef}
            onError={() => pending.current?.reject()}
          />
        </View>
      ) : null}
    </View>
  );
}
