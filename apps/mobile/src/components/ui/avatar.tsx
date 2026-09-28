import { Image } from 'expo-image';
import { Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
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

// The signed-in user's profile photo, their initials until they add one, or a person glyph while
// there is no name to take them from. Decorative: whatever holds it carries the label.
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
        <Text
          className={`text-textSecondary ${size >= 64 ? 'font-h1 text-h1' : 'font-manrope-semibold text-fieldLabel'}`}>
          {initials(name)}
        </Text>
      ) : (
        // No name yet, or the profile did not load: a person rather than an empty circle.
        <Icon name="user" size={size / 2} className="text-textMuted" />
      )}
    </View>
  );
}
