import type { Request, Response } from 'express';

import {
  AcceptConsentRequest,
  AcceptConsentResponse,
  ProfileResponse,
} from '@momentlens/shared-types';

import type { PresignGet } from '../lib/r2';
import { authenticatedUser } from '../middleware/auth';
import { parseInput } from '../middleware/body';
import { ApiError } from '../middleware/errors';
import { acceptConsent, getOwnProfile } from '../services/profiles';
import type { ConsentStore, FindProfile } from '../services/profiles';

// GET /profiles/me. The user comes from the verified token and nothing else, so no request can
// name another user's profile (D-109).
export function getMyProfileController(
  findProfile: FindProfile,
  consent: ConsentStore,
  presignGet: PresignGet,
) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const profile = await getOwnProfile(findProfile, consent, presignGet, id);
    if (profile === null) {
      // The trigger gives every new account a profile, the backfill gave one to every live
      // account older than it, and test:rls checks that none is missing. So a valid token with
      // none belongs to an account deleted since the token was issued. A 401 sends the app to
      // refresh, Auth rejects the dead account's refresh token, and the app shows Forced Logout
      // (Ukasha, 2026-09-24). A live account without a profile would instead refresh, get this
      // 401 again, and show a profile that will not load, which is how the backfill was found.
      throw new ApiError('no_session', 'No profile for this account');
    }
    // Parsed before sending, so a stored row the contract rejects is a 500, not a bad body. The
    // avatar URL is signed for this caller, so no cache may keep the response.
    res.set('Cache-Control', 'no-store').json(ProfileResponse.parse(profile));
  };
}

// POST /profiles/me/consent (D-161). 201 when this call recorded the acceptance, 200 when the
// caller had already accepted this version. The user comes from the verified token, and the strict
// body refuses a user id rather than drop it.
export function acceptConsentController(consent: ConsentStore) {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = authenticatedUser(req);
    const request = parseInput(AcceptConsentRequest, req.body);
    const { created, response } = await acceptConsent(consent, id, request);
    res
      .status(created ? 201 : 200)
      .set('Cache-Control', 'no-store')
      .json(AcceptConsentResponse.parse(response));
  };
}
