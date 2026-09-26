import {
  EventDescription,
  EventName,
  MAX_EVENT_SPAN_MS,
  VERIFICATION_RADIUS_MAX_M,
  VERIFICATION_RADIUS_MIN_M,
  type EventType,
} from '@momentlens/shared-types';

import type { DraftVenue } from '@/features/events/draft';

// What the wizard says before it lets the user go on. Each rule is the shared schema's, so the
// app and the API agree on what counts as too long (D-110). These messages reach the user.

function nameProblem(name: string, what: string): string | undefined {
  if (name.trim() === '') {
    return `Enter a name for the ${what}.`;
  }
  return EventName.safeParse(name).success ? undefined : 'Keep the name to 80 characters.';
}

export interface BasicsProblems {
  name?: string;
  type?: string;
  description?: string;
}

export function basicsProblems(basics: {
  name: string;
  type: EventType | null;
  description: string;
}): BasicsProblems {
  const problems: BasicsProblems = {};
  const name = nameProblem(basics.name, 'event');
  if (name) problems.name = name;
  if (basics.type === null) problems.type = 'Choose what kind of event this is.';
  if (!EventDescription.safeParse(basics.description).success) {
    problems.description = 'Keep the description to 500 characters.';
  }
  return problems;
}

// Step 2's one problem, or null when Next can go on. The cap on the count is the sheet's to
// enforce, since the "+" stops at 15.
export function subEventsProblem(
  subEvents: readonly { startsAt: Date; endsAt: Date }[],
): string | null {
  if (subEvents.length === 0) {
    return 'Add at least one sub-event.';
  }
  const first = Math.min(...subEvents.map((subEvent) => subEvent.startsAt.getTime()));
  const last = Math.max(...subEvents.map((subEvent) => subEvent.endsAt.getTime()));
  if (last - first > MAX_EVENT_SPAN_MS) {
    return 'The event runs longer than 14 days, from its first start to its last end.';
  }
  return null;
}

export interface SubEventForm {
  name: string;
  startsAt: Date;
  endsAt: Date;
  venue: DraftVenue | null;
  radiusM: number;
}

export interface SubEventFormProblems {
  name?: string;
  endsAt?: string;
  venue?: string;
  radiusM?: string;
}

// The Add Sub-Event sheet's problems. A start in the past is fine (D-110), and so is an overlap
// with another sub-event (spec §5.3).
export function subEventFormProblems(form: SubEventForm): SubEventFormProblems {
  const problems: SubEventFormProblems = {};
  const name = nameProblem(form.name, 'sub-event');
  if (name) problems.name = name;
  if (form.endsAt.getTime() <= form.startsAt.getTime()) problems.endsAt = 'End after the start.';
  if (form.venue === null) problems.venue = 'Choose where it happens.';
  if (
    !Number.isInteger(form.radiusM) ||
    form.radiusM < VERIFICATION_RADIUS_MIN_M ||
    form.radiusM > VERIFICATION_RADIUS_MAX_M
  ) {
    problems.radiusM = 'Choose a radius from 50 m to 2 km.';
  }
  return problems;
}
