import { describe, expect, it } from '@jest/globals';

import { codeProblem, readInviteInput } from '@/features/join/input';

const TOKEN = 'Ab3_k7-X'.padEnd(43, 'q');

describe('readInviteInput', () => {
  it('reads a pasted invite link as its token', () => {
    expect(readInviteInput(`momentlens://invite/${TOKEN}`)).toEqual({ kind: 'link', token: TOKEN });
  });

  it('finds the link inside a pasted message', () => {
    expect(readInviteInput(`Join us! momentlens://invite/${TOKEN} See you there`)).toEqual({
      kind: 'link',
      token: TOKEN,
    });
  });

  it('does not read a token one character too long as a link', () => {
    expect(readInviteInput(`momentlens://invite/${TOKEN}q`).kind).toBe('code');
  });

  it('uppercases what is typed, one character at a time', () => {
    expect(readInviteInput('ab3')).toEqual({ kind: 'code', code: 'AB3' });
  });

  it('drops the spaces and dashes a shared code may carry', () => {
    expect(readInviteInput(' ab3 k7x ')).toEqual({ kind: 'code', code: 'AB3K7X' });
    expect(readInviteInput('AB3-K7X')).toEqual({ kind: 'code', code: 'AB3K7X' });
  });

  it('ignores a seventh character typed into a full code', () => {
    expect(readInviteInput('AB3K7XQ')).toEqual({ kind: 'code', code: 'AB3K7X' });
  });

  it('picks the one word in a pasted message written as a code', () => {
    expect(readInviteInput('Join Ayesha and Omar with code AB3K7X')).toEqual({
      kind: 'code',
      code: 'AB3K7X',
    });
  });

  it('falls back to the first six characters when a paste has no single code in it', () => {
    expect(readInviteInput('hello there friend')).toEqual({ kind: 'code', code: 'HELLOT' });
  });

  it('reads nothing as an empty code', () => {
    expect(readInviteInput('')).toEqual({ kind: 'code', code: '' });
  });
});

describe('codeProblem', () => {
  it('says nothing about a code that is not finished yet', () => {
    expect(codeProblem('AB3K7')).toBeNull();
  });

  it('accepts six characters from the shortcode alphabet', () => {
    expect(codeProblem('AB3K7X')).toBeNull();
  });

  it.each(['AB3K70', 'AB3K7O', 'AB3K71', 'AB3K7I', 'AB3K7L'])(
    'flags %s, which holds a character no code uses',
    (code) => {
      expect(codeProblem(code)).toMatch(/0, 1, I, L or O/);
    },
  );
});
