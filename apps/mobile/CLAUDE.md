# apps/mobile

Expo app, iOS and Android. Root `CLAUDE.md` has the invariants; they apply here too.

Routes live in `src/app/` (Expo Router) and everything else under `src/`. Screens map to spec §2.5. Read it before adding a route.

**Expo SDK 57 docs are at https://docs.expo.dev/versions/v57.0.0/.** Read the page for an Expo package before writing code against it. Training data describes older SDKs.

---

## State goes in exactly one place

| Kind | Tool | Examples |
|---|---|---|
| Server state | TanStack Query | event, album, attendees, schedule |
| Client/UI state | Zustand | active sub-event chip, Public/Local Only toggle, filter sheet state, theme |
| Upload queue | `expo-sqlite` | queued photos, status, retry count |
| Auth | Supabase Auth owns the token; a thin `useAuthStore` mirrors "is someone logged in" | |

**Never copy server data into Zustand "just in case."** That reintroduces exactly the sync bugs TanStack Query exists to prevent.

**The upload queue is neither Zustand nor TanStack Query.** It must survive a force-kill and needs real queries. A thin hook reads it for the My Media banner counts.

**Supabase in the app means Auth and Realtime on `media` and `event`, nothing else** (root invariant 14). Every other read and write goes through the API. A direct table query returns empty rows without an error, which looks exactly like an empty event.

---

## Album and lists

- **FlashList v2, never FlatList.** An album can hit the 2,000-photo cap (spec §4.17). Paginate the TanStack Query behind it too.
- v2 breaking changes: no `estimatedItemSize`, no `MasonryFlashList` (a `masonry` prop now), `FlashListRef<T>` for refs, New Architecture only.
- **Sections are flattened into one array**, not `SectionList`. Mark headers with a `type` field, use `getItemType` to keep recycling pools clean, pass `stickyHeaderIndices`.
- Grid renders 300px thumbnails **center-cropped to square** on purpose: uniform heights mean the list computes content height without measuring.
- **The album query filters on `processed_at IS NOT NULL`** (root invariant 1). An unprocessed photo appears only in the uploader's My Media, with a spinner.

---

## Images

- **Never build an R2 URL.** Ask the API for the photo's image or thumbnail. It decides which file you get and returns a presigned URL (root invariant 3).
- **`expo-image` cache keys must include `variant_version`** (root invariant 2), for thumbnails as much as full images. Without it, a retroactive blur leaves the pre-blur image in local disk cache and the feature silently fails for the people it exists for.
- Presigned URLs live one hour. Do not treat the URL itself as a stable identity.

---

## Client-side upload pipeline (spec §4.8)

One pipeline for every role. There is no role branch; do not reintroduce one.

1. Strip EXIF, keeping only timestamp and orientation
2. HEIC → JPEG
3. Resize **only** if the longest edge exceeds 4096px
4. 300px WebP thumbnail. It shows the unblurred photo, so it goes to R2 and nowhere else (root invariant 13)
5. SHA-256 over the exact bytes about to be uploaded, **not the thumbnail** (root invariant 7). Use `expo-crypto`'s `digest()`; Node's `crypto` does not exist here
6. Pre-flight (JSON, no image bytes) → presigned URLs for the photo and the thumbnail → direct PUT of both to R2 → notify the API

All Stage 1 image work goes through `expo-image-manipulator`, never hand-rolled JS.

Uploads are sequential per session on purpose, so most of a session stays cancelable.

---

## Native modules

`expo-camera` (viewfinder + QR), `expo-image-picker` (+ Add Media only, never in the viewfinder), `expo-image`, `expo-image-manipulator`, `expo-crypto` (upload hash), `expo-location` (foreground reads only, no background APIs), `expo-file-system` (Local Only storage), `expo-sqlite`, `expo-notifications`, `expo-haptics`. Background upload is iOS `beginBackgroundTask` + an Android foreground service.

**The app runs in the development build, not Expo Go.** MMKV, the `momentlens` URL scheme for invite links, remote push and the background upload module all need native code that Expo Go does not ship. `pnpm --filter mobile android` (or `ios` on the Mac) builds it and installs it on the connected phone or emulator, and `pnpm --filter mobile start` then serves JavaScript to it. Rebuild only after adding a package with native code or changing native config in `app.json` (Handbook §10). When a native module fails to load, check whether the installed build predates the package before debugging the code.

---

## Local rules

- **Sentry never sees the screen.** `Sentry.init` in `src/app/_layout.tsx` keeps `sendDefaultPii`, `attachScreenshot` and `attachViewHierarchy` off, and the app has no replay integration. A screenshot, a view hierarchy or a replay sends what is on screen to a third party, and on this app that is photos of faces, including people who turned on Do Not Publish. Never turn one on, not even to debug a crash.
- **Source maps upload only from release builds.** A local debug build uploads nothing and needs no Sentry token. An EAS build uploads them with `SENTRY_AUTH_TOKEN` from its EAS environment. A local release build needs `SENTRY_DISABLE_AUTO_UPLOAD=true` unless that token is set.
- **Styling is NativeWind v4 with tokens from `tailwind.config.js` and `global.css` in this folder**, the only two files allowed a hex value. Never a hardcoded hex in a component; dark mode depends on it. The template's `src/constants/theme.ts` and `src/global.css` predate the tokens and go when S-08 replaces the template screens.
- **`className` works on React Native core components only.** NativeWind maps it on `View`, `Text`, `Pressable` and the rest of `react-native`, and a third-party component such as `SafeAreaView` ignores it. Pass that component `style`, or put the classes on a `View` inside it.
- **`react-native-css-interop` is a direct dependency on purpose.** NativeWind's Babel step imports it from the app's own files, and pnpm's isolated installs hide a package's dependencies from the app. Pin it to the exact version the installed `nativewind` depends on, and bump the two together.
- **Fonts load in `src/app/_layout.tsx` with `useFonts`**, keyed by the family names `tailwind.config.js` uses. A weight added to the type scale goes in both files. Styling, tokens and fonts are JavaScript and assets, so none of them needs a native rebuild.
- **Gestures and animation use Reanimated worklets**, not the JS-driven `Animated` API. This is one of the three places where performance beats simplicity.
- **No `AsyncStorage` patterns.** `react-native-mmkv` for key-value, SQLite for the queue.
- Simulators fake camera and GPS badly. Develop the viewfinder and the verification gate on a real phone, not at the end.
- Types crossing the API boundary come from `packages/shared-types`. Do not redeclare a shape locally.
- Tests go in `__tests__/`, on jest-expo. jest-expo 57 is built on Jest 29, so this package pins Jest 29 while `apps/api` runs 30. Import from `@jest/globals`, and load a module under test with `jest.requireActual` inside `jest.isolateModules`, never a dynamic `import()`. babel-preset-expo leaves `import()` untransformed, and Jest's CommonJS runtime refuses it.

---

## Two pieces of UI that carry real weight

- **The self-visible marker** (spec §4.11): a static lock badge on the photo plus a metadata line, shown when a Do Not Publish user views a photo of themselves. It is the only way they can distinguish "blur is working" from "the match failed and everyone can see me." Static badge, not a positioned box.
- **Do Not Publish is not a toggle** (spec §2.5): row → explanation screen → checkbox → confirm → permanent static "Active" badge. Activation is blocked without a reference image (root invariant 8).
