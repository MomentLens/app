import type { AlbumStatusResponse, GetEventResponse } from '@momentlens/shared-types';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';

import {
  eventQueryKey,
  recheckEvent,
  retryUnlessRefused,
  useEvent,
} from '@/features/event-shell/use-event';
import { EVENTS_QUERY_KEY, rememberEventChanges } from '@/features/events/use-events';
import { ApiError, getAlbumStatus, setAlbum } from '@/lib/api';
import { byPlatform } from '@/lib/copy';
import { queryClient } from '@/lib/query-client';
import { useAuthStore } from '@/stores/auth';

import { albumProblem, closeAlbumConfirm, type AlbumAction } from './album-state';

export function albumStatusQueryKey(eventId: string) {
  return ['album-status', eventId] as const;
}

async function fetchAlbumStatus(eventId: string, signal?: AbortSignal) {
  try {
    return await getAlbumStatus(eventId, signal);
  } catch (error) {
    // A refusal means the caller's place in the event changed. The shell checks again (hb §5.3).
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      recheckEvent(eventId);
    }
    throw error;
  }
}

// GET /events/{eventId}/album, for the Admin's status card (D-161). It refetches on mount,
// foreground, reconnect and a Realtime change on the event, and is not kept across a restart: the
// count is only worth showing fresh, and the switch reads its state from the event.
export function useAlbumStatus(eventId: string, enabled = true) {
  return useQuery({
    queryKey: albumStatusQueryKey(eventId),
    queryFn: ({ signal }) => fetchAlbumStatus(eventId, signal),
    retry: retryUnlessRefused,
    enabled,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
}

// Shows the PUT's answer at once, in the event, the Events list and the status card. These are
// written copies, so they release no waiting photo (D-161); the refetch that follows does.
function rememberAlbum(eventId: string, albumOpen: boolean): void {
  queryClient.setQueryData<GetEventResponse>(eventQueryKey(eventId), (data) =>
    data ? { ...data, event: { ...data.event, albumOpen } } : data,
  );
  rememberEventChanges(eventId, { albumOpen });
  queryClient.setQueryData<AlbumStatusResponse>(albumStatusQueryKey(eventId), (status) =>
    status ? { ...status, albumOpen } : status,
  );
}

function failure(error: unknown, action: AlbumAction): string {
  if (error instanceof ApiError) return albumProblem(error, action);
  return albumProblem({ status: 500 }, action);
}

// The Open/Close Album switch, the same state from Home's banner, Manage's status card and the
// Admin's "+ Add Media" (spec §2.5.2, §2.5.7, D-161). `open` is the event's state, or the state a
// PUT in flight is setting. Opening needs no confirm. Closing reads the album again first, so the
// confirm names whoever has uploaded nothing at that moment (spec §4.9). The write needs a
// connection and is never queued; a failure leaves the switch where the event says and explains.
export function useAlbumSwitch(eventId: string) {
  const owner = useAuthStore((state) => state.userId);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const live = () => active.current && owner !== null && useAuthStore.getState().userId === owner;
  const event = useEvent(eventId).data?.event;
  const [target, setTarget] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string>();
  const busy = target !== null || checking;

  async function write(open: boolean) {
    if (!live()) return;
    setTarget(open);
    setProblem(undefined);
    try {
      const answer = await setAlbum(eventId, { open }, owner ?? undefined);
      if (!live()) return;
      rememberAlbum(eventId, answer.albumOpen);
    } catch (error) {
      if (!live()) return;
      setProblem(failure(error, open ? 'open' : 'close'));
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        recheckEvent(eventId);
      }
    } finally {
      if (live()) {
        // Either way the event, the list and the card ask again: after a success the event's fetched
        // answer releases this phone's waiting photos, and after a timeout it shows whether the PUT
        // landed (arch §4.3).
        void queryClient.invalidateQueries({ queryKey: eventQueryKey(eventId), exact: true });
        void queryClient.invalidateQueries({ queryKey: EVENTS_QUERY_KEY, exact: true });
        void queryClient.invalidateQueries({ queryKey: albumStatusQueryKey(eventId), exact: true });
        setTarget(null);
      }
    }
  }

  async function confirmClose() {
    if (!live()) return;
    setChecking(true);
    setProblem(undefined);
    let status: AlbumStatusResponse;
    try {
      status = await queryClient.fetchQuery({
        queryKey: albumStatusQueryKey(eventId),
        queryFn: ({ signal }) => fetchAlbumStatus(eventId, signal),
        staleTime: 0,
      });
    } catch (error) {
      if (!live()) return;
      setProblem(failure(error, 'check'));
      return;
    } finally {
      if (live()) setChecking(false);
    }
    if (!live()) return;
    // Another of the Admin's phones closed it already. The event catches up instead.
    if (!status.albumOpen) {
      recheckEvent(eventId);
      return;
    }
    const confirm = closeAlbumConfirm(status.photographersWithoutUploads);
    Alert.alert(confirm.title, confirm.message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: byPlatform('Close Album', 'Close album'),
        style: 'destructive',
        onPress: () => void write(false),
      },
    ]);
  }

  function setOpen(open: boolean) {
    if (busy) return;
    if (open) void write(true);
    else void confirmClose();
  }

  // The Admin's "+ Add Media" while the album is closed asks to open it rather than adding (D-161).
  function askToOpen() {
    if (busy) return;
    Alert.alert(
      'The album is closed',
      'Open it to add photos. Guests and photographers can upload again too.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: byPlatform('Open Album', 'Open album'), onPress: () => void write(true) },
      ],
    );
  }

  return {
    open: target ?? event?.albumOpen ?? false,
    known: event !== undefined,
    busy,
    problem,
    setOpen,
    askToOpen,
  };
}
