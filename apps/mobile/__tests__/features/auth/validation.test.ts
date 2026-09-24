import { describe, expect, it } from '@jest/globals';

import { passwordError, signupFieldErrors } from '@/features/auth/validation';

const valid = { name: 'Ayesha Khan', email: 'ayesha@example.com', password: 'eightchr' };

function nameError(name: string) {
  return signupFieldErrors(name, valid.email, valid.password).name;
}

describe('signupFieldErrors', () => {
  it('finds nothing wrong with a complete form', () => {
    expect(signupFieldErrors(valid.name, valid.email, valid.password)).toEqual({
      name: null,
      email: null,
      password: null,
    });
  });

  it('asks for a name that is empty or only whitespace', () => {
    for (const name of ['', '   ', '\t\n', ' 　﻿']) {
      expect(nameError(name)).toBe('Enter your name.');
    }
  });

  // The trigger counts code points (char_length) after trimming, and so does FullName.
  it('accepts 80 code points, emoji included, and any whitespace around them', () => {
    expect(nameError('a'.repeat(80))).toBeNull();
    expect(nameError('😀'.repeat(80))).toBeNull();
    expect(nameError(`  ${'a'.repeat(80)} `)).toBeNull();
  });

  it('refuses 81 code points as too long, not as empty', () => {
    expect(nameError('a'.repeat(81))).toBe('Use 80 characters or fewer.');
    expect(nameError('😀'.repeat(81))).toBe('Use 80 characters or fewer.');
  });

  it('asks for an email that is empty or half typed', () => {
    for (const email of ['', '   ', 'ayesha', 'ayesha@', 'ayesha@example', 'a b@example.com']) {
      expect(signupFieldErrors(valid.name, email, valid.password).email).toBe(
        'Enter your email address.',
      );
    }
  });

  it('accepts an email with whitespace around it, which signup trims', () => {
    expect(signupFieldErrors(valid.name, '  ayesha@example.com ', valid.password).email).toBeNull();
  });

  it('reports every field at once', () => {
    expect(signupFieldErrors(' ', 'x', 'short')).toEqual({
      name: 'Enter your name.',
      email: 'Enter your email address.',
      password: 'Use at least 8 characters.',
    });
  });
});

describe('passwordError', () => {
  it('refuses 7 characters and accepts 8, the minimum both projects set (arch §7)', () => {
    expect(passwordError('')).toBe('Use at least 8 characters.');
    expect(passwordError('1234567')).toBe('Use at least 8 characters.');
    expect(passwordError('12345678')).toBeNull();
  });

  it('does not trim, because Auth counts the spaces too', () => {
    expect(passwordError('        ')).toBeNull();
  });
});
