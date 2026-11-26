import { useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';

import { Icon } from '@/components/ui/icon';
import { SearchField } from '@/components/ui/search-field';
import { Sheet } from '@/components/ui/sheet';
import { SheetHandle, SheetToolbar } from '@/components/ui/sheet-toolbar';
import { findMyPhotosAction } from '@/features/faces/find-my-photos';
import { useReferences } from '@/features/references/use-references';
import { byPlatform } from '@/lib/copy';
import type { PeopleFilter, UploaderFilter } from './filter-store';
import { MemberAvatar } from './member-avatar';
import { usePeople, useUploaders } from './use-album';

const IOS = Platform.OS === 'ios';

type Tab = 'people' | 'uploaders';

interface UploaderSheetProps {
  eventId: string;
  eventName: string;
  isOpen: boolean;
  people?: PeopleFilter;
  selectedUploaderId?: string;
  onSelectPeople: (people: PeopleFilter | undefined) => void;
  onSelect: (uploader: UploaderFilter | undefined) => void;
  onClose: () => void;
}

// Filter sheet (spec §2.5.2, D-148, D-176): People, with Find My Photos pinned at the top, and
// Uploaders. Both lists are searched on the phone. Unknown clusters are not listed here; a face in
// a photo is the only way to one.
export function UploaderSheet({ isOpen, onClose, ...props }: UploaderSheetProps) {
  return (
    <Sheet target={isOpen ? true : null} onClose={onClose}>
      {() => <FilterSheetContent {...props} onClose={onClose} />}
    </Sheet>
  );
}

function FilterSheetContent({
  eventId,
  eventName,
  people,
  selectedUploaderId,
  onSelectPeople,
  onSelect,
  onClose,
}: Omit<UploaderSheetProps, 'isOpen'>) {
  const [activeTab, setActiveTab] = useState<Tab>('people');

  return (
    <View className="flex-1 bg-background">
      <SheetHandle />
      <SheetToolbar title="Filter" onClose={onClose} />

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, gap: 16 }}>
        <View className={IOS ? 'flex-row rounded-xl bg-surfaceElevated p-1' : 'flex-row gap-2'}>
          <TabButton
            label="People"
            active={activeTab === 'people'}
            onPress={() => setActiveTab('people')}
          />
          <TabButton
            label="Uploaders"
            active={activeTab === 'uploaders'}
            onPress={() => setActiveTab('uploaders')}
          />
        </View>

        {activeTab === 'people' ? (
          <PeopleTab
            eventId={eventId}
            eventName={eventName}
            people={people}
            onSelectPeople={onSelectPeople}
            onClose={onClose}
          />
        ) : (
          <UploadersTab
            eventId={eventId}
            selectedUploaderId={selectedUploaderId}
            onSelect={onSelect}
            onClose={onClose}
          />
        )}
      </ScrollView>
    </View>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`${label} filter`}
      onPress={onPress}
      className={
        IOS
          ? `flex-1 items-center justify-center rounded-lg py-2 ${
              active ? 'bg-surface shadow-sm' : ''
            }`
          : `flex-1 items-center justify-center rounded-xl border py-2.5 ${
              active ? 'border-accent bg-accent/20' : 'border-border bg-surface'
            }`
      }>
      <Text
        className={
          active ? 'font-body font-semibold text-textPrimary' : 'font-body text-textSecondary'
        }>
        {label}
      </Text>
    </Pressable>
  );
}

function matches(name: string, search: string): boolean {
  return name.toLowerCase().includes(search.toLowerCase().trim());
}

function PeopleTab({
  eventId,
  eventName,
  people,
  onSelectPeople,
  onClose,
}: {
  eventId: string;
  eventName: string;
  people?: PeopleFilter;
  onSelectPeople: (people: PeopleFilter | undefined) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const peopleQuery = usePeople(eventId);
  const referencesQuery = useReferences(eventId);
  const [search, setSearch] = useState('');

  const action = findMyPhotosAction(referencesQuery.data?.references);
  const listed = (peopleQuery.data?.people ?? []).filter((p) => matches(p.fullName, search));
  const selectedPersonId = people?.kind === 'person' ? people.userId : undefined;

  const findMyPhotos = () => {
    if (action === 'checking') return;
    if (action === 'add') {
      // A native alert on both platforms, as the designs draw it (17-filter-sheets/03).
      Alert.alert(
        byPlatform('Add a Photo of Yourself', 'Add a photo of yourself?'),
        `${byPlatform('Find My Photos', 'Find my photos')} searches ${eventName} for your face, using photos of you alone that you add to this event.`,
        [
          { text: byPlatform('Not Now', 'Not now'), style: 'cancel' },
          {
            text: byPlatform('Add Photo', 'Add photo'),
            onPress: () => {
              onClose();
              router.push({ pathname: '/references/[eventId]', params: { eventId } });
            },
          },
        ],
      );
      return;
    }
    onSelectPeople(people?.kind === 'me' ? undefined : { kind: 'me' });
    onClose();
  };

  return (
    <>
      <FindMyPhotosRow
        checking={action === 'checking'}
        selected={people?.kind === 'me'}
        onPress={findMyPhotos}
      />

      <SearchField
        placeholder={byPlatform('Search People', 'Search people')}
        value={search}
        onChangeText={setSearch}
      />

      <View className="gap-2">
        <Text className="font-bodySecondary text-bodySecondary text-accentText">
          {byPlatform("In This Event's Photos", "In this event's photos")}
        </Text>

        {peopleQuery.isPending ? (
          <View className="items-center justify-center py-8">
            <ActivityIndicator className="text-textSecondary" />
          </View>
        ) : peopleQuery.isError && !peopleQuery.data ? (
          <View className="items-center justify-center gap-2 py-8">
            <Text className="font-body text-body text-textSecondary">{"Couldn't load people"}</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => void peopleQuery.refetch()}
              hitSlop={8}>
              <Text className="font-body font-semibold text-accentText">
                {byPlatform('Try Again', 'Try again')}
              </Text>
            </Pressable>
          </View>
        ) : listed.length === 0 ? (
          <View className="items-center justify-center py-8">
            <Text className="text-center font-body text-body text-textSecondary">
              {search ? `No one matches "${search}"` : 'No one has been matched yet'}
            </Text>
          </View>
        ) : (
          <ListCard>
            {listed.map((person, index) => {
              const isSelected = selectedPersonId === person.userId;
              return (
                <ListRow
                  key={person.userId}
                  name={person.fullName}
                  count={person.photoCount}
                  selected={isSelected}
                  last={index === listed.length - 1}
                  onPress={() => {
                    onSelectPeople(
                      isSelected
                        ? undefined
                        : { kind: 'person', userId: person.userId, name: person.fullName },
                    );
                    onClose();
                  }}
                />
              );
            })}
          </ListCard>
        )}
      </View>

      <Text className="font-caption text-caption text-textSecondary">
        Only people matched in the photos show here. To find someone with no name, tap their face in
        a photo.
      </Text>
    </>
  );
}

// Pinned above the People list (spec §2.5.2). iOS draws it as a plain row with a tinted icon,
// Android as a tonal card (17-filter-sheets/01).
function FindMyPhotosRow({
  checking,
  selected,
  onPress,
}: {
  checking: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  const title = byPlatform('Find My Photos', 'Find my photos');
  const subtitle = checking
    ? 'Still checking your photo. Try again in a moment.'
    : 'Every photo of you at this event';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      accessibilityState={{ disabled: checking, selected }}
      onPress={onPress}
      className={`flex-row items-center gap-3 ${
        IOS ? 'px-2 py-2' : 'rounded-3xl bg-accent/20 px-4 py-4'
      }`}>
      <View
        className={`h-11 w-11 items-center justify-center rounded-full ${IOS ? 'bg-accent/20' : ''}`}>
        <Icon name="user" size={22} className="text-accentText" />
      </View>
      <View className="flex-1">
        <Text className="font-body font-semibold text-textPrimary">{title}</Text>
        <Text className="font-bodySecondary text-bodySecondary text-textSecondary">{subtitle}</Text>
      </View>
      {checking ? (
        <ActivityIndicator className="text-textSecondary" />
      ) : selected ? (
        <Icon name="check" size={20} className="text-accentText" />
      ) : (
        <Icon name="chevron-right" size={20} className="text-textSecondary" />
      )}
    </Pressable>
  );
}

function ListCard({ children }: { children: ReactNode }) {
  return (
    <View className="overflow-hidden rounded-2xl border border-border bg-surface">{children}</View>
  );
}

function ListRow({
  name,
  caption,
  count,
  selected,
  last,
  onPress,
}: {
  name: string;
  caption?: string;
  count: number;
  selected: boolean;
  last: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${count} photos`}
      accessibilityState={{ selected }}
      onPress={onPress}
      className={`flex-row items-center justify-between p-3.5 ${
        !last ? 'border-b border-border' : ''
      } ${selected ? 'bg-surfaceElevated' : ''}`}>
      <View className="flex-1 flex-row items-center gap-3">
        <MemberAvatar name={name} size={36} />
        <View className="flex-1">
          <Text className="font-body font-semibold text-textPrimary" numberOfLines={1}>
            {name}
          </Text>
          {caption ? (
            <Text className="font-caption text-caption text-textSecondary">{caption}</Text>
          ) : null}
        </View>
      </View>
      <View className="flex-row items-center gap-2">
        <Text className="font-body text-body text-textSecondary">{count}</Text>
        {selected ? <Icon name="check" size={18} className="text-accentText" /> : null}
      </View>
    </Pressable>
  );
}

function UploadersTab({
  eventId,
  selectedUploaderId,
  onSelect,
  onClose,
}: {
  eventId: string;
  selectedUploaderId?: string;
  onSelect: (uploader: UploaderFilter | undefined) => void;
  onClose: () => void;
}) {
  const uploadersQuery = useUploaders(eventId);
  const [search, setSearch] = useState('');
  const listed = (uploadersQuery.data?.uploaders ?? []).filter((u) => matches(u.fullName, search));

  return (
    <>
      <SearchField placeholder="Search uploaders" value={search} onChangeText={setSearch} />

      <View className="gap-2">
        <Text className="font-bodySecondary text-bodySecondary text-accentText">
          {byPlatform("In This Event's Photos", "In this event's photos")}
        </Text>

        {uploadersQuery.isPending ? (
          <View className="items-center justify-center py-8">
            <ActivityIndicator className="text-textSecondary" />
          </View>
        ) : listed.length === 0 ? (
          <View className="items-center justify-center py-8">
            <Text className="font-body text-body text-textSecondary">
              {search ? `No uploaders match "${search}"` : 'No uploaders yet'}
            </Text>
          </View>
        ) : (
          <ListCard>
            {listed.map((uploader, index) => {
              const isSelected = selectedUploaderId === uploader.userId;
              return (
                <ListRow
                  key={uploader.userId}
                  name={uploader.fullName}
                  caption={uploader.role === 'photographer' ? 'Photographer' : undefined}
                  count={uploader.photoCount}
                  selected={isSelected}
                  last={index === listed.length - 1}
                  onPress={() => {
                    onSelect(
                      isSelected ? undefined : { id: uploader.userId, name: uploader.fullName },
                    );
                    onClose();
                  }}
                />
              );
            })}
          </ListCard>
        )}
      </View>
    </>
  );
}
