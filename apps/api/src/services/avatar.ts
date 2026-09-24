import type { PresignedImage } from '@momentlens/shared-types';

import type { PresignGet } from '../lib/r2';

export interface AvatarOwner {
  userId: string;
  // profile.avatar_key, built by the API's one avatar key function (arch §3)
  avatarKey: string | null;
  // The owner's subject has dnp_activated_at set, which is never cleared (D-31)
  dnpActive: boolean;
}

// The one function that presigns a profile photo, called by every endpoint that returns a person
// (apps/api/CLAUDE.md). Call it only after that endpoint has checked the viewer may see this
// person at all, the audience of profile.full_name (arch §1). This adds the one rule on top.
//
// Under Do Not Publish the photo reaches its owner and nobody else, the Admin included (D-35,
// D-109). The check compares user ids only and takes no role, so no role can be made an exception.
// The app draws a name-initial placeholder for a null.
//
// The cache key is the object key. A replacement photo gets a fresh upload_id in its key (arch §3),
// so an app never shows an old photo from its cache.
export async function presignAvatar(
  owner: AvatarOwner,
  viewerId: string,
  presignGet: PresignGet,
): Promise<PresignedImage | null> {
  if (owner.avatarKey === null) {
    return null;
  }
  if (owner.dnpActive && viewerId !== owner.userId) {
    return null;
  }
  return { url: await presignGet(owner.avatarKey), cacheKey: owner.avatarKey };
}
