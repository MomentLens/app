// Sub-event times in the phone's own time zone (D-110). Every Date here is built from local parts.
// The platform pickers set the times themselves (D-128); MINUTE_STEP is the custom Delay's step.

export const MINUTE_STEP = 5;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_LENGTH_MS = 3 * HOUR_MS;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The next full hour strictly after `now`.
export function nextFullHour(now: Date): Date {
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return next;
}

// Where a new sub-event starts: where the latest one ends, or at the next full hour for the
// first. It runs three hours until the user changes it.
export function defaultSubEventTimes(
  subEvents: readonly { endsAt: Date }[],
  now: Date,
): { startsAt: Date; endsAt: Date } {
  const latestEnd = Math.max(...subEvents.map((subEvent) => subEvent.endsAt.getTime()));
  const startsAt = Number.isFinite(latestEnd) ? new Date(latestEnd) : nextFullHour(now);
  return { startsAt, endsAt: new Date(startsAt.getTime() + DEFAULT_LENGTH_MS) };
}
