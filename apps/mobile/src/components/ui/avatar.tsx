import { Image } from 'expo-image';
import { Text, View } from 'react-native';

import { useMyProfile } from '@/hooks/use-my-profile';
import { presignedSource } from '@/lib/images';

interface AvatarProps {
  size?: number;
}

function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0]!, parts[parts.length - 1]!] : parts;
  return letters.map((part) => Array.from(part)[0]!.toUpperCase()).join('');
}

// The signed-in user's profile photo, or their initials until they add one. Decorative: whatever
// holds it carries the label.
export function Avatar({ size = 32 }: AvatarProps) {
  const profile = useMyProfile();
  const avatar = profile.data?.avatar ?? null;
  const name = profile.data?.fullName ?? '';

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, borderRadius: size / 2 }}
      className="items-center justify-center overflow-hidden bg-surfaceMuted">
      {avatar ? (
        <Image
          source={presignedSource(avatar)}
          style={{ width: size, height: size }}
          contentFit="cover"
        />
      ) : name ? (
        <Text className="font-micro text-micro text-textSecondary">{initials(name)}</Text>
      ) : null}
    </View>
  );
}
