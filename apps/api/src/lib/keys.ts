// The API's one builder for each family of upload keys (root invariant 12, arch §3). The API writes
// the key it builds onto the row, and whatever serves the file reads it from there. The worker
// builds every derived key; nothing here builds one of those.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Lowercase, because Postgres prints a uuid in lowercase and the row's CHECK compares the key with
// that. Anything but a uuid throws, so no key can climb out of its family with a slash or a "..".
function uuidPart(value: string, name: string): string {
  if (!UUID.test(value)) {
    throw new Error(`${name} must be a uuid to go in an object key`);
  }
  return value.toLowerCase();
}

// events/{event_id}/cover_{upload_id}.jpg. A new upload_id per cover, so a replacement lands at a
// new key and no cache keeps the old image (D-60, D-110).
export function coverKey(eventId: string, uploadId: string): string {
  return `events/${uuidPart(eventId, 'eventId')}/cover_${uuidPart(uploadId, 'uploadId')}.jpg`;
}

// The two keys a media row's upload goes to: {media_id}/upload.jpg for the photo and
// {media_id}/upload_thumb.webp for the client thumbnail. Pre-flight writes both onto the row, and
// everything after reads them from there. The worker's derived keys live beside them under the same
// media id, and the worker builds those (D-70).
export function uploadKeys(mediaId: string): { photo: string; thumbnail: string } {
  const id = uuidPart(mediaId, 'mediaId');
  return { photo: `${id}/upload.jpg`, thumbnail: `${id}/upload_thumb.webp` };
}

// users/{user_id}/avatar_{upload_id}.jpg. The user is always the caller, so nobody can point their
// avatar at another user's file, and profile_avatar_key_check refuses any other folder (arch §3).
export function avatarKey(userId: string, uploadId: string): string {
  return `users/${uuidPart(userId, 'userId')}/avatar_${uuidPart(uploadId, 'uploadId')}.jpg`;
}

// users/{user_id}/events/{event_id}/reference_{upload_id}.jpg (D-141). The upload_id becomes the
// face_reference row's id, which face_reference_photo_key_check compares with the key.
export function referenceKey(userId: string, eventId: string, uploadId: string): string {
  return (
    `users/${uuidPart(userId, 'userId')}/events/${uuidPart(eventId, 'eventId')}` +
    `/reference_${uuidPart(uploadId, 'uploadId')}.jpg`
  );
}
