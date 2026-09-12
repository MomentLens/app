# apps/mobile

Expo app, iOS and Android. Root `CLAUDE.md` has the invariants; they apply here too.

Screens map to spec §2.5. Read it before adding a route.

---

## State goes in exactly one place

| Kind | Tool | Examples |
|---|---|---|
| Server state | TanStack Query | event, album, attendees, schedule |
| Client/UI state | Zustand | active sub-event chip, Public/Local Only toggle, filter sheet state, theme |
| Upload queue | `expo-sqlite` | queued photos, status, retry count |
| Auth | Supabase Auth owns the token; a thin `useAuthStore` mirrors "is someone logged in" |

**Never copy server data into Zustand "just in case."** That reintroduces exactly the sync bugs TanStack Query exists to prevent.

**The upload queue is neither Zustand nor TanStack Query.** It must survive a force-kill and needs real queries. A thin hook reads it for the My Media banner counts.

---

## Album and lists

- **FlashList v2, never FlatList.** An album can hit the 2,000-photo cap (spec §4.17). Paginate the TanStack Query behind it too.
- v2 breaking changes: no `estimatedItemSize`, no `MasonryFlashList` (a `masonry` prop now), `FlashListRef<T>` for refs, New Architecture only.
- **Sections are flattened into one array**, not `SectionList`. Mark headers with a `type` field, use `getItemType` to keep recycling pools clean, pass `stickyHeaderIndices`.
- Grid renders 300px thumbnails **center-cropped to square** on purpose: uniform heights mean the list computes content height without measuring.
- **The album query filters on `processed_at IS NOT NULL`** (root invariant 1). An unprocessed photo appears only in the uploader's My Media, with a spinner.

---

## Images

- **Never build an R2 URL.** Ask the API for the photo's image; it decides which file you get and returns a presigned URL (root invariant 3).
- **`expo-image` cache keys must include `variant_version`** (root invariant 2). Without it, a retroactive blur leaves the pre-blur image in local disk cache and the feature silently fails for the people it exists for.
- Presigned URLs live one hour. Do not treat the URL itself as a stable identity.

---

## Client-side upload pipeline (spec §4.8)

One pipeline for every role. There is no role branch; do not reintroduce one.

1. Strip EXIF, keeping only timestamp and orientation
2. HEIC → JPEG
3. Resize **only** if the longest edge exceeds 4096px
4. 300px WebP thumbnail
5. SHA-256 over the exact bytes about to be uploaded, **not the thumbnail** (root invariant 7)
6. Pre-flight → presigned URL → direct PUT to R2 → notify the API

All Stage 1 image work goes through `expo-image-manipulator`, never hand-rolled JS.

Uploads are sequential per session on purpose, so most of a session stays cancelable.

---

## Native modules

`expo-camera` (viewfinder + QR), `expo-image-picker` (+ Add Media only, never in the viewfinder), `expo-image`, `expo-image-manipulator`, `expo-location` (foreground reads only, no background APIs), `expo-file-system` (Local Only storage), `expo-sqlite`, `expo-notifications`, `expo-haptics`. Background upload is iOS `beginBackgroundTask` + an Android foreground service.

---

## Local rules

- **Styling is NativeWind with tokens from `constants/`.** Never a hardcoded hex in a component; dark mode depends on it.
- **Gestures and animation use Reanimated worklets**, not the JS-driven `Animated` API. This is one of the three places where performance beats simplicity.
- **No `AsyncStorage` patterns.** `react-native-mmkv` for key-value, SQLite for the queue.
- Simulators fake camera and GPS badly. Develop the viewfinder and the verification gate on a real phone, not at the end.
- Types crossing the API boundary come from `packages/shared-types`. Do not redeclare a shape locally.

---

## Two pieces of UI that carry real weight

- **The self-visible marker** (spec §4.11): a static lock badge on the photo plus a metadata line, shown when a Do Not Publish user views a photo of themselves. It is the only way they can distinguish "blur is working" from "the match failed and everyone can see me." Static badge, not a positioned box.
- **Do Not Publish is not a toggle** (spec §2.5): row → explanation screen → checkbox → confirm → permanent static "Active" badge. Activation is blocked without a reference image (root invariant 8).
