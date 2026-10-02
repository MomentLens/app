import { describe, expect, it } from '@jest/globals';

import { formatRadius, formatStartsIn } from '@/features/events/format';
import { describeAddress } from '@/features/events/places';

describe('formatRadius', () => {
  it('shows metres below a kilometre and kilometres from there', () => {
    expect(formatRadius(50)).toBe('50 m');
    expect(formatRadius(990)).toBe('990 m');
    expect(formatRadius(1000)).toBe('1 km');
    expect(formatRadius(1250)).toBe('1.25 km');
    expect(formatRadius(1010)).toBe('1.01 km');
    expect(formatRadius(2000)).toBe('2 km');
  });
});

describe('formatStartsIn', () => {
  const now = new Date(2026, 9, 3, 23, 0);

  it('counts calendar days, so tomorrow morning is Tomorrow late tonight', () => {
    expect(formatStartsIn(new Date(2026, 9, 3, 23, 30), now)).toBe('Today');
    expect(formatStartsIn(new Date(2026, 9, 4, 9, 0), now)).toBe('Tomorrow');
    expect(formatStartsIn(new Date(2026, 9, 8, 9, 0), now)).toBe('In 5 days');
  });

  it('moves to weeks at two weeks and to months at about two months', () => {
    expect(formatStartsIn(new Date(2026, 9, 16), now)).toBe('In 13 days');
    expect(formatStartsIn(new Date(2026, 9, 17), now)).toBe('In 2 weeks');
    expect(formatStartsIn(new Date(2026, 9, 29), now)).toBe('In 3 weeks');
    expect(formatStartsIn(new Date(2026, 11, 12), now)).toBe('In 2 months');
  });

  it('says Today for a start already passed', () => {
    expect(formatStartsIn(new Date(2026, 9, 1), now)).toBe('Today');
  });
});

describe('describeAddress', () => {
  it('uses the place name and an address line built from the parts, each once', () => {
    expect(
      describeAddress(
        {
          name: 'Pearl Continental',
          streetNumber: null,
          street: 'Shahrah-e-Quaid-e-Azam',
          district: 'Mall Road',
          city: 'Lahore',
          region: 'Punjab',
          subregion: null,
          postalCode: null,
          country: 'Pakistan',
          isoCountryCode: 'PK',
          timezone: null,
          formattedAddress: null,
        },
        'Pearl',
      ),
    ).toEqual({
      name: 'Pearl Continental',
      address: 'Shahrah-e-Quaid-e-Azam, Mall Road, Lahore, Punjab, Pakistan',
    });
  });

  it('prefers the formatted address Android gives', () => {
    expect(
      describeAddress(
        {
          name: 'Royal Palm',
          streetNumber: null,
          street: null,
          district: null,
          city: 'Lahore',
          region: null,
          subregion: null,
          postalCode: null,
          country: null,
          isoCountryCode: null,
          timezone: null,
          formattedAddress: '52 Canal Bank Rd, Lahore',
        },
        'palm',
      ).address,
    ).toBe('52 Canal Bank Rd, Lahore');
  });

  it('falls back to the search text when there is no address or its name is a house number', () => {
    expect(describeAddress(undefined, 'Nishat Hotel')).toEqual({
      name: 'Nishat Hotel',
      address: '',
    });
    expect(
      describeAddress(
        {
          name: '12',
          streetNumber: '12',
          street: 'Main Blvd',
          district: null,
          city: 'Lahore',
          region: null,
          subregion: null,
          postalCode: null,
          country: null,
          isoCountryCode: null,
          timezone: null,
          formattedAddress: null,
        },
        'Nishat Hotel',
      ).name,
    ).toBe('Nishat Hotel');
  });
});
