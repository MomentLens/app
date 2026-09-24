import { Text, View } from 'react-native';

interface FormMessageProps {
  message: string;
  tone?: 'error' | 'info';
}

// A message about the whole form rather than one field: what the server said, or what happens
// next. A screen reader announces it when it appears.
export function FormMessage({ message, tone = 'error' }: FormMessageProps) {
  const error = tone === 'error';
  return (
    <View
      accessibilityRole={error ? 'alert' : 'text'}
      accessibilityLiveRegion="polite"
      className={`rounded-xl px-4 py-3 ${error ? 'bg-dangerTint' : 'bg-surfaceMuted'}`}>
      <Text
        className={`font-bodySecondary text-bodySecondary ${error ? 'text-danger' : 'text-textPrimary'}`}>
        {message}
      </Text>
    </View>
  );
}
