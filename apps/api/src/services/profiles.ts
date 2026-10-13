import { z } from 'zod';

import { PRIVACY_POLICY_VERSION } from '@momentlens/shared-types';
import type {
  AcceptConsentRequest,
  AcceptConsentResponse,
  ProfileResponse,
} from '@momentlens/shared-types';

import type { Supabase } from '../db/supabase';
import type { PresignGet } from '../lib/r2';
import { ApiError } from '../middleware/errors';
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

// What a consent insert did. `repeated` found the row there already. `no_account` is a valid
// token whose account was deleted since it was issued.
export type AcceptConsentResult = 'created' | 'repeated' | 'no_account';

// The consent table, one row per account and policy version accepted (arch:consent, D-161). It
// checks nothing about who asks: every caller passes the user from the verified token.
export interface ConsentStore {
  // Whether this user has a row for exactly this version.
  accepted(userId: string, version: number): Promise<boolean>;
  accept(userId: string, version: number): Promise<AcceptConsentResult>;
}

// Postgres foreign_key_violation on consent.user_id: the caller's account no longer exists.
function isMissingAccount(error: { code?: string; message?: string }): boolean {
  return error.code === '23503' && (error.message ?? '').includes('consent_user_id_fkey');
}

export function createConsentStore(supabase: Supabase): ConsentStore {
  return {
    async accepted(userId, version) {
      // One read by the primary key.
      const { data, error } = await supabase
        .from('consent')
        .select('policy_version')
        .eq('user_id', userId)
        .eq('policy_version', version)
        .maybeSingle();
      if (error) {
        throw error;
      }
      return data !== null;
    },

    async accept(userId, version) {
      // The key makes a second acceptance a conflict, which this insert skips, so a repeat keeps
      // the first row and its accepted_at, and returns no row.
      const { data, error } = await supabase
        .from('consent')
        .upsert(
          { user_id: userId, policy_version: version },
          { onConflict: 'user_id,policy_version', ignoreDuplicates: true },
        )
        .select('policy_version');
      if (error) {
        if (isMissingAccount(error)) {
          return 'no_account';
        }
        throw error;
      }
      const rows = z.array(z.object({ policy_version: z.literal(version) })).parse(data);
      if (rows.length > 1) {
        throw new Error(`The consent insert returned ${rows.length} rows, expected at most 1`);
      }
      return rows.length === 1 ? 'created' : 'repeated';
    },
  };
}

// GET /profiles/me. The caller is the owner, so presignAvatar returns their photo whether or not
// Do Not Publish is active. It still gets the real flag, so this call stays correct if copied
// into an endpoint that returns someone else. consentRequired reads the caller's own row for the
// current version and nobody else's (spec §4.18, D-161).
export async function getOwnProfile(
  findProfile: FindProfile,
  consent: ConsentStore,
  presignGet: PresignGet,
  userId: string,
): Promise<ProfileResponse | null> {
  const [record, accepted] = await Promise.all([
    findProfile(userId),
    consent.accepted(userId, PRIVACY_POLICY_VERSION),
  ]);
  if (record === null) {
    return null;
  }
  return {
    userId: record.userId,
    fullName: record.fullName,
    avatar: await presignAvatar(record, userId, presignGet),
    consentRequired: !accepted,
  };
}

// POST /profiles/me/consent (D-161). The contract has already refused any version but the current
// one. `created` is false for a repeat, which answers as the first call did. Only the app checks
// consent; no other endpoint reads it (spec §4.18).
export async function acceptConsent(
  consent: ConsentStore,
  userId: string,
  request: AcceptConsentRequest,
): Promise<{ created: boolean; response: AcceptConsentResponse }> {
  const result = await consent.accept(userId, request.policyVersion);
  if (result === 'no_account') {
    // As GET /profiles/me does for an account deleted within the token's hour.
    throw new ApiError('no_session', 'No account for this session');
  }
  return {
    created: result === 'created',
    response: { policyVersion: request.policyVersion },
  };
}
