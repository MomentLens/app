import { describe, expect, it } from '@jest/globals';

import type { DraftVenue } from '@/features/events/draft';
import {
  basicsProblems,
  subEventFormProblems,
  subEventsProblem,
} from '@/features/events/validation';

const hall: DraftVenue = { key: 'hall', name: 'Pearl Continental', lat: 31.5546, lng: 74.3572 };

describe('basicsProblems', () => {
  it('has none for a named, typed event', () => {
    expect(basicsProblems({ name: 'Mehndi', type: 'wedding', description: '' })).toEqual({});
  });

  it('needs a name that is not blank once trimmed, and a type', () => {
    expect(basicsProblems({ name: '   ', type: null, description: '' })).toEqual({
      name: 'Enter a name for the event.',
      type: 'Choose what kind of event this is.',
    });
  });

  it('counts an emoji as one character, as the API does, so 80 of them pass and 81 do not', () => {
    const ok = basicsProblems({ name: '🎉'.repeat(80), type: 'other', description: '' });
    const over = basicsProblems({ name: '🎉'.repeat(81), type: 'other', description: '' });
    expect(ok.name).toBeUndefined();
    expect(over.name).toBe('Keep the name to 80 characters.');
  });

  it('keeps a description to 500 characters', () => {
    const over = basicsProblems({ name: 'Walima', type: 'wedding', description: 'a'.repeat(501) });
    expect(over.description).toBe('Keep the description to 500 characters.');
  });
});

describe('subEventsProblem', () => {
  const at = (iso: string) => new Date(iso);

  it('asks for a sub-event when there is none (D-111)', () => {
    expect(subEventsProblem([])).toBe('Add at least one sub-event.');
  });

  it('allows a span of exactly 336 hours and refuses one millisecond more', () => {
    const start = at('2026-10-01T00:00:00.000Z');
    const exact = [{ startsAt: start, endsAt: at('2026-10-15T00:00:00.000Z') }];
    const over = [{ startsAt: start, endsAt: at('2026-10-15T00:00:00.001Z') }];
    expect(subEventsProblem(exact)).toBeNull();
    expect(subEventsProblem(over)).toBe(
      'The event runs longer than 14 days, from its first start to its last end.',
    );
  });

  it('allows overlapping sub-events (spec §5.3)', () => {
    expect(
      subEventsProblem([
        { startsAt: at('2026-10-03T08:00:00.000Z'), endsAt: at('2026-10-03T12:00:00.000Z') },
        { startsAt: at('2026-10-03T10:00:00.000Z'), endsAt: at('2026-10-03T14:00:00.000Z') },
      ]),
    ).toBeNull();
  });
});

describe('subEventFormProblems', () => {
  const form = {
    name: 'Nikkah',
    startsAt: new Date('2026-10-03T08:00:00.000Z'),
    endsAt: new Date('2026-10-03T11:00:00.000Z'),
    venue: hall,
    radiusM: 200,
  };

  it('has none for a complete sub-event', () => {
    expect(subEventFormProblems(form)).toEqual({});
  });

  it('needs a name, a venue, and an end after the start', () => {
    expect(
      subEventFormProblems({ ...form, name: ' ', venue: null, endsAt: form.startsAt }),
    ).toEqual({
      name: 'Enter a name for the sub-event.',
      venue: 'Choose where it happens.',
      endsAt: 'End after the start.',
    });
  });

  it('allows a start in the past (D-110)', () => {
    const past = {
      ...form,
      startsAt: new Date('2020-01-01T08:00:00.000Z'),
      endsAt: new Date('2020-01-01T09:00:00.000Z'),
    };
    expect(subEventFormProblems(past)).toEqual({});
  });

  it('refuses a radius outside 50 to 2000 m or off a whole metre', () => {
    expect(subEventFormProblems({ ...form, radiusM: 49 }).radiusM).toBeDefined();
    expect(subEventFormProblems({ ...form, radiusM: 2001 }).radiusM).toBeDefined();
    expect(subEventFormProblems({ ...form, radiusM: 200.5 }).radiusM).toBeDefined();
    expect(subEventFormProblems({ ...form, radiusM: 50 }).radiusM).toBeUndefined();
    expect(subEventFormProblems({ ...form, radiusM: 2000 }).radiusM).toBeUndefined();
  });
});
