import {
  currentSubEvent,
  type ErrorCode,
  type MembershipRole,
  type SubEvent,
} from '@momentlens/shared-types';

import { listNames } from '@/features/manage/settings';

// The album's open/closed state, as Home's banner, Manage's status card and My Media's "+ Add
// Media" show it (spec §4.9, D-161). Only the Admin changes it, and only with a connection.

// The Close Album confirm. It names every active Photographer with no finished upload, because
// closing blocks them too, and is a plain confirm when there is none (spec §4.9).
export function closeAlbumConfirm(photographers: readonly string[]): {
  title: string;
  message: string;
} {
  const title = 'Close the album?';
  if (photographers.length === 0) {
    // A photo past pre-flight finishes and publishes; completion does not check the album (D-146).
    return {
      title,
      message:
        'New photos will wait on each phone until you open it again. Photos already uploading still finish.',
    };
  }
  const verb = photographers.length === 1 ? "hasn't" : "haven't";
  return {
    title,
    message: `${listNames(photographers)} ${verb} uploaded any photos. Closing the album will block them from uploading. Close anyway?`,
  };
}

// What "+ Add Media" does. While the album is closed a Guest's and a Photographer's button is
// disabled, and the Admin's asks to open the album instead of adding (D-161). An event not loaded
// yet adds as before: pre-flight refuses a closed album anyway, and the photo waits.
export type AddMediaMode = 'add' | 'disabled' | 'ask-to-open';

export function addMediaMode(
  role: MembershipRole | undefined,
  albumOpen: boolean | undefined,
): AddMediaMode {
  if (albumOpen !== false) return 'add';
  return role === 'admin' ? 'ask-to-open' : 'disabled';
}

// Where the event stands, for the status card's first line: the sub-event In Progress, the next
// one as Upcoming before the first and between two, or the end (spec §2.5.7, D-161).
export type EventMoment =
  | { kind: 'live'; subEvent: SubEvent }
  | { kind: 'next'; subEvent: SubEvent }
  | { kind: 'ended' }
  | { kind: 'unknown' };

export function eventMoment(subEvents: readonly SubEvent[], now: Date): EventMoment {
  if (subEvents.length === 0) return { kind: 'unknown' };
  const live = currentSubEvent(subEvents, now);
  if (live) return { kind: 'live', subEvent: live };
  const next = subEvents
    .filter((sub) => Date.parse(sub.startsAt) > now.getTime())
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0];
  return next ? { kind: 'next', subEvent: next } : { kind: 'ended' };
}

// What failed: opening, closing, or the fresh read the Close Album confirm makes first.
export type AlbumAction = 'open' | 'close' | 'check';

export interface AlbumFailure {
  status?: number;
  code?: ErrorCode;
  // The PUT went out and no answer came, so it may have landed.
  timedOut?: boolean;
}

// What the Admin reads under the switch. The write is never queued, so it says to try again.
export function albumProblem(error: AlbumFailure, action: AlbumAction): string {
  if (error.status === undefined) {
    if (error.timedOut && action !== 'check') {
      return `MomentLens did not answer in time, so the album may or may not have ${action === 'open' ? 'opened' : 'closed'}. It shows the current state once it refreshes.`;
    }
    return `MomentLens could not be reached, so the album is still ${action === 'open' ? 'closed' : 'open'}. Check the connection and try again.`;
  }
  switch (error.code) {
    case 'not_member':
    case 'wrong_role':
      return 'You can no longer change this event.';
    case 'not_found':
      return 'This event is no longer available.';
    default:
      break;
  }
  if (error.status === 401) return 'Your sign-in could not be confirmed. Try again.';
  return 'Something went wrong on our side. Try again in a moment.';
}
