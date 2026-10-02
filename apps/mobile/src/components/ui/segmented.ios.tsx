import { Picker, Text } from '@expo/ui/swift-ui';
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';

import type { SegmentedProps } from '@/components/ui/segmented.types';
import { TintedHost } from '@/components/ui/tinted-host';

// UIKit's segmented control, through SwiftUI's Picker in its segmented style (D-124).
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: SegmentedProps<T>) {
  return (
    <TintedHost
      matchContents={{ vertical: true }}
      style={{ width: '100%' }}
      accessibilityLabel={accessibilityLabel}
      className="text-accent">
      <Picker
        selection={value}
        onSelectionChange={(next) => onChange(next as T)}
        modifiers={[pickerStyle('segmented')]}>
        {options.map((option) => (
          <Text key={String(option.value)} modifiers={[tag(option.value)]}>
            {option.label}
          </Text>
        ))}
      </Picker>
    </TintedHost>
  );
}
