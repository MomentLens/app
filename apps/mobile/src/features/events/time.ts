// Sub-event times as the wizard's wheels show them: in the phone's own time zone (D-110), on a
// 12-hour clock, with minutes in 5-minute steps. Every Date here is built from local parts, so a
// wheel value always maps back to the instant it was made from.

export const MINUTE_STEP = 5;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_LENGTH_MS = 3 * HOUR_MS;

// How far the day wheel reaches. A sub-event may start in the past (D-110), for an event created
// while it is already running, so the wheel goes back a month.
export const DAYS_BACK = 30;
export const DAYS_AHEAD = 730;

export type Meridiem = 'AM' | 'PM';

export interface WheelParts {
  // A local calendar day, YYYY-MM-DD.
  day: string;
  // 1 to 12.
  hour: number;
  // 0 to 55 in 5-minute steps.
  minute: number;
  meridiem: Meridiem;
}

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

export function toWheelParts(date: Date): WheelParts {
  const hours = date.getHours();
  return {
    day: dayKey(date),
    hour: hours % 12 === 0 ? 12 : hours % 12,
    minute: date.getMinutes() - (date.getMinutes() % MINUTE_STEP),
    meridiem: hours < 12 ? 'AM' : 'PM',
  };
}

export function fromWheelParts({ day, hour, minute, meridiem }: WheelParts): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const hours = (hour % 12) + (meridiem === 'PM' ? 12 : 0);
  return new Date(year, month - 1, date, hours, minute, 0, 0);
}

// The day wheel's rows: `back` days before `around` to `ahead` days after it, plus `include` when
// it falls outside, so a sub-event set long ago still shows its own day.
export function dayKeys(around: Date, back: number, ahead: number, include?: Date): string[] {
  const keys: string[] = [];
  for (let offset = -back; offset <= ahead; offset += 1) {
    keys.push(dayKey(new Date(around.getFullYear(), around.getMonth(), around.getDate() + offset)));
  }
  if (include !== undefined) {
    const extra = dayKey(include);
    if (!keys.includes(extra)) {
      keys.push(extra);
      keys.sort();
    }
  }
  return keys;
}
