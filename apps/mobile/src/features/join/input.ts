import { SHORTCODE_ALPHABET, SHORTCODE_LENGTH, Shortcode } from '@momentlens/shared-types';

// What Manual Join Entry reads from its one field, typed or pasted: an invite link, or a code of
// up to six characters (spec §2.4).
export type InviteInput = { kind: 'link'; token: string } | { kind: 'code'; code: string };

// The token is the last segment of momentlens://invite/{token} (D-101), 43 base64url characters
// (arch:invite). The lookahead refuses a longer run, which is no token.
const LINK = /invite\/([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/;

// A word in a pasted message written the way a code is shared: six uppercase letters and digits.
const WRITTEN_AS_CODE = new RegExp(`^[A-Z0-9]{${SHORTCODE_LENGTH}}$`);

// Reads the field's whole text after every change. A link anywhere in it wins, so a pasted
// WhatsApp message with the link in it works. Anything else becomes the code the boxes show:
// letters and digits only, uppercased, at most six, so a seventh key press changes nothing.
//
// A paste longer than six characters is usually a message around the code. When exactly one word
// in it is six uppercase letters and digits, that word is the code. Otherwise the first six
// characters show, and the person can see what went in and fix it.
export function readInviteInput(text: string): InviteInput {
  const link = LINK.exec(text);
  if (link) {
    return { kind: 'link', token: link[1]! };
  }
  const words = text.split(/[^A-Za-z0-9]+/).filter((word) => word !== '');
  const joined = words.join('');
  if (joined.length <= SHORTCODE_LENGTH) {
    return { kind: 'code', code: joined.toUpperCase() };
  }
  const written = words.filter((word) => WRITTEN_AS_CODE.test(word));
  if (written.length === 1) {
    return { kind: 'code', code: written[0]! };
  }
  return { kind: 'code', code: joined.slice(0, SHORTCODE_LENGTH).toUpperCase() };
}

// The letters and digits that never appear in a code, because they read alike (arch:invite).
const NEVER_USED = [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'].filter(
  (character) => !SHORTCODE_ALPHABET.includes(character),
);

function list(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

// What is wrong with a full code before the API is asked, or null. A code still being typed has
// nothing wrong with it yet. The API would answer 404 for these too; saying why here is kinder.
export function codeProblem(code: string): string | null {
  if (code.length < SHORTCODE_LENGTH || Shortcode.safeParse(code).success) {
    return null;
  }
  return `Invite codes never use ${list(NEVER_USED)}. Check the code and try again.`;
}
