import type { Request, Response } from 'express';

import { ProfileResponse } from '@momentlens/shared-types';

import type { PresignGet } from '../lib/r2';
import { authenticatedUser } from '../middleware/auth';
import { ApiError } from '../middleware/errors';
import { getOwnProfile } from '../services/profiles';
import type { FindProfile } from '../services/profiles';

// GET /profiles/me. The user comes from the verified token and nothing else, so no request can
// name another user's profile (D-109).
export function getMyProfileController(findProfile: FindProfile, presignGet: PresignGet) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const profile = await getOwnProfile(findProfile, presignGet, id);
    if (profile === null) {
      // The trigger gives every account a profile, so a valid token with none belongs to an
      // account deleted since the token was issued. A 401 sends the app to refresh, Auth rejects
      // the dead account's refresh token, and the app shows Forced Logout (Ukasha, 2026-09-24).
      throw new ApiError('no_session', 'No profile for this account');
    }
    // Parsed before sending, so a stored row the contract rejects is a 500, not a bad body. The
    // avatar URL is signed for this caller, so no cache may keep the response.
    res.set('Cache-Control', 'no-store').json(ProfileResponse.parse(profile));
  };
}
