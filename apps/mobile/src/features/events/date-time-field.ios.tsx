import { DatePicker } from '@expo/ui/swift-ui';
import { datePickerStyle, labelsHidden } from '@expo/ui/swift-ui/modifiers';
import { Text } from 'react-native';

import { Row } from '@/components/ui/grouped';
import { TintedHost } from '@/components/ui/tinted-host';
import type { DateTimeFieldProps } from '@/features/events/date-time-field.types';

// A sub-event's start or end on iOS: a row with SwiftUI's compact date picker, a date button and a
// time button that open Apple's calendar and time wheel (D-128). Times are the phone's own zone,
// and a start in the past is allowed (D-110).
export function DateTimeField({ label, value, onChange, error }: DateTimeFieldProps) {
  return (
    <Row
      trailing={
        <TintedHost matchContents className="text-accentText">
          <DatePicker
            title={label}
            selection={value}
            displayedComponents={['date', 'hourAndMinute']}
            onDateChange={onChange}
            modifiers={[datePickerStyle('compact'), labelsHidden()]}
          />
        </TintedHost>
      }>
      <Text className="font-body text-body text-textPrimary">{label}</Text>
      {error ? (
        <Text accessibilityLiveRegion="polite" className="font-caption text-caption text-danger">
          {error}
        </Text>
      ) : null}
    </Row>
  );
}
