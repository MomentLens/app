import type { EventType } from '@momentlens/shared-types';
import { Picker } from '@expo/ui';
import { Text } from 'react-native';

import { Row } from '@/components/ui/grouped';
import { TintedHost } from '@/components/ui/tinted-host';
import { EVENT_TYPE_LABEL, EVENT_TYPES, type TypeSelectProps } from '@/features/events/event-type';

// Step 1's Event Type on iOS (D-110): a row with SwiftUI's menu picker at its trailing end, as a
// settings row picks one of a few (D-124). Until a type is chosen it reads "Choose".
export function TypeSelect({ value, onChange, error }: TypeSelectProps) {
  return (
    <Row
      trailing={
        <TintedHost matchContents className="text-accentText">
          <Picker<EventType | ''>
            appearance="menu"
            selectedValue={value ?? ''}
            onValueChange={(next) => {
              if (next !== '') onChange(next);
            }}>
            {value === null ? <Picker.Item value="" label="Choose" /> : null}
            {EVENT_TYPES.map((type) => (
              <Picker.Item key={type} value={type} label={EVENT_TYPE_LABEL[type]} />
            ))}
          </Picker>
        </TintedHost>
      }>
      <Text className="font-body text-body text-textPrimary">Type</Text>
      {error ? (
        <Text accessibilityLiveRegion="polite" className="font-caption text-caption text-danger">
          {error}
        </Text>
      ) : null}
    </Row>
  );
}
