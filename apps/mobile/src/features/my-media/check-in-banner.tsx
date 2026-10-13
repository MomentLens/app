import { Platform } from 'react-native';

import { GLYPH } from '@/components/ui/glyph';
import type { CheckInNotice } from '@/features/verification/notice';

import type { StatusRow } from './queue-banner';

const IOS = Platform.OS === 'ios';

export interface LocationCheck {
  off: boolean;
  busy: boolean;
  error?: string;
  enable(): Promise<void>;
}

// The check-in rows of My Media's status banner (D-159), as short as each message allows. Which
// rows show is S-15, S-16 and S-17's rule: the Scan Venue QR button only while a sub-event is In
// Progress and the person is not checked in for it, the only way to the scanner (D-131), and "Ask
// the organizer to check you in." for photos held by a sub-event that has ended (D-157). An
// exempt role gets no notice at all.
export function checkInRows(
  notice: CheckInNotice | null,
  location: LocationCheck,
  onScan: () => void,
): StatusRow[] {
  if (!notice) return [];
  const rows: StatusRow[] = [];
  if (notice.liveNames.length) {
    if (location.off)
      rows.push({
        key: 'location',
        glyph: { ios: 'location.slash', android: 'location_off' },
        title: 'Location is off',
        // Under the button whose press failed.
        error: location.error,
        actions: [
          {
            label: IOS ? 'Turn On Location' : 'Turn on location',
            icon: 'navigation',
            busy: location.busy,
            onPress: () => {
              void location.enable();
            },
          },
        ],
      });
    rows.push({
      key: 'scan',
      glyph: GLYPH.qr,
      title: `Not checked in · ${notice.liveNames.join(', ')}`,
      detail: location.off ? undefined : 'Still waiting? Ask the organizer to check you in.',
      actions: [
        {
          label: IOS ? 'Scan Venue QR' : 'Scan venue QR',
          icon: 'qr-code',
          variant: IOS ? 'secondary' : 'tonal',
          onPress: onScan,
        },
      ],
    });
  }
  if (notice.endedPhotos)
    rows.push({
      key: 'ended',
      glyph: GLYPH.approvals,
      title: 'Ask the organizer to check you in.',
      detail: `${notice.endedPhotos} ${notice.endedPhotos === 1 ? 'photo' : 'photos'} from a sub-event that has ended`,
    });
  if (notice.localNames.length)
    rows.push({
      key: 'saved',
      glyph: GLYPH.check,
      title: `Check-in saved · ${notice.localNames.join(', ')}`,
      detail: 'Sent with the next upload',
    });
  return rows;
}
