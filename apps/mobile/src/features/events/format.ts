import { dayKey } from '@/features/events/time';

// Dates and times as the Events tab and the wizard show them, in the phone's own zone and locale
// (D-110).

const DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
const DAY_YEAR: Intl.DateTimeFormatOptions = { ...DAY, year: 'numeric' };
const WEEKDAY_DAY_YEAR: Intl.DateTimeFormatOptions = { weekday: 'short', ...DAY_YEAR };
const WEEKDAY_DAY: Intl.DateTimeFormatOptions = { weekday: 'short', ...DAY };
const TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

function date(value: Date, options: Intl.DateTimeFormatOptions): string {
  return value.toLocaleDateString(undefined, options);
}

function time(value: Date): string {
  return value.toLocaleTimeString(undefined, TIME);
}

// The last day an end instant belongs to. An end is exclusive (spec §4.3), so an event that ends
// at midnight ends on the day before.
function lastDay(endsAt: Date): Date {
  return new Date(endsAt.getTime() - 1);
}

// An event's span on its card: "Oct 3, 2026", or "Oct 2 – Oct 4, 2026" over several days.
export function formatEventDates(startsAt: Date, endsAt: Date): string {
  const end = lastDay(endsAt);
  if (end.getTime() <= startsAt.getTime() || dayKey(startsAt) === dayKey(end)) {
    return date(startsAt, DAY_YEAR);
  }
  if (startsAt.getFullYear() === end.getFullYear()) {
    return `${date(startsAt, DAY)} – ${date(end, DAY_YEAR)}`;
  }
  return `${date(startsAt, DAY_YEAR)} – ${date(end, DAY_YEAR)}`;
}

// One instant in a date and time field: "Sat, Oct 3, 2026 · 6:00 PM".
export function formatDateTime(value: Date): string {
  return `${date(value, WEEKDAY_DAY_YEAR)} · ${time(value)}`;
}

// A sub-event's times on its card: "Sat, Oct 3, 2026 · 3:00 PM – 6:00 PM", or both days when it
// runs past midnight.
export function formatSubEventTimes(startsAt: Date, endsAt: Date): string {
  if (dayKey(startsAt) === dayKey(lastDay(endsAt))) {
    return `${date(startsAt, WEEKDAY_DAY_YEAR)} · ${time(startsAt)} – ${time(endsAt)}`;
  }
  return `${date(startsAt, WEEKDAY_DAY)} · ${time(startsAt)} – ${date(endsAt, WEEKDAY_DAY)} · ${time(endsAt)}`;
}

// A verification radius: metres below a kilometre, kilometres from there. The slider moves in
// 10 m steps, so a kilometre value keeps two decimals rather than rounding a step away.
export function formatRadius(metres: number): string {
  if (metres < 1000) {
    return `${metres} m`;
  }
  return `${Math.round(metres / 10) / 100} km`;
}
