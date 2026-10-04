import {
  EventDescription,
  type ApprovalMode,
  type ErrorCode,
  type EventSettings,
  type UpdateEventSettingsRequest,
} from '@momentlens/shared-types';

import type { CoverUploadFailure } from '@/features/events/cover-error';
import { nameProblem } from '@/features/events/validation';

// The Event Settings form's logic, kept free of React so it can be tested (spec §2.5.7, D-142).

// What the Admin has typed or toggled since the form opened. A field left out shows the saved
// value, so a refetch that brings another phone's change shows it in every field not being edited.
export interface SettingsEdits {
  name?: string;
  description?: string;
  approvalMode?: ApprovalMode;
}

export interface ShownSettings {
  name: string;
  description: string;
  approvalMode: ApprovalMode;
}

export function shownSettings(settings: EventSettings, edits: SettingsEdits): ShownSettings {
  return {
    name: edits.name ?? settings.name,
    description: edits.description ?? settings.description ?? '',
    approvalMode: edits.approvalMode ?? settings.approvalMode,
  };
}

// The PATCH body: the fields that differ from what is saved and nothing else, or null when there is
// nothing to send (D-142). The name and description are compared trimmed, as the schema trims them
// before they are stored, and an empty description clears it.
export function settingsPatch(
  settings: EventSettings,
  edits: SettingsEdits,
): UpdateEventSettingsRequest | null {
  const patch: { name?: string; description?: string; approvalMode?: ApprovalMode } = {};
  if (edits.name !== undefined && edits.name.trim() !== settings.name) {
    patch.name = edits.name.trim();
  }
  if (
    edits.description !== undefined &&
    edits.description.trim() !== (settings.description ?? '')
  ) {
    patch.description = edits.description.trim();
  }
  if (edits.approvalMode !== undefined && edits.approvalMode !== settings.approvalMode) {
    patch.approvalMode = edits.approvalMode;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

export interface SettingsProblems {
  name?: string;
  description?: string;
}

// The wizard's rules and messages, from the same shared schema the API parses with (arch:event).
export function settingsProblems(shown: Pick<ShownSettings, 'name' | 'description'>) {
  const problems: SettingsProblems = {};
  const name = nameProblem(shown.name, 'event');
  if (name) problems.name = name;
  if (!EventDescription.safeParse(shown.description).success) {
    problems.description = 'Keep the description to 500 characters.';
  }
  return problems;
}

// "Ali", "Ali and Sara", "Ali, Sara and Bilal". Hermes has no Intl.ListFormat on every build.
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function requests(count: number): string {
  return count === 1 ? '1 request is' : `${count} requests are`;
}

// The line under the Approval Mode switch. `saved` is the event's mode and `shown` the switch's,
// which differ until Save. `photographers` counts the pending Photographers among `pendingCount`.
// A request can wait on an auto event too, when the guest cap left it pending at the switch
// (D-142).
export function approvalNote(
  saved: ApprovalMode,
  shown: ApprovalMode,
  pendingCount: number,
  photographers: number,
) {
  if (shown === 'manual') {
    const base = 'You approve each person before they join.';
    return pendingCount > 0 ? `${base} ${requests(pendingCount)} waiting.` : base;
  }
  const base = 'Anyone with an invite joins straight away.';
  if (saved === 'manual') {
    return pendingCount === 0 ? base : `${base} ${switchNote(pendingCount, photographers)}`;
  }
  if (pendingCount === 0) return `${base} Turn it on to approve each person first.`;
  return `${base} ${requests(pendingCount)} still waiting for you to approve ${pendingCount === 1 ? 'it' : 'them'}.`;
}

// What saving a switch to auto does to the requests waiting now. The guest cap never holds back a
// Photographer, so only Guests wait on the event being full (spec §4.17, D-142).
function switchNote(pendingCount: number, photographers: number): string {
  const guests = pendingCount - photographers;
  const photographersIn =
    photographers === 1 ? 'the Photographer' : `the ${photographers} Photographers`;
  const guestsIn =
    guests === 1
      ? 'the Guest waiting now, unless the event is full'
      : `the ${guests} Guests waiting now, until the event is full`;
  if (guests === 0) return `Saving lets in ${photographersIn} waiting now.`;
  if (photographers === 0) return `Saving lets in ${guestsIn}.`;
  return `Saving lets in ${photographersIn}, and ${guestsIn}.`;
}

// What the confirm before a switch to auto says, or null when nobody is waiting and the switch
// saves without asking (D-142). Each pending Photographer is named, as Approve All names them,
// because a Photographer uploads from anywhere with no check-in (D-139, spec §4.10). Photographers
// are all let in; Guests are let in oldest first until the event holds its cap (spec §4.17).
export function switchMessage(
  pendingCount: number,
  pendingPhotographers: readonly string[],
): string | null {
  if (pendingCount === 0) return null;
  const parts = [
    `${pendingCount === 1 ? '1 person is' : `${pendingCount} people are`} waiting to join.`,
  ];
  const photographers = pendingPhotographers.length;
  if (photographers > 0) {
    parts.push(
      `${listNames(pendingPhotographers)} ${photographers === 1 ? 'joins as a Photographer' : 'join as Photographers'}, who can upload from anywhere without checking in.`,
    );
  }
  const guests = pendingCount - photographers;
  if (guests === 1) {
    parts.push('The Guest joins too, unless the event is already full.');
  } else if (guests > 1) {
    parts.push(
      `The ${guests} Guests join oldest first, until the event is full. Any left over keep waiting.`,
    );
  }
  return parts.join(' ');
}

// What the Admin is told after a switch to auto when the guest cap left requests waiting, or null
// when everyone got in.
export function stillWaitingMessage(admitted: number, pendingCount: number): string | null {
  if (pendingCount === 0) return null;
  const letIn =
    admitted === 0
      ? ''
      : `${admitted === 1 ? '1 request was' : `${admitted} requests were`} let in. `;
  const waiting =
    pendingCount === 1
      ? '1 is still waiting for you to approve it.'
      : `${pendingCount} are still waiting for you to approve them.`;
  return `${letIn}The event is full, so ${waiting}`;
}

// The steps of a Save, in order. `check` reads the settings again before a switch to auto asks its
// question, and writes nothing. `details` is the PATCH, and `cover` the cover's upload after it.
export type SavePart = 'check' | 'details' | 'cover';

// What went wrong, as use-event-settings.ts reads it from the error. `status` is undefined when no
// answer came. `timedOut` says the request went out and its answer never came, so a write may
// have landed. `cover` is set when the cover's PUT to R2 failed, which never reaches the API.
export interface SaveFailure {
  status?: number;
  code?: ErrorCode;
  timedOut?: boolean;
  cover?: CoverUploadFailure;
}

// What the Admin reads when part of a Save fails. An Admin's write is never queued (D-142, D-121),
// so it says to try again.
export function saveProblem(error: SaveFailure, part: SavePart, detailsSaved = false): string {
  const prefix = detailsSaved ? 'Your other changes are saved. ' : '';
  return prefix + reason(error, part);
}

function reason(error: SaveFailure, part: SavePart): string {
  switch (error.cover) {
    case 'file_missing':
      return 'The photo you picked is no longer on this phone. Pick it again.';
    case 'refused':
      return 'The cover did not upload. Try again.';
    case 'unreachable':
      return 'The cover did not upload. Check the connection and try again.';
    case undefined:
      break;
  }
  if (error.status === undefined) {
    // A write that timed out may have landed. The form refetches after any failure, so Save goes
    // off once the refetch shows the change saved.
    if (error.timedOut && part === 'details') {
      return 'MomentLens did not answer in time, so the changes may or may not have saved. If Save is still on once the form refreshes, try again.';
    }
    if (error.timedOut && part === 'cover') {
      return 'MomentLens did not answer in time, so the cover may or may not have saved. Try again.';
    }
    return part === 'cover'
      ? 'The cover did not upload. Check the connection and try again.'
      : 'MomentLens could not be reached, so nothing was saved. Check the connection and try again.';
  }
  switch (error.code) {
    case 'upload_missing':
      return 'The cover did not finish uploading. Try again.';
    case 'not_member':
    case 'wrong_role':
      return 'You can no longer change this event.';
    case 'not_found':
      return 'This event is no longer available.';
    case 'invalid_request':
      return 'MomentLens refused these details. Check each field and try again.';
    default:
      break;
  }
  if (error.status === 401) {
    return 'Your sign-in could not be confirmed. Try again.';
  }
  return 'Something went wrong on our side. Try again in a moment.';
}
