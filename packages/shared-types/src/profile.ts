import { z } from 'zod';

import { PresignedImage } from './image';

const FULL_NAME_MAX = 80;

/**
 * A person's name as signup sends it in the `full_name` metadata and `profile.full_name` stores
 * it: trimmed, then 1 to 80 characters (D-109).
 *
 * The trigger on `auth.users` enforces the same rule and has to agree with this schema exactly,
 * because a stored name this schema rejects breaks every response that carries it.
 * - It trims what `String.prototype.trim` trims, which is more than the spaces Postgres `btrim`
 *   strips by default: U+0009 to U+000D, U+0020, U+00A0, U+1680, U+2000 to U+200A, U+2028,
 *   U+2029, U+202F, U+205F, U+3000 and U+FEFF.
 * - It counts code points, as `char_length` does. That is why the upper bound is a refine and
 *   not `.max()`, which counts UTF-16 units and would reject an emoji name the database accepts.
 */
export const FullName = z
  .string()
  .trim()
  .min(1)
  .refine((name) => Array.from(name).length <= FULL_NAME_MAX, {
    message: `Too big: expected at most ${FULL_NAME_MAX} characters`,
  });
export type FullName = z.infer<typeof FullName>;

/**
 * GET /profiles/me, the caller's own profile (D-109).
 *
 * `avatar` is null when the caller has no profile photo. The caller always sees their own, Do
 * Not Publish or not, because the owner is the one person a Do Not Publish avatar is shown to.
 */
export const ProfileResponse = z.object({
  userId: z.uuid(),
  fullName: FullName,
  avatar: PresignedImage.nullable(),
});
export type ProfileResponse = z.infer<typeof ProfileResponse>;
