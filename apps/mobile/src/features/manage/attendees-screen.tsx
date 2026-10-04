import type { Attendee, MembershipRole } from '@momentlens/shared-types';
import { FlashList } from '@shopify/flash-list';
import { Stack, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BarIconButton } from '@/components/ui/bar-icon-button';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { GLYPH, Glyph } from '@/components/ui/glyph';
import { SearchField } from '@/components/ui/search-field';
import { AttendeeInitials } from '@/features/manage/attendee-sheet';
import { attendeeListItems, useAttendees } from '@/features/manage/use-attendees';
import { useTokenColor } from '@/hooks/use-token-color';
import { useAuthStore } from '@/stores/auth';

const IOS = Platform.OS === 'ios';
export function AttendeesScreen({ eventId }: { eventId: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const background = useTokenColor('background');
  const foreground = useTokenColor('textPrimary');
  const border = useTokenColor('border');
  const ripple = useTokenColor('textPrimary', 0.12);
  const owner = useAuthStore((state) => state.userId);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<MembershipRole | undefined>();
  const query = useAttendees(eventId, { search, role });
  const items = useMemo(
    () => attendeeListItems(query.data?.pages.flatMap((page) => page.attendees) ?? []),
    [query.data],
  );
  const stickyHeaders = useMemo(
    () => items.flatMap((item, index) => (item.type === 'header' ? [index] : [])),
    [items],
  );

  function open(attendee: Attendee) {
    router.push({
      pathname: '/attendee/[eventId]/[userId]',
      params: { eventId, userId: attendee.userId, search, role: role ?? '' },
    });
  }

  const choices = [
    { value: undefined, label: 'All' },
    { value: 'guest' as const, label: 'Guests' },
    { value: 'photographer' as const, label: 'Photographers' },
    { value: 'admin' as const, label: 'Organizer' },
  ];

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen
        options={
          IOS
            ? {
                headerShown: true,
                title: 'Attendees',
                headerLargeTitleEnabled: false,
                headerTransparent: false,
                headerShadowVisible: false,
                headerTintColor: foreground,
                headerStyle: { backgroundColor: background },
              }
            : { headerShown: false }
        }
      />
      {!IOS ? (
        <View style={{ paddingTop: insets.top }}>
          <View className="h-16 flex-row items-center gap-1 pl-1 pr-4">
            <BarIconButton
              glyph={GLYPH.back}
              label="Back to Manage"
              onPress={() => router.back()}
            />
            <Text accessibilityRole="header" className="px-1 font-h2 text-h2 text-textPrimary">
              Attendees
            </Text>
          </View>
        </View>
      ) : null}
      <View className="gap-3 pt-2 ios:px-5 android:px-4">
        <SearchField
          placeholder="Search names"
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: 8, paddingBottom: 8 }}>
          {choices.map((choice) => {
            const selected = choice.value === role;
            return (
              <Pressable
                key={choice.label}
                accessibilityRole="button"
                accessibilityLabel={`Filter ${choice.label}`}
                accessibilityState={{ selected }}
                onPress={() => setRole(choice.value)}
                android_ripple={{ color: ripple }}
                className={`min-h-11 flex-row items-center gap-2 overflow-hidden px-4 ios:rounded-full android:rounded-lg ${selected ? 'ios:bg-textPrimary android:bg-accentTint' : 'ios:bg-surfaceMuted android:border android:border-borderStrong'}`}>
                {selected && !IOS ? <Glyph name={GLYPH.check} size={18} tone="accentText" /> : null}
                <Text
                  className={`font-bodySecondary text-bodySecondary ${selected ? 'ios:text-background android:text-accentText' : 'text-textSecondary'}`}>
                  {choice.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
        {query.isError && items.length > 0 ? (
          <FormMessage message="Attendees could not be refreshed. Refresh before changing anyone." />
        ) : null}
      </View>
      <FlashList
        key={`${search}/${role ?? 'all'}`}
        data={items}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.type}
        stickyHeaderIndices={stickyHeaders}
        maintainVisibleContentPosition={{ disabled: true }}
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshing={query.isRefetching && !query.isFetchingNextPage}
        onRefresh={() => void query.refetch()}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (query.hasNextPage && !query.isFetching && !query.isError) void query.fetchNextPage();
        }}
        renderItem={({ item }) => {
          if (item.type === 'header')
            return (
              <View className="bg-background px-9 pb-2 pt-6">
                <Text
                  accessibilityRole="header"
                  className="ios:font-h2 ios:text-body ios:text-textSecondary android:font-fieldLabel android:text-fieldLabel android:text-accentText">
                  {item.title}
                </Text>
              </View>
            );
          const person = item.attendee;
          const subtitle = `${person.userId === owner ? 'You · ' : ''}${person.role === 'admin' ? 'Admin' : person.role === 'guest' ? 'Guest' : 'Photographer'}`;
          return (
            <View className="ios:mx-5 android:mx-4 android:pb-0.5">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${person.fullName}, ${subtitle}`}
                accessibilityHint="Opens attendee details."
                onPress={() => open(person)}
                android_ripple={{ color: ripple }}
                style={{
                  borderTopLeftRadius: item.first ? 26 : IOS ? 0 : 4,
                  borderTopRightRadius: item.first ? 26 : IOS ? 0 : 4,
                  borderBottomLeftRadius: item.last ? 26 : IOS ? 0 : 4,
                  borderBottomRightRadius: item.last ? 26 : IOS ? 0 : 4,
                }}
                className="min-h-20 flex-row items-center gap-3 overflow-hidden bg-surface px-4 py-3 ios:active:bg-surfaceMuted android:gap-4">
                {IOS && !item.first ? (
                  <View
                    pointerEvents="none"
                    style={{
                      position: 'absolute',
                      left: 80,
                      right: 0,
                      top: 0,
                      height: StyleSheet.hairlineWidth,
                      backgroundColor: border,
                    }}
                  />
                ) : null}
                <AttendeeInitials fullName={person.fullName} />
                <View className="flex-1 gap-0.5">
                  <Text className="font-body text-body text-textPrimary">{person.fullName}</Text>
                  <Text className="font-bodySecondary text-bodySecondary text-textSecondary">
                    {subtitle}
                  </Text>
                </View>
                {IOS ? <Glyph name={GLYPH.chevron} size={14} tone="textMuted" /> : null}
              </Pressable>
            </View>
          );
        }}
        ListEmptyComponent={
          <View className="items-center gap-4 px-8 py-16">
            {query.isPending ? (
              <ActivityIndicator className="text-textSecondary" />
            ) : (
              <>
                <Text className="text-center font-h2 text-h2 text-textPrimary">
                  {query.isError ? 'Attendees could not be loaded' : 'No attendees match'}
                </Text>
                <Text className="text-center font-body text-body text-textSecondary">
                  {query.isError
                    ? 'Check the connection and try again.'
                    : 'Try another name or role.'}
                </Text>
                {query.isError ? (
                  <Button
                    label="Try again"
                    variant="secondary"
                    busy={query.isFetching}
                    onPress={() => void query.refetch()}
                  />
                ) : null}
              </>
            )}
          </View>
        }
        ListFooterComponent={
          <View className="px-5 py-4">
            {query.isFetchingNextPage ? (
              <ActivityIndicator className="text-textSecondary" />
            ) : query.isError && items.length > 0 ? (
              <Button
                label="Try again"
                variant="secondary"
                busy={query.isFetching}
                onPress={() => {
                  if (query.isFetchNextPageError) void query.fetchNextPage();
                  else void query.refetch();
                }}
              />
            ) : query.hasNextPage ? (
              <Button
                label="Load more attendees"
                variant="quiet"
                onPress={() => void query.fetchNextPage()}
              />
            ) : null}
          </View>
        }
      />
    </View>
  );
}
