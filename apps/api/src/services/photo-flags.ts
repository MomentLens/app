import { z } from 'zod';

import type { FlagPhotoResponse } from '@momentlens/shared-types';

import type { Sql } from '../db/sql';
import { ApiError } from '../middleware/errors';

// Photo flagging (spec §2.5.6, arch:photo_flag, D-179). Active Guests flag published photos for
// the Admin's Review Queue (S-24). flag_photo takes event and media share locks, checks access and
// role, and inserts with ON CONFLICT DO NOTHING so a repeat never duplicates or reopens kept.

export interface FlagPhotoResult {
  outcome: 'not_found' | 'not_member' | 'wrong_role' | 'flagged' | 'already_flagged';
}

export interface PhotoFlagStore {
  flag(mediaId: string, userId: string): Promise<FlagPhotoResult>;
}

const FlagRow = z.object({
  outcome: z.enum(['not_found', 'not_member', 'wrong_role', 'flagged', 'already_flagged']),
});

export function createPhotoFlagStore(sql: Sql): PhotoFlagStore {
  return {
    async flag(mediaId, userId) {
      const rows = await sql`
        select * from public.flag_photo(
          p_media_id => ${mediaId},
          p_user_id => ${userId}
        )`;
      const [first, ...rest] = z.array(FlagRow).parse(rows);
      if (first === undefined || rest.length > 0) {
        throw new Error(`flag_photo returned ${rows.length} rows, expected 1`);
      }
      return first;
    },
  };
}

// POST /media/{mediaId}/flags. `created` is true on the first flag (201) and false on a repeat
// (200), whether the existing flag is open or kept.
export async function flagPhoto(
  store: PhotoFlagStore,
  userId: string,
  mediaId: string,
): Promise<{ created: boolean; answer: FlagPhotoResponse }> {
  const result = await store.flag(mediaId, userId);
  switch (result.outcome) {
    case 'not_found':
      throw new ApiError('not_found', 'No such photo');
    case 'not_member':
      throw new ApiError('not_member', 'Not an active member of this event');
    case 'wrong_role':
      throw new ApiError('wrong_role', 'Only Guests can flag photos');
    case 'flagged':
      return { created: true, answer: { flagged: true } };
    case 'already_flagged':
      return { created: false, answer: { flagged: true } };
  }
}
