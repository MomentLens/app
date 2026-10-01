import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { Platform } from 'react-native';

import { useCreateEvent } from '@/features/events/use-create-event';
import { useTokenColor } from '@/hooks/use-token-color';
import { CREATE_IN_TAB_BAR } from '@/lib/platform';

// The colors both shells' tab bars take, so opening an event swaps the tabs and nothing else
// (D-112, D-118). iOS draws SF Symbols and, from iOS 26, Liquid Glass, so it gets no background of
// its own there. Unselected items take the label color as iOS 26's do, and the selected one the
// gold. Android draws Material Symbols on Material 3's navigation bar, with the surface token
// behind and a gold-tinted pill under the selected item.
export function useTabBarColors() {
  const surface = useTokenColor('surface');
  const indicator = useTokenColor('accentTint');
  const primary = useTokenColor('textPrimary');
  const secondary = useTokenColor('textSecondary');
  const gold = useTokenColor('accentText');

  const idle = Platform.OS === 'ios' ? primary : secondary;
  const selected = Platform.OS === 'ios' ? gold : primary;

  return {
    backgroundColor: CREATE_IN_TAB_BAR ? undefined : surface,
    indicatorColor: indicator,
    iconColor: { default: idle, selected },
    labelStyle: { default: { color: idle }, selected: { color: selected } },
  };
}

// The Global shell's tab bar, each platform's own (D-112).
export default function AppTabs() {
  const createEvent = useCreateEvent();
  const colors = useTabBarColors();

  return (
    <NativeTabs {...colors}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Events</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'house', selected: 'house.fill' }} md="home" />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="profile">
        <NativeTabs.Trigger.Label>Profile</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'person.crop.circle', selected: 'person.crop.circle.fill' }}
          md="account_circle"
        />
      </NativeTabs.Trigger>

      {/* Create Event, as the round button iOS 26 sets apart at the bar's trailing end. It is
          disabled, so pressing it never selects its empty route; the press still arrives, and
          opens the wizard instead (lib/platform.ts). */}
      {CREATE_IN_TAB_BAR ? (
        <NativeTabs.Trigger
          name="create"
          role="search"
          disabled
          accessibilityLabel="Create an event"
          listeners={{ tabPress: createEvent }}>
          <NativeTabs.Trigger.Icon sf="plus" />
        </NativeTabs.Trigger>
      ) : null}
    </NativeTabs>
  );
}
