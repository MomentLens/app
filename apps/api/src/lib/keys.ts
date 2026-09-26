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
