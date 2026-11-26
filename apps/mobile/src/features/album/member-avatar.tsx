import { Text, View } from 'react-native';

// Initials in a circle. Every avatar in the filter sheet and the pills is this until S-29 gives
// members a photo (D-143).
export function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0]!, parts[parts.length - 1]!] : parts;
  return letters.map((part) => Array.from(part)[0]!.toUpperCase()).join('');
}

export function MemberAvatar({ name, size = 40 }: { name: string; size?: number }) {
  return (
    <View
      style={{ width: size, height: size, borderRadius: size / 2 }}
      className="items-center justify-center overflow-hidden bg-surfaceMuted">
      <Text className="font-semibold text-fieldLabel text-textSecondary">{initials(name)}</Text>
    </View>
  );
}
