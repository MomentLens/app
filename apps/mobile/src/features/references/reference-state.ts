import {
  MAX_REFERENCES_PER_EVENT,
  type Reference,
  type ReferenceRejectReason,
} from '@momentlens/shared-types';

import { byPlatform } from '@/lib/copy';
import { PhotoUploadError } from '@/lib/photo-upload-error';

// Everything the Reference Photos screen decides from the list, kept free of native modules so
// the rules are tested on their own.

// How often the screen asks again while the worker is still checking a photo. face_reference has
// no Realtime, so the app polls (D-91, root invariant 14). The worker answers within seconds.
export const REFERENCE_POLL_MS = 2000;

// What the worker said, for one tile and for the summary under the grid. Spec §4.2 gives the
// several-faces wording; the other two follow it (D-91, D-172).
export const REJECT_MESSAGE: Record<ReferenceRejectReason, string> = {
  no_face: 'No face detected. Please upload a photo where your face is clearly visible.',
  multiple_faces:
    'Multiple faces detected. Please upload a solo photo where only your face is visible.',
  failed: 'This photo could not be checked. Delete it and add it again.',
};

export interface ReferenceSummary {
  ready: number;
  checking: number;
  // Rejected photos, grouped by reason in the order they first appear.
  notUsed: { reason: ReferenceRejectReason; count: number }[];
  // The ones that count toward the limit of 5: everything not rejected (shared-types reference.ts).
  counted: number;
  canAdd: boolean;
}

export function summarize(references: readonly Reference[]): ReferenceSummary {
  let ready = 0;
  let checking = 0;
  const notUsed = new Map<ReferenceRejectReason, number>();
  for (const reference of references) {
    if (reference.status === 'accepted') ready++;
    else if (reference.status === 'pending') checking++;
    else if (reference.rejectReason !== null) {
      notUsed.set(reference.rejectReason, (notUsed.get(reference.rejectReason) ?? 0) + 1);
    }
  }
  const counted = ready + checking;
  return {
    ready,
    checking,
    notUsed: Array.from(notUsed, ([reason, count]) => ({ reason, count })),
    counted,
    canAdd: counted < MAX_REFERENCES_PER_EVENT,
  };
}

// True while the worker has not decided at least one photo, so the screen keeps asking.
export function isChecking(references: readonly Reference[] | undefined): boolean {
  return references?.some((reference) => reference.status === 'pending') ?? false;
}

// The pill on a tile.
export function statusLabel(reference: Reference): string {
  if (reference.status === 'accepted') return 'Ready';
  if (reference.status === 'pending') return 'Checking';
  return byPlatform('Not Used', 'Not used');
}

// The fields of an ApiError this module reads. Kept structural so the tests need no fetch.
interface ApiErrorLike {
  status?: number;
  code?: string;
}

export type ReferenceAction = 'read' | 'add' | 'delete';

// What to tell the person when a read, an add or a delete fails.
export function referenceProblem(error: unknown, action: ReferenceAction): string {
  if (error instanceof PhotoUploadError) {
    if (error.failure === 'file_missing')
      return 'That photo is no longer on this phone. Pick it again.';
    if (error.failure === 'refused') return 'The upload expired before it finished. Try again.';
    return 'The photo could not be uploaded. Check the connection and try again.';
  }
  const { status, code } = (error ?? {}) as ApiErrorLike;
  if (code === 'too_many_references') {
    return `You already have ${MAX_REFERENCES_PER_EVENT} reference photos in this event. Delete one to add another.`;
  }
  if (code === 'not_member' || status === 403) {
    return 'Only members of this event can keep reference photos here.';
  }
  if (code === 'upload_missing') {
    return 'The photo did not finish uploading. Try again.';
  }
  if (status === 404) {
    return 'This event is no longer available.';
  }
  if (action === 'read') return 'Your reference photos could not be loaded.';
  if (action === 'add') return 'The photo could not be added. Try again.';
  return 'The photo could not be deleted. Try again.';
}
