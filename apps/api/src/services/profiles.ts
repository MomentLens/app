import { z } from 'zod';

import type { ProfileResponse } from '@momentlens/shared-types';

import type { Supabase } from '../db/supabase';
import type { PresignGet } from '../lib/r2';
import { presignAvatar } from './avatar';
import type { AvatarOwner } from './avatar';

export interface ProfileRecord extends AvatarOwner {
  fullName: string;
}

// Reads one user's profile and whether their subject has Do Not Publish active. Null when the
// user has no profile row.
export type FindProfile = (userId: string) => Promise<ProfileRecord | null>;

// The rows as selected below. Parsed rather than cast, so a renamed column fails here loudly
// instead of reaching a response as undefined.
const ProfileRow = z.object({ full_name: z.string(), avatar_key: z.string().nullable() });
const SubjectRow = z.object({ dnp_activated_at: z.string().nullable() });

export function createFindProfile(supabase: Supabase): FindProfile {
  return async (userId) => {
    // Two indexed reads by primary key and unique key. profile and subject each reference
    // auth.users, not each other (D-109), so PostgREST cannot embed one in the other.
    const [profile, subject] = await Promise.all([
      supabase.from('profile').select('full_name, avatar_key').eq('user_id', userId).maybeSingle(),
      supabase.from('subject').select('dnp_activated_at').eq('user_id', userId).maybeSingle(),
    ]);
    if (profile.error) {
      throw profile.error;
    }
    if (subject.error) {
      throw subject.error;
    }
    if (profile.data === null) {
      return null;
    }
    const row = ProfileRow.parse(profile.data);
    return {
      userId,
      fullName: row.full_name,
      avatarKey: row.avatar_key,
      // Set once and never cleared (D-31). A user with no subject has never had Do Not Publish.
      dnpActive: subject.data !== null && SubjectRow.parse(subject.data).dnp_activated_at !== null,
    };
  };
}

// GET /profiles/me. The caller is the owner, so presignAvatar returns their photo whether or not
// Do Not Publish is active. It still gets the real flag, so this call stays correct if copied
// into an endpoint that returns someone else.
export async function getOwnProfile(
  findProfile: FindProfile,
  presignGet: PresignGet,
  userId: string,
): Promise<ProfileResponse | null> {
  const record = await findProfile(userId);
  if (record === null) {
    return null;
  }
  return {
    userId: record.userId,
    fullName: record.fullName,
    avatar: await presignAvatar(record, userId, presignGet),
  };
}
