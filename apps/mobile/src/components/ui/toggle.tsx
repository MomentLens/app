import { Switch } from '@expo/ui';

import { TintedHost } from '@/components/ui/tinted-host';

interface ToggleProps {
  value: boolean;
  onValueChange: (value: boolean) => void;
  accessibilityLabel: string;
  disabled?: boolean;
}

// Each platform's own switch through @expo/ui: SwiftUI's toggle on iOS and Material 3's switch on
// Android, gold in both modes (D-124). React Native's Switch drew AppCompat's thumb-over-track on
// Android.
export function Toggle({
  value,
  onValueChange,
  accessibilityLabel,
  disabled = false,
}: ToggleProps) {
  return (
    <TintedHost matchContents accessibilityLabel={accessibilityLabel} className="text-accent">
      <Switch value={value} onValueChange={onValueChange} disabled={disabled} />
    </TintedHost>
  );
}
