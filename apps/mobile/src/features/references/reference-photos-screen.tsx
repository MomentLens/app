import { MAX_REFERENCES_PER_EVENT, type Reference } from '@momentlens/shared-types';
import { Image } from 'expo-image';
import { Stack, useRouter, type NativeStackNavigationOptions } from 'expo-router';
import { useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BarIconButton } from '@/components/ui/bar-icon-button';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { GlassButton } from '@/components/ui/glass-button';
import { GLYPH, Glyph } from '@/components/ui/glyph';
import { Row, Section } from '@/components/ui/grouped';
import { Icon } from '@/components/ui/icon';
import { useEvent } from '@/features/event-shell/use-event';
import { useTokenColor } from '@/hooks/use-token-color';
import { AccountChangedError } from '@/lib/api';
import { byPlatform } from '@/lib/copy';
import { choosePhotoSource, pickPhoto, type PhotoSource } from '@/lib/pick-photo';
import { presignedSource } from '@/lib/images';
import { useAuthStore } from '@/stores/auth';
import {
  REJECT_MESSAGE,
  referenceProblem,
  statusLabel,
  summarize,
  type ReferenceAction,
} from './reference-state';
import { addReferencePhoto, removeReferencePhoto, useReferences } from './use-references';

const IOS = Platform.OS === 'ios';
const COLUMNS = 3;
const GAP = 12;
const MARGIN = IOS ? 20 : 16;
const TITLE = byPlatform('Reference Photos', 'Reference photos');

function problemFor(error: unknown, action: ReferenceAction): string {
  return error instanceof AccountChangedError
    ? 'The signed-in account changed. Open this screen again.'
    : referenceProblem(error, action);
}

// The pill at the bottom of a tile, on a dark shade so it reads on any photo.
function Pill({ label, icon }: { label: string; icon?: 'check' }) {
  return (
    <View className="absolute bottom-2.5 left-0 right-0 items-center">
      <View className="min-h-7 flex-row items-center gap-1 rounded-full bg-scrim/45 px-3">
        {icon ? <Icon name={icon} size={14} className="text-onPhoto" /> : null}
        <Text className="font-fieldLabel text-bodySecondary text-onPhoto">{label}</Text>
      </View>
    </View>
  );
}

function Tile({
  reference,
  size,
  deleting,
  onPress,
}: {
  reference: Reference;
  size: number;
  deleting: boolean;
  onPress: () => void;
}) {
  const label = statusLabel(reference);
  const reason = reference.rejectReason ? ` ${REJECT_MESSAGE[reference.rejectReason]}` : '';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Reference photo, ${label}.${reason}`}
      accessibilityHint="Opens Delete"
      accessibilityState={{ busy: deleting || reference.status === 'pending' }}
      disabled={deleting}
      onPress={onPress}
      style={{ width: size, height: size }}
      className="overflow-hidden rounded-3xl bg-surfaceMuted active:opacity-80">
      {/* Cached under the object key, which carries the reference's own id (root invariant 2). */}
      <Image
        source={presignedSource(reference.image)}
        style={{ width: size, height: size }}
        contentFit="cover"
        accessibilityIgnoresInvertColors
      />
      {reference.status === 'pending' || deleting ? (
        <View className="absolute inset-0 items-center justify-center bg-scrim/30">
          <ActivityIndicator className="text-onPhoto" />
        </View>
      ) : null}
      {reference.status === 'rejected' ? (
        <View className="absolute right-2 top-2 h-7 w-7 items-center justify-center rounded-full bg-danger">
          <Icon name="circle-alert" size={18} className="text-onPhoto" />
        </View>
      ) : null}
      <Pill label={label} icon={reference.status === 'accepted' ? 'check' : undefined} />
    </Pressable>
  );
}

function AddTile({ size, busy, onPress }: { size: number; busy: boolean; onPress: () => void }) {
  const ripple = useTokenColor('textPrimary', 0.08);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Add a reference photo"
      accessibilityState={{ busy, disabled: busy }}
      disabled={busy}
      onPress={onPress}
      android_ripple={{ color: ripple }}
      style={{ width: size, height: size }}
      className="items-center justify-center gap-2 overflow-hidden rounded-3xl ios:bg-surfaceMuted ios:active:opacity-80 android:bg-accentTint">
      {busy ? (
        <ActivityIndicator className="text-textSecondary" />
      ) : (
        <>
          <Icon name={IOS ? 'plus' : 'camera'} size={28} className="text-accentText" />
          <Text className="font-h2 text-body text-accentText">Add</Text>
        </>
      )}
    </Pressable>
  );
}

// Reference Photos for one event (spec §4.2, D-141): up to 5 photos of the person alone, each
// checked by the worker for exactly one face (D-91). Only the owner ever sees them. Until S-29
// puts it in Event Preferences, a debug-only button in the Event shell header opens it.
//
// The worker's answer arrives a few seconds after the upload, so the list polls while any photo
// is Checking (use-references.ts). Deleting asks first and offers no Undo. Until S-29 nothing
// stops the last accepted one being deleted, because nobody can turn Do Not Publish on yet (D-172).
export function ReferencePhotosScreen({ eventId }: { eventId: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const owner = useAuthStore((state) => state.userId);
  const event = useEvent(eventId);
  const query = useReferences(eventId);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const text = useTokenColor('textPrimary');
  const background = useTokenColor('background');

  const references = query.data?.references ?? [];
  const summary = summarize(references);
  const size = Math.floor((width - MARGIN * 2 - GAP * (COLUMNS - 1)) / COLUMNS);
  const canAdd = query.isSuccess && summary.canAdd && !adding;
  const eventName = event.data?.event.name;

  async function add(source: PhotoSource) {
    if (owner === null) return;
    setProblem(null);
    let uri: string | null;
    try {
      uri = await pickPhoto(source);
    } catch {
      setProblem('The camera or photo picker could not open. Try again.');
      return;
    }
    if (uri === null) return;
    setAdding(true);
    try {
      await addReferencePhoto(eventId, owner, uri);
    } catch (error) {
      setProblem(problemFor(error, 'add'));
    } finally {
      setAdding(false);
    }
  }

  function startAdd() {
    if (!canAdd) return;
    choosePhotoSource(byPlatform('Add Reference Photo', 'Add reference photo'), (source) => {
      void add(source);
    });
  }

  async function remove(referenceId: string) {
    if (owner === null) return;
    setProblem(null);
    setDeleting((current) => new Set(current).add(referenceId));
    try {
      await removeReferencePhoto(eventId, owner, referenceId);
    } catch (error) {
      setProblem(problemFor(error, 'delete'));
    } finally {
      setDeleting((current) => {
        const next = new Set(current);
        next.delete(referenceId);
        return next;
      });
    }
  }

  function confirmDelete(reference: Reference) {
    const message = reference.rejectReason
      ? REJECT_MESSAGE[reference.rejectReason]
      : 'This photo is removed from this event for good.';
    Alert.alert(byPlatform('Delete Photo?', 'Delete photo?'), message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void remove(reference.id) },
    ]);
  }

  // The bar's + reads the latest handler without rebuilding the native bar on every render.
  const onAdd = useRef(startAdd);
  useLayoutEffect(() => {
    onAdd.current = startAdd;
  });

  // The React Compiler memoizes these, so Stack.Screen sets them on the native bar again only when
  // a colour or canAdd changes.
  const options: NativeStackNavigationOptions = IOS
    ? {
        headerShown: true,
        title: TITLE,
        headerTransparent: true,
        headerShadowVisible: false,
        headerTitleStyle: { color: text },
        headerTintColor: text,
        headerBackButtonDisplayMode: 'minimal',
        contentStyle: { backgroundColor: background },
        unstable_headerRightItems: () => [
          {
            type: 'custom',
            hidesSharedBackground: true,
            element: (
              <GlassButton
                label="Add a reference photo"
                onPress={() => onAdd.current()}
                disabled={!canAdd}>
                <Glyph name={GLYPH.add} size={20} tone="textPrimary" />
              </GlassButton>
            ),
          },
        ],
      }
    : { headerShown: false };

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={options} />
      {IOS ? null : (
        <View style={{ paddingTop: insets.top }}>
          <View className="h-16 flex-row items-center gap-1 pl-1 pr-1">
            <BarIconButton glyph={GLYPH.back} label="Back" onPress={() => router.back()} />
            <Text accessibilityRole="header" className="flex-1 font-h2 text-h2 text-textPrimary">
              {TITLE}
            </Text>
            <BarIconButton
              glyph={GLYPH.add}
              label="Add a reference photo"
              onPress={startAdd}
              disabled={!canAdd}
            />
          </View>
        </View>
      )}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 pb-10 pt-2">
        <Text
          style={{ marginHorizontal: MARGIN }}
          className="font-bodySecondary text-body text-textSecondary">
          {eventName
            ? `Photos of you alone, as you look at ${eventName}. `
            : 'Photos of you alone. '}
          {byPlatform('Find My Photos', 'Find my photos')} and Do Not Publish use them in this event
          only. Only you can see them.
        </Text>

        {query.isPending ? (
          <ActivityIndicator
            className="text-textSecondary"
            accessibilityLabel="Loading your reference photos"
          />
        ) : null}

        {query.isError && !query.data ? (
          <View style={{ marginHorizontal: MARGIN }} className="gap-3">
            <FormMessage message={problemFor(query.error, 'read')} />
            <Button
              label={byPlatform('Try Again', 'Try again')}
              variant="quiet"
              busy={query.isFetching}
              onPress={() => void query.refetch()}
            />
          </View>
        ) : null}

        {query.data ? (
          <>
            <View style={{ marginHorizontal: MARGIN, gap: GAP }} className="flex-row flex-wrap">
              {references.map((reference) => (
                <Tile
                  key={reference.id}
                  reference={reference}
                  size={size}
                  deleting={deleting.has(reference.id)}
                  onPress={() => confirmDelete(reference)}
                />
              ))}
              {summary.canAdd ? <AddTile size={size} busy={adding} onPress={startAdd} /> : null}
            </View>

            {problem ? (
              <View style={{ marginHorizontal: MARGIN }}>
                <FormMessage message={problem} />
              </View>
            ) : null}

            {references.length > 0 ? (
              <Section
                footer={`Up to ${MAX_REFERENCES_PER_EVENT} in this event. Each needs exactly one face.`}>
                <Row
                  leading={<Icon name="check" size={22} className="text-success" />}
                  title={`${summary.ready} ${byPlatform('Ready', 'ready')}`}
                  value={`${summary.counted} of ${MAX_REFERENCES_PER_EVENT}`}
                />
                {summary.checking > 0 ? (
                  <Row
                    leading={<ActivityIndicator className="text-textSecondary" />}
                    title={`${summary.checking} ${byPlatform('Checking', 'checking')}`}
                    subtitle="This takes a few seconds."
                  />
                ) : null}
                {summary.notUsed.map(({ reason, count }) => (
                  <Row
                    key={reason}
                    leading={<Icon name="circle-alert" size={22} className="text-danger" />}
                    title={`${count} ${byPlatform('Not Used', 'not used')}`}
                    subtitle={REJECT_MESSAGE[reason]}
                  />
                ))}
              </Section>
            ) : (
              <Text
                style={{ marginHorizontal: MARGIN }}
                className="px-4 font-caption text-caption text-textSecondary">
                Up to {MAX_REFERENCES_PER_EVENT} in this event. Each needs exactly one face.
              </Text>
            )}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
