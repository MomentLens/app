import { SegmentedButton, SingleChoiceSegmentedButtonRow, Text } from '@expo/ui/jetpack-compose';
import { fillMaxWidth } from '@expo/ui/jetpack-compose/modifiers';

import type { SegmentedProps } from '@/components/ui/segmented.types';
import { TintedHost } from '@/components/ui/tinted-host';

// Material 3's single-choice segmented buttons, through Compose (D-124).
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
      <SingleChoiceSegmentedButtonRow modifiers={[fillMaxWidth()]}>
        {options.map((option) => (
          <SegmentedButton
            key={String(option.value)}
            selected={option.value === value}
            onClick={() => onChange(option.value)}>
            <SegmentedButton.Label>
              <Text>{option.label}</Text>
            </SegmentedButton.Label>
          </SegmentedButton>
        ))}
      </SingleChoiceSegmentedButtonRow>
    </TintedHost>
  );
}
