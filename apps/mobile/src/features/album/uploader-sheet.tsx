import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { SearchField } from '@/components/ui/search-field';
import { Sheet } from '@/components/ui/sheet';
import { SheetHandle, SheetToolbar } from '@/components/ui/sheet-toolbar';
import { useUploaders } from './use-album';

const IOS = Platform.OS === 'ios';

interface UploaderSheetProps {
  eventId: string;
  isOpen: boolean;
  selectedUploaderId?: string;
  onSelect: (uploaderId: string | undefined) => void;
  onClose: () => void;
}

function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0]!, parts[parts.length - 1]!] : parts;
  return letters.map((part) => Array.from(part)[0]!.toUpperCase()).join('');
}

function MemberAvatar({ name, size = 40 }: { name: string; size?: number }) {
  return (
    <View
      style={{ width: size, height: size, borderRadius: size / 2 }}
      className="items-center justify-center overflow-hidden bg-surfaceMuted">
      <Text className="font-semibold text-fieldLabel text-textSecondary">{initials(name)}</Text>
    </View>
  );
}

// Filter sheet (spec §2.5.2, D-148):
// Ships with its Uploader half in S-13; S-23 adds People above it.
// Searchable client-side list of active members with published photos (D-148).
export function UploaderSheet({
  eventId,
  isOpen,
  selectedUploaderId,
  onSelect,
  onClose,
}: UploaderSheetProps) {
  return (
    <Sheet target={isOpen ? true : null} onClose={onClose}>
      {() => (
        <UploaderSheetContent
          eventId={eventId}
          selectedUploaderId={selectedUploaderId}
          onSelect={onSelect}
          onClose={onClose}
        />
      )}
    </Sheet>
  );
}

function UploaderSheetContent({
  eventId,
  selectedUploaderId,
  onSelect,
  onClose,
}: {
  eventId: string;
  selectedUploaderId?: string;
  onSelect: (uploaderId: string | undefined) => void;
  onClose: () => void;
}) {
  const uploadersQuery = useUploaders(eventId);
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<'people' | 'uploaders'>('uploaders');

  const uploaders = uploadersQuery.data?.uploaders ?? [];
  const filtered = uploaders.filter((u) =>
    u.fullName.toLowerCase().includes(search.toLowerCase().trim()),
  );

  return (
    <View className="flex-1 bg-background">
      <SheetHandle />
      <SheetToolbar title="Filter" onClose={onClose} />

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, gap: 16 }}>
        {/* Segmented Control */}
        <View className={IOS ? 'flex-row rounded-xl bg-surfaceElevated p-1' : 'flex-row gap-2'}>
          <Pressable
            accessibilityRole="tab"
            accessibilityLabel="People filter"
            onPress={() => setActiveTab('people')}
            className={
              IOS
                ? `flex-1 items-center justify-center rounded-lg py-2 ${
                    activeTab === 'people' ? 'bg-surface shadow-sm' : ''
                  }`
                : `flex-1 items-center justify-center rounded-xl border py-2.5 ${
                    activeTab === 'people'
                      ? 'border-accent bg-accent/20'
                      : 'border-border bg-surface'
                  }`
            }>
            <Text
              className={
                activeTab === 'people'
                  ? 'font-body font-semibold text-textPrimary'
                  : 'font-body text-textSecondary'
              }>
              People
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="tab"
            accessibilityLabel="Uploaders filter"
            onPress={() => setActiveTab('uploaders')}
            className={
              IOS
                ? `flex-1 items-center justify-center rounded-lg py-2 ${
                    activeTab === 'uploaders' ? 'bg-surface shadow-sm' : ''
                  }`
                : `flex-1 items-center justify-center rounded-xl border py-2.5 ${
                    activeTab === 'uploaders'
                      ? 'border-accent bg-accent/20'
                      : 'border-border bg-surface'
                  }`
            }>
            <Text
              className={
                activeTab === 'uploaders'
                  ? 'font-body font-semibold text-textPrimary'
                  : 'font-body text-textSecondary'
              }>
              Uploaders
            </Text>
          </Pressable>
        </View>

        {activeTab === 'people' ? (
          <View className="items-center justify-center py-12">
            <Icon name="user" size={32} className="mb-2 text-textSecondary" />
            <Text className="font-h2 text-h2 text-textPrimary">People Filter</Text>
            <Text className="mt-1 text-center font-body text-body text-textSecondary">
              Searching by matched faces arrives in a future update.
            </Text>
          </View>
        ) : (
          <>
            {/* Search Field */}
            <SearchField placeholder="Search uploaders" value={search} onChangeText={setSearch} />

            {/* Uploaders list section */}
            <View className="gap-2">
              <Text className="font-bodySecondary text-bodySecondary text-accentText">
                {"In this event's photos"}
              </Text>

              {uploadersQuery.isPending ? (
                <View className="py-8 items-center justify-center">
                  <ActivityIndicator className="text-textSecondary" />
                </View>
              ) : filtered.length === 0 ? (
                <View className="py-8 items-center justify-center">
                  <Text className="font-body text-body text-textSecondary">
                    {search ? `No uploaders match "${search}"` : 'No uploaders yet'}
                  </Text>
                </View>
              ) : (
                <View className="overflow-hidden rounded-2xl border border-border bg-surface">
                  {filtered.map((uploader, index) => {
                    const isSelected = selectedUploaderId === uploader.userId;
                    const isLast = index === filtered.length - 1;

                    return (
                      <Pressable
                        key={uploader.userId}
                        accessibilityRole="button"
                        accessibilityLabel={`${uploader.fullName}, ${uploader.photoCount} photos`}
                        onPress={() => {
                          onSelect(isSelected ? undefined : uploader.userId);
                          onClose();
                        }}
                        className={`flex-row items-center justify-between p-3.5 ${
                          !isLast ? 'border-b border-border' : ''
                        } ${isSelected ? 'bg-surfaceElevated' : ''}`}>
                        <View className="flex-row items-center gap-3">
                          <MemberAvatar name={uploader.fullName} size={36} />
                          <View>
                            <Text className="font-body font-semibold text-textPrimary">
                              {uploader.fullName}
                            </Text>
                            {uploader.role === 'photographer' ? (
                              <Text className="font-caption text-caption text-textSecondary">
                                Photographer
                              </Text>
                            ) : null}
                          </View>
                        </View>
                        <View className="flex-row items-center gap-2">
                          <Text className="font-body text-body text-textSecondary">
                            {uploader.photoCount}
                          </Text>
                          {isSelected ? (
                            <Text className="font-body font-bold text-accentText">✓</Text>
                          ) : null}
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}
