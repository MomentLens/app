import { sha256 } from 'k6/crypto';
import { Counter } from 'k6/metrics';

import { uploadApi } from './api.js';

export const uploadsCompleted = new Counter('uploads_completed');
export const uploadFailures = new Counter('upload_failures');

// The same photo with a JPEG comment segment carrying `nonce`, so each upload has its own
// SHA-256 and pre-flight never answers 409 duplicate (root invariant 7). The segment goes after
// the JFIF header, where every decoder expects optional segments.
export function uniqueJpeg(base, nonce) {
  let at = 2;
  if (base[2] === 0xff && base[3] === 0xe0) at = 4 + ((base[4] << 8) | base[5]);
  const text = `momentlens-loadtest ${nonce}`;
  const segment = new Uint8Array(4 + text.length);
  segment[0] = 0xff;
  segment[1] = 0xfe;
  segment[2] = (text.length + 2) >> 8;
  segment[3] = (text.length + 2) & 0xff;
  for (let i = 0; i < text.length; i += 1) segment[4 + i] = text.charCodeAt(i) & 0x7f;
  const out = new Uint8Array(base.length + segment.length);
  out.set(base.subarray(0, at), 0);
  out.set(segment, at);
  out.set(base.subarray(at), at + segment.length);
  return out.buffer;
}

function code(res) {
  try {
    return res.json().error.code;
  } catch {
    return String(res.status);
  }
}

// One photo the way the upload queue sends it: pre-flight with the hash, both PUTs straight to R2
// with the presigned URLs, then completion. The server's worker then processes it and sets
// processed_at, and Realtime tells every phone in the event.
export function uploadOne({ token, eventId, subEventId, photo, thumbnail, nonce, phase }) {
  const bytes = uniqueJpeg(photo, nonce);
  const pre = uploadApi.preflight(
    token,
    eventId,
    { contentHash: sha256(bytes, 'hex'), subEventId },
    phase,
  );
  if (pre.status !== 201 && pre.status !== 200) {
    uploadFailures.add(1, { phase, step: 'preflight', code: code(pre) });
    return;
  }
  const { mediaId, photoUploadUrl, thumbnailUploadUrl } = pre.json();
  const photoPut = uploadApi.put(photoUploadUrl, bytes, 'image/jpeg', phase);
  if (photoPut.status !== 200) {
    uploadFailures.add(1, { phase, step: 'r2_photo', code: String(photoPut.status) });
    return;
  }
  const thumbPut = uploadApi.put(thumbnailUploadUrl, thumbnail, 'image/webp', phase);
  if (thumbPut.status !== 200) {
    uploadFailures.add(1, { phase, step: 'r2_thumbnail', code: String(thumbPut.status) });
    return;
  }
  const done = uploadApi.complete(token, mediaId, phase);
  if (done.status !== 200) {
    uploadFailures.add(1, { phase, step: 'complete', code: code(done) });
    return;
  }
  uploadsCompleted.add(1, { phase });
}
