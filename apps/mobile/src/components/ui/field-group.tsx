import type { ReactNode } from 'react';
import { Platform, Text, View } from 'react-native';

import { Section } from '@/components/ui/grouped';

interface FieldGroupProps {
  header?: string;
  footer?: string;
  children: ReactNode;
}

// Fields that belong together. iOS puts them in one inset grouped section, a row each; Android
// stacks Material 3's outlined fields with 16dp between them (D-124).
export function FieldGroup({ header, footer, children }: FieldGroupProps) {
  if (Platform.OS === 'ios') {
    return (
      <Section header={header} footer={footer}>
        {children}
      </Section>
    );
  }
  return (
    <View className="mx-4 gap-4">
      {header ? (
        <Text
          accessibilityRole="header"
          className="font-fieldLabel text-fieldLabel text-accentText">
          {header}
        </Text>
      ) : null}
      {children}
      {footer ? (
        <Text className="px-4 font-caption text-caption text-textSecondary">{footer}</Text>
      ) : null}
    </View>
  );
}
