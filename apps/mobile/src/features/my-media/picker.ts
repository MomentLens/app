import * as ImagePicker from 'expo-image-picker';

export async function pickMedia(): Promise<ImagePicker.ImagePickerAsset[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 1,
    allowsEditing: false,
    allowsMultipleSelection: true,
    selectionLimit: 50,
    exif: true,
  });
  return result.canceled ? [] : result.assets.slice(0, 50);
}

// EXIF without an offset uses the phone's local time, as D-98 requires. The picker can re-encode
// its file, so keep this timestamp from the returned metadata rather than trusting its copy.
export function pickedCapturedAt(exif: Record<string, unknown> | null | undefined): string | null {
  const raw = exif?.DateTimeOriginal ?? exif?.DateTimeDigitized ?? exif?.DateTime;
  if (typeof raw !== 'string') return null;
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const parts = [year, month, day, hour, minute, second].map(Number);
  const [y, m, d, h, min, sec] = parts as [number, number, number, number, number, number];
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > 31 || h > 23 || min > 59 || sec > 59) return null;
  const utc = new Date(0);
  utc.setUTCFullYear(y, m - 1, d);
  utc.setUTCHours(h, min, sec, 0);
  if (utc.getUTCMonth() !== m - 1 || utc.getUTCDate() !== d) return null;
  const offset = exif?.OffsetTimeOriginal ?? exif?.OffsetTime;
  if (typeof offset === 'string' && /^([+-])(\d{2}):(\d{2})$/.test(offset)) {
    const hours = Number(offset.slice(1, 3)),
      minutes = Number(offset.slice(4, 6));
    if (hours > 23 || minutes > 59) return null;
    const shift = (hours * 60 + minutes) * 60_000 * (offset[0] === '+' ? 1 : -1);
    return new Date(utc.getTime() - shift).toISOString();
  }
  const local = new Date(0);
  local.setFullYear(y, m - 1, d);
  local.setHours(h, min, sec, 0);
  return local.toISOString();
}
