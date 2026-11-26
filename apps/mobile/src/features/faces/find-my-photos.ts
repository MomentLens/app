import type { Reference } from '@momentlens/shared-types';

// What tapping Find My Photos does, from the caller's reference photos in this event (D-141,
// D-176). Kept free of native modules so the rule is tested on its own.
// - `filter`: at least one accepted reference, so the album filters to the caller's own id.
// - `checking`: none accepted yet and one still `pending`, so the row says it is still checking.
// - `add`: none accepted and none pending, so the app offers S-20's Reference Photos screen.
// - `unknown`: the list has not loaded or failed to. The row filters anyway, since the album is the
//   answer that counts and the API decides what it holds.
export type FindMyPhotosAction = 'filter' | 'checking' | 'add' | 'unknown';

export function findMyPhotosAction(
  references: readonly Reference[] | undefined,
): FindMyPhotosAction {
  if (references === undefined) return 'unknown';
  if (references.some((reference) => reference.status === 'accepted')) return 'filter';
  if (references.some((reference) => reference.status === 'pending')) return 'checking';
  return 'add';
}
