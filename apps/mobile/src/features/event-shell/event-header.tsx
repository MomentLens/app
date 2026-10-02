import { View } from 'react-native';

import { BackButton } from '@/components/ui/back-button';

// The Event shell's bar while there are no tabs to draw the Event header: the event is loading,
// failed to load, or is out of reach. It keeps the way back to Events (spec §2.5.1).
export function EventHeader({ onBack }: { onBack: () => void }) {
  return (
    <View className="h-14 flex-row items-center bg-background ios:px-4 android:px-1">
      <BackButton label="Back to Events" onPress={onBack} />
    </View>
  );
}
