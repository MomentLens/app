import {
  EventDescription,
  type ApprovalMode,
  type ErrorCode,
  type EventSettings,
  type UpdateEventSettingsRequest,
} from '@momentlens/shared-types';

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
// which differ until Save. A request can wait on an auto event too: one the guest cap left pending
// when the event was switched (D-142).
export function approvalNote(saved: ApprovalMode, shown: ApprovalMode, pendingCount: number) {
  if (shown === 'manual') {
    const base = 'You approve each person before they join.';
    return pendingCount > 0 ? `${base} ${requests(pendingCount)} waiting.` : base;
  }
  const base = 'Anyone with an invite joins straight away.';
  if (saved === 'manual') {
    if (pendingCount === 0) return base;
    return pendingCount === 1
      ? `${base} Saving lets in the request waiting now, unless the event is full.`
      : `${base} Saving lets in the ${pendingCount} requests waiting now, until the event is full.`;
  }
  if (pendingCount === 0) return `${base} Turn it on to approve each person first.`;
  return `${base} ${requests(pendingCount)} still waiting for you to approve ${pendingCount === 1 ? 'it' : 'them'}.`;
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

// The two halves of a Save: the PATCH, then the cover's upload once the details are saved.
export type SavePart = 'details' | 'cover';

// What the Admin reads when part of a Save fails. A status of undefined is no answer at all:
// offline, timed out, or the cover's PUT to R2 failing. An Admin's write is never queued (D-142,
// D-121), so it says to try again.
export function saveProblem(
  error: { status?: number; code?: ErrorCode },
  part: SavePart,
  detailsSaved = false,
): string {
  const prefix = detailsSaved ? 'Your other changes are saved. ' : '';
  return prefix + reason(error, part);
}

function reason(error: { status?: number; code?: ErrorCode }, part: SavePart): string {
  if (error.status === undefined) {
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
