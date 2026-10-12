import { useRouter } from 'expo-router';
import { ActivityIndicator, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { lostAccess, useEvent } from '@/features/event-shell/use-event';
import { useTokenColor } from '@/hooks/use-token-color';
import { ApiError } from '@/lib/api';
import { printedPayload, venueQrProblem } from './venue-qr';
import { useVenueQrs } from './use-venue-qrs';

export function VenueQrSection({ eventId }: { eventId: string }) {
  const router = useRouter();
  const event = useEvent(eventId);
  const admin = event.data?.event.role === 'admin' && !lostAccess(event.error);
  const query = useVenueQrs(eventId, admin);
  const ink = useTokenColor('printInk');
  const paper = useTokenColor('printPaper');
  if (!admin) return null;
  return (
    <View className="gap-4">
      <Text accessibilityRole="header" className="font-h2 text-h2 text-textPrimary">
        Venue check-in codes
      </Text>
      <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
        Display each code at its venue. Guests scan it from My Media when location cannot check them
        in.
      </Text>
      {query.isPending && !query.isError ? (
        <ActivityIndicator
          accessibilityLabel="Loading venue codes"
          className="text-textSecondary"
        />
      ) : null}
      {query.isError ? (
        <FormMessage
          message={venueQrProblem(query.error instanceof ApiError ? query.error : {}, 'read')}
        />
      ) : null}
      {(!lostAccess(query.error) ? query.data?.venueQrs : undefined)?.map((qr) => (
        <View key={qr.venueId} className="items-center gap-4 rounded-[26px] bg-surface p-5">
          <Text accessibilityRole="header" className="font-h2 text-h2 text-textPrimary">
            {qr.venueName}
          </Text>
          <View
            accessible
            accessibilityLabel={`Venue check-in QR for ${qr.venueName}`}
            className="bg-printPaper p-1">
            <QRCode
              value={printedPayload(qr.payload)}
              size={144}
              quietZone={24}
              color={ink}
              backgroundColor={paper}
            />
          </View>
          <Button
            label="Preview and print"
            icon="qr-code"
            variant="secondary"
            disabled={query.isFetching || query.isError}
            onPress={() =>
              router.push({
                pathname: '/venue-qr/[eventId]/[venueId]',
                params: { eventId, venueId: qr.venueId },
              })
            }
          />
        </View>
      ))}
      <Button
        label="Refresh venue codes"
        variant="quiet"
        size="small"
        busy={query.isFetching}
        onPress={() => {
          void query.refetch();
        }}
      />
    </View>
  );
}
