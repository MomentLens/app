import {
  Children,
  createContext,
  isValidElement,
  useContext,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { GLYPH, Glyph } from '@/components/ui/glyph';
import { useTokenColor } from '@/hooks/use-token-color';

const IOS = Platform.OS === 'ios';

// Where a row sits in its section: iOS draws a separator above every row but the first, and
// Android rounds the outer corners of the first and the last.
const RowPlace = createContext<{ first: boolean; last: boolean }>({ first: true, last: true });

interface SectionProps {
  header?: string;
  // A text action at the header's trailing end, such as Edit on the wizard's review.
  headerAction?: { label: string; onPress: () => void };
  footer?: ReactNode;
  children: ReactNode;
}

// A group of rows, as each platform draws a settings list (D-124). iOS: inset grouped, 26pt
// corners, a hairline between rows. Android: Material 3's grouped list, 20dp outer and 4dp inner
// corners with 2dp between items. Neither draws a border.
export function Section({ header, headerAction, footer, children }: SectionProps) {
  const rows = Children.toArray(children).filter(isValidElement) as ReactElement[];
  return (
    <View className="ios:mx-5 android:mx-4">
      {header || headerAction ? (
        <View className="flex-row items-baseline justify-between ios:px-4 ios:pb-2 android:px-4 android:pb-2 android:pt-2">
          {header ? (
            <Text
              accessibilityRole="header"
              className="flex-1 ios:font-h2 ios:text-body ios:text-textSecondary android:font-fieldLabel android:text-fieldLabel android:text-accentText">
              {header}
            </Text>
          ) : (
            <View />
          )}
          {headerAction ? (
            <Text
              accessibilityRole="button"
              suppressHighlighting
              onPress={headerAction.onPress}
              className="font-body text-body text-accentText">
              {headerAction.label}
            </Text>
          ) : null}
        </View>
      ) : null}
      <View className="ios:overflow-hidden ios:rounded-[26px] ios:bg-surface android:gap-0.5">
        {rows.map((row, i) => (
          <RowPlace.Provider
            key={row.key ?? i}
            value={{ first: i === 0, last: i === rows.length - 1 }}>
            {row}
          </RowPlace.Provider>
        ))}
      </View>
      {footer ? (
        typeof footer === 'string' ? (
          <Text className="px-4 pt-2 font-caption text-caption text-textSecondary">{footer}</Text>
        ) : (
          <View className="px-4 pt-2">{footer}</View>
        )
      ) : null}
    </View>
  );
}

// The gap between two sections.
export function SectionGap() {
  return <View className="ios:h-8 android:h-4" />;
}

interface RowProps {
  title?: string;
  subtitle?: string;
  // A value at the trailing end, such as "Off" or "2".
  value?: string;
  leading?: ReactNode;
  // The leading slot's width, 28 for a glyph. A thumbnail sets its own, and the iOS hairline
  // starts after it.
  leadingWidth?: number;
  trailing?: ReactNode;
  // iOS's disclosure chevron, for a row that opens another screen. Android draws none.
  chevron?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  // A row that is an action: gold text on iOS, as a button row is.
  action?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  // Centres the title, for an action row that stands alone such as Log Out.
  center?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  // Content instead of the title and subtitle, such as a text input.
  children?: ReactNode;
}

export function Row({
  title,
  subtitle,
  value,
  leading,
  leadingWidth = 28,
  trailing,
  chevron = false,
  onPress,
  onLongPress,
  action = false,
  destructive = false,
  disabled = false,
  center = false,
  accessibilityLabel,
  accessibilityHint,
  children,
}: RowProps) {
  const { first, last } = useContext(RowPlace);
  const ripple = useTokenColor('textPrimary', 0.12);
  const separator = useTokenColor('border');
  const pressable = onPress !== undefined || onLongPress !== undefined;

  const titleTone = destructive
    ? 'text-danger'
    : action && IOS
      ? 'text-accentText'
      : 'text-textPrimary';

  // Android rounds each item on its own; the first and last get the section's outer corners.
  const androidShape = IOS
    ? undefined
    : {
        borderTopLeftRadius: first ? 20 : 4,
        borderTopRightRadius: first ? 20 : 4,
        borderBottomLeftRadius: last ? 20 : 4,
        borderBottomRightRadius: last ? 20 : 4,
      };

  const body = (
    <>
      {leading ? (
        <View style={{ width: leadingWidth }} className="items-center">
          {leading}
        </View>
      ) : null}
      <View className={`flex-1 gap-0.5 ${center ? 'items-center' : ''}`}>
        {children ?? (
          <>
            {title ? <Text className={`font-body text-body ${titleTone}`}>{title}</Text> : null}
            {subtitle ? (
              <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
                {subtitle}
              </Text>
            ) : null}
          </>
        )}
      </View>
      {value ? <Text className="font-body text-body text-textSecondary">{value}</Text> : null}
      {trailing}
      {chevron && IOS ? <Glyph name={GLYPH.chevron} size={14} tone="textMuted" /> : null}
    </>
  );

  // The hairline starts where the text does, as iOS insets it.
  const hairline =
    IOS && !first ? (
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          left: leading ? 16 + leadingWidth + 12 : 16,
          height: StyleSheet.hairlineWidth,
          backgroundColor: separator,
        }}
      />
    ) : null;

  const className = `min-h-[52px] flex-row items-center gap-3 bg-surface px-4 ios:py-2.5 android:min-h-14 android:gap-4 android:py-3 ${disabled ? 'opacity-45' : ''}`;

  if (!pressable) {
    return (
      <View style={androidShape} className={className}>
        {hairline}
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      android_ripple={{ color: ripple }}
      style={androidShape}
      className={`${className} overflow-hidden ios:active:bg-surfaceMuted`}>
      {hairline}
      {body}
    </Pressable>
  );
}
