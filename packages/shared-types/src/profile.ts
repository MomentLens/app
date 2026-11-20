import { z } from 'zod';

import { PresignedImage } from './image';

/** The longest name, in code points (D-109). */
export const FULL_NAME_MAX = 80;

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
 *
 * `consentRequired` is true while the caller has no `consent` row for `PRIVACY_POLICY_VERSION`.
 * While it is true the app shows the consent screen before anything else, and on the invite path
 * before Join Confirmation. No other endpoint checks consent (spec §4.18, D-161).
 */
export const ProfileResponse = z.object({
  userId: z.uuid(),
  fullName: FullName,
  avatar: PresignedImage.nullable(),
  consentRequired: z.boolean(),
});
export type ProfileResponse = z.infer<typeof ProfileResponse>;

/**
 * POST /profiles/me/avatar-upload, for any signed-in caller, with no body.
 *
 * The app runs the photo through arch §4.1's Stage 1 (orientation applied, every EXIF field
 * stripped, JPEG at quality 0.9) and PUTs it to `uploadUrl` with `Content-Type: image/jpeg` within
 * 15 minutes, then sends `uploadId` to PUT /profiles/me/avatar (D-172). The API builds the key
 * `users/{user_id}/avatar_{upload_id}.jpg` from the caller and `uploadId`, so the app never sees
 * or sends a key and cannot point its avatar at another user's file (root invariant 12).
 */
export const CreateAvatarUploadResponse = z.object({
  uploadId: z.uuid(),
  uploadUrl: z.url({ protocol: /^https$/ }),
});
export type CreateAvatarUploadResponse = z.infer<typeof CreateAvatarUploadResponse>;

/**
 * PUT /profiles/me/avatar. The API HEADs the object and answers 409 `upload_missing` when it is
 * not in R2, then writes `avatar_key` through `set_avatar`. It writes nothing else: a profile
 * photo is never a reference, gets no face check, creates no subject and queues no job (D-141).
 * A repeat with the same `uploadId` sets the same avatar again.
 */
export const SetAvatarRequest = z.object({
  uploadId: z.uuid(),
});
export type SetAvatarRequest = z.infer<typeof SetAvatarRequest>;

/** PUT /profiles/me/avatar. The new avatar, presigned for the caller. */
export const SetAvatarResponse = z.object({
  avatar: PresignedImage,
});
export type SetAvatarResponse = z.infer<typeof SetAvatarResponse>;
