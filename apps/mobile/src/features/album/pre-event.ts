import type { SubEvent } from '@momentlens/shared-types';

// Home's pre-event state and its countdown (spec §2.5.2, D-138, D-148), in the phone's own zone
// (D-110).

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Whether Home still shows the cover: true until the first sub-event starts. The schedule comes
// sorted by start, so the first entry starts first.
export function isPreEvent(subEvents: readonly Pick<SubEvent, 'startsAt'>[], now: Date): boolean {
  const first = subEvents[0];
  return first !== undefined && now.getTime() < Date.parse(first.startsAt);
}

// Local midnights apart. Rounding absorbs the 23 or 25 hour day a clock change makes.
function calendarDays(from: Date, to: Date): number {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  return Math.round((end - start) / DAY_MS);
}

// Counted in calendar days, so a start later today reads in hours and one after midnight reads
// tomorrow, however few hours away it is.
export function countdownText(startsAt: Date, now: Date): string {
  const remaining = startsAt.getTime() - now.getTime();
  if (remaining <= 0) return 'Starting now';
  const days = calendarDays(now, startsAt);
  if (days > 1) return `${days} days to go`;
  if (days === 1) return 'Starts tomorrow';
  const hours = Math.ceil(remaining / HOUR_MS);
  return `Starts in ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

// When countdownText next reads differently: the next local midnight, or on the start's day the
// moment the hour count drops. For useNow, which otherwise moves only at a status change.
export function nextCountdownChange(startsAt: Date, now: Date): Date {
  const remaining = startsAt.getTime() - now.getTime();
  if (remaining <= 0) return startsAt;
  if (calendarDays(now, startsAt) > 0) {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  }
  const hours = Math.ceil(remaining / HOUR_MS);
  return new Date(startsAt.getTime() - (hours - 1) * HOUR_MS);
}
