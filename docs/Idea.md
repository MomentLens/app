# MomentLens — complete application flow & feature reference
> Event photography & media management platform
> **v11 — scope lock, resolution log applied (React Native / Expo, 3-person team, demo June 2027)**

---

## Table of contents
0. [What changed in v11](#0-what-changed-in-v11)
1. [User roles overview](#1-user-roles-overview)
2. [Complete application flow](#2-complete-application-flow)
   - 2.5 [Navigation & screen architecture](#25-navigation--screen-architecture)
3. [Event lifecycle (end to end)](#3-event-lifecycle-end-to-end)
4. [Complete feature list](#4-complete-feature-list)
5. [Edge cases & exception handling](#5-edge-cases--exception-handling)
6. [Deferred & out of scope](#6-deferred--out-of-scope)
7. [If time allows (stretch goals this FYP)](#7-if-time-allows-stretch-goals-this-fyp)
8. [Known limitations (state these, don't hide them)](#8-known-limitations-state-these-dont-hide-them)
9. [The demo script](#9-the-demo-script)

---

## 0. What changed in v11

v11 applies the resolution log. Two constraints drove most of it, and they belong before the change list because they explain why several v10 decisions cost more than they needed to.

**No real event is ever covered.** Development and the demo run on roughly 100 seeded photos at 1 to 3MB each, under 500MB against a 10GB R2 budget. Storage pressure is not a real constraint, and nothing in this document should be shaped by it.

**The backend runs on an M1 laptop for the demo**, with Supabase and R2 unchanged in the cloud (§4.20). Inference is 3 to 5 times faster than on the free-tier ARM instance, so latency-driven compromises lose most of their value. **Superseded by D-78.** Development and the demo run on one Netcup server, and the M1 is a development machine only.

**Architecture changes**

- **Personalized variants replace the crop overlay.** A photo with N Do Not Publish subjects produces N+1 files: one public file with every subject blurred, and one file per subject with only that subject clear. The `dnp_crop` table, the client overlay, and the authenticated download compositing endpoint are all deleted (§4.11, §4.13).
- **Pinch-zoom is back.** v10 deferred it only to keep the crop overlay welded to the right pixels through a gesture-driven transform. There is no overlay now, so the reason is gone (§2.5).
- **No client-side resize.** Phone JPEGs are already 1 to 3MB. One guard resizes anything over 4096px on the longest edge, and it never fires on a phone photo. This deletes the Photographer branch in the upload pipeline: every role is now handled identically (§4.8).
- **Blur variant object keys carry a version.** Retroactive blur regenerates the public file, and a stable key would leave every client serving the pre-blur image out of its own cache (§4.13).

**Correctness fixes**

- Do Not Publish cannot be activated without at least one reference image. v10 allowed a permanent, irreversible activation that protected nobody, because the pipeline had no vector to match on (§4.2, §4.19).
- No media row is album-visible until processing completes. v10 said this in the §3 lifecycle diagram and not in §4.9, which is what the album gets built from (§4.9).
- Tap-to-blur is available only to users with Do Not Publish active. v10 left this undefined, and the two readings have very different abuse surfaces (§4.11).
- The deduplication hash is computed on the exact byte stream being uploaded, not on a re-encoded thumbnail. WebP encoders differ across platforms and library versions, so the v10 hash was not reproducible and dedup would have caught almost nothing (§4.8).
- Reference sets are split into curated and auto-added. Only curated references feed the manual-blur abuse check, which stops a drifting reference set from degrading the check that depends on it (§4.11).
- Retroactive reprocessing never re-runs face detection. Every face already has a stored embedding (§4.11).
- Blur geometry and blur strength are specified rather than left to whoever writes the worker (§4.11).

**Scope changes**

- **Proxy Blur** added to §6.2 as designed and deferred: a blur subject with a reference embedding but no login account, created by the Admin for someone who never installed the app. Not built. The subject-versus-account split in the schema happens now regardless, because retrofitting it against live rows is a real migration.
- **Manual blur rate limiting** added to §6.2 as designed and deferred.
- **Full-quality download of photographer originals** removed from §6.2. There is one file per photo now, so the entry has nothing left to describe.
- **Pinch-zoom** removed from §6.2 and moved into core.
- The deferred deep link claim in §4.1 is dropped. Firebase Dynamic Links shut down in 2025, the app will not be on any store, and this would never have been tested (§4.1, §9).

**Answered from v10**

The aspect-ratio question v10 left open is settled and needs no further discussion: capture keeps native aspect, the album grid center-crops thumbnails to squares for uniformity across mixed-aspect sources, and full-screen renders native aspect. Masonry stays a one-prop change later, because the worker still writes `width` and `height` onto every media row.

---

## 1. User roles overview

| Role | Who they are | Scope |
|---|---|---|
| **Admin** | Event creator and owner | Full control: event setup, access management, moderation, album management. Also absorbs the moderation duties a separate Moderator role would have handled. |
| **Photographer** | Hired professional contributor | **Write-only.** Uploads land in the shared album and are visible to everyone by default. The *person* is isolated from the event, not their *media*: no album read access, no attendee list, no admin settings. |
| **Guest** | Standard attendee | Capture, upload, and view the full shared album alongside every other Guest and the Admin. |

There is no Videographer role, because there is no video. There is no Moderator role; Admin absorbs it.

---

## 2. Complete application flow

### 2.1 Admin flow

#### 2.1.1 Phase A — account setup
```
1. Download app → Open app
2. "Create Account": name, email, password (Supabase Auth), optional profile photo
3. Accept Terms & Privacy Policy (consent screen, §4.18)
4. Lands on Home Screen → "Events" tab (empty state)
```

#### 2.1.2 Phase B — creating an event
```
5. Tap "+" / "Create New Event"
6. Event Setup Wizard:
   Step 1 — Basic info: name, type, cover photo, description

   Step 2 — Date & venue
   ├── Start / end date & time (sanity-capped at a fixed maximum, §4.17;
   │   no tier selection, no upgrade flow)
   ├── Venue name, GPS (search or map pin)
   └── Verification radius (default 200m, adjustable 50m to 2km)

   Step 3 — Sub-events
   ├── Add up to 15 sub-events: name, date/time, venue (inherit or custom),
   │   description
   └── Auto-ordered by date/time

   Step 4 — Review & confirm

7. Event created → Event Dashboard. The album is closed to uploads by default
   until the Admin explicitly opens it. Always a manual action, never
   scheduled or automatic.
```

#### 2.1.3 Phase C — invitation & venue QR
```
8. Event Dashboard → "Invite" tab. Two role-specific invite links are
   generated automatically:
   ├── Guest Link — joins as Guest
   └── Photographer Link — joins directly as Photographer with the correct
       permissions from the moment they open the app, no manual role change
       needed afterward

   Each is a URL plus its own distinct 6-character shortcode. These are two
   separate codes, not one shared event code. There is no QR image for
   either; they are shared as plain links or codes.

   ⚠ The Photographer Link is sensitive. Anyone holding it can upload to the
   shared album from any location, with no verification gate (§4.5). Both
   links can be revoked and regenerated at any time from this screen.

9. Separately, a Venue Check-In QR is generated per sub-event. This is the
   only QR image the app produces. It is meant to be printed and physically
   posted at that sub-event's venue, and it is the fallback to GPS
   verification (§4.5). Sub-events that inherit the parent event's venue
   share that venue's QR; sub-events with a custom venue get their own.

10. If Approval Mode = "Approve New Users": pending requests queue
    (name, photo, join time) → Approve / Reject / Block, individually or in
    bulk.

11. Manage attendees: searchable list, check-in / verification status, manual
    role change as a fallback, Force Verify, remove from event.
```

#### 2.1.4 Phase D — during the event
```
12. Admin Dashboard shows: upload count, current sub-event and its
    auto-computed status, and album state (Open / Closed).

13. Admin actions, always available:
    ├── Open / close the album (manual, the only mechanism)
    ├── Remove / restore any photo (soft delete, §4.21)
    ├── Promote / demote / remove any user's role
    ├── Force Verify any user from the Attendee list (covers every
    │   sub-event at once)
    ├── Delay a sub-event by any amount of time
    └── Review Queue: flagged photos, and low-confidence blur requests
        (§4.11)

14. Sub-event status updates itself from timestamps (§4.3).
```

#### 2.1.5 Phase E — post-event
```
15. Admin closes the album manually whenever ready. No automatic timing.
16. Download selected photos to the device gallery (multi-select).
17. Delete event (soft delete, §4.21; Guests and Admin notified with a
    download prompt, Photographers receive no notification).
18. Visibility-window expiry notice sent 7 days ahead (§4.21).
```

---

### 2.2 Photographer flow
```
1. Opens the Photographer Link → creates account → joins with Photographer
   permissions immediately. No intermediate Guest state, no waiting on a
   manual role change from Admin.

2. Shoots the event on their own camera gear. The app is not their capture
   tool in practice; it is their delivery tool.

3. At the end of the day, opens My Media → "+ Add Media" → selects photos
   from the device gallery.

4. Uploads through the identical pipeline every other role uses (§4.8): EXIF
   stripped, HEIC converted, no resize. No location verification gate (§4.5),
   because they are typically uploading from home hours after the event.

5. Their photos land in the shared album immediately, visible to every Guest
   and the Admin. No staging, no approval step.

6. They can see only their own uploads, in My Media. They cannot browse the
   album, see other people's photos, see the attendee list, or reach Admin
   settings. The Recognized Faces strip is suppressed on their own photos,
   because it would otherwise name the guest list to someone who is
   restricted from it.
```

This asymmetry is deliberate and should be stated plainly when asked: the *contributor* is isolated from the event, their *media* is not.

---

### 2.3 Guest flow

#### 2.3.1 Phase A — joining
```
1. Opens the Guest Link (or enters the shortcode) → account exists? logs in
   : creates account (banner shown during signup: "Joining [Event Name] as
   Guest", so the reason for signing up is visible before it happens).

2. Join Confirmation screen: cover photo, event name, date range, venue, and
   a role badge ("You're joining as Guest") pulled from which link was used.
   Nothing is created yet; this is a read-only preview. Tapping "Join Event"
   is the actual join action.

3. Per the event's Approval Mode:
   ├── Auto-Approve → joins immediately → Event Home
   └── Approve New Users → Pending Approval screen ("Waiting for the
       organizer to approve your request to join [Event Name]", with a
       Cancel Request option) → Approval Alerts push fires on resolution →
       reopening the app routes straight to Event Home if approved
```

#### 2.3.2 Phase B — pre-event
```
4. Event Home: cover photo, countdown, sub-event list as a simple ordered
   itinerary. Informational only. No RSVP control, no attendance
   confirmation, no reminder notifications.
5. Sub-event detail: name, date/time, venue, "Get Directions."
```

#### 2.3.3 Phase C — event day
```
6. Capturing is never blocked by location. Open the Viewfinder, capture
   freely, with a Public/Local Only toggle per shot and a repeatable
   multi-photo session (§4.7).

7. Exiting the Viewfinder lands on My Media: review, cancel a queued upload,
   or delete an already-uploaded photo.

8. Location verification acts as a gate on uploading, never on capturing.
   While the app is open, it periodically reads GPS and compares it against
   the active sub-event's cached coordinates and radius, on-device. A match
   flips the local queue to ready and the queue starts flushing (§4.5).

9. If GPS fails or is unreliable, the Guest can scan that sub-event's printed
   Venue Check-In QR. This works offline; the scan is recorded locally and
   travels with the next pre-flight request.

10. If neither works, the upload queue banner reads "Ask the organizer to
    verify you." The Admin taps Force Verify once on the Attendee list, and
    that user is verified for every sub-event in the event.

11. Viewing the shared album: every Guest sees the same album everyone else
    does, including the Photographer's uploads.
    ├── Grouped by sub-event / date, filterable by sub-event / face / uploader
    ├── The same grouping and filtering controls Admin has, no scoped-down view
    └── Tap a photo → full-screen single view
```

#### 2.3.4 Phase D — post-event
```
12. Once the Admin closes the album, it remains browsable (view-only) until
    the visibility window ends (§4.21). Multi-select download or individual
    download to the device gallery.
```

---

### 2.4 New user flow
```
1. Opens app with no invite link:
   ├── Login screen with "Join with Invite Link" option
   └── "Create Account" for standalone registration (no event attached)

2. "Join with Invite Link" → Manual Join Entry screen:
   ├── Paste an invite URL, or enter a 6-character invite code manually
   │   (inline validation on the field if the code matches nothing). Guest
   │   and Photographer codes are distinct; the code itself determines the
   │   role, and the user is told which role before they join.
   └── Token resolves →
       ├── Invalid / expired / revoked → Join Error screen
       ├── Valid, and user already belongs to this event → skips straight to
       │   Event Home, no redundant join screen
       └── Valid, new to this event → continues into Phase A of the Guest or
           Photographer flow

3. "Log In" (returning user):
   ├── Email + password → logged in
   └── Lands on Events list (Active / Upcoming / Past tabs)

4. "Create Account" (no event yet):
   ├── Creates profile
   └── Lands on empty home with prompt: "Join an event using an invite link
       or event code"
```

The Scan tab is solely for the Venue Check-In QR verification action in §4.5. It is not a way to join an event; there is no invite QR.

---

### 2.5 Navigation & screen architecture

#### 2.5.1 Two-tier tab bar

The bottom tab bar is not one static set of tabs. It swaps between a **Global shell** (account-level, outside any specific event) and an **Event shell** (after opening a specific event), and the Event shell's tabs differ by role. This mirrors how Discord and Slack keep a persistent workspace rail while the tab set underneath changes. A persistent header (event cover thumbnail, name, and a "‹ Events" back affordance) stays visible the whole time inside an Event shell, specifically to keep the swap from feeling disorienting.

**Global shell** (3 tabs):

| Tab | Purpose |
|---|---|
| Events | Default landing. Active / Upcoming / Past segmented control. "+" in header → Create Event Wizard, visible to everyone, since creating an event is how someone becomes Admin rather than a prerequisite of already being one. |
| Scan | Venue Check-In QR only (§4.5). Works standalone, since the QR payload carries which event and sub-event it verifies. |
| Profile | Avatar → Account Settings (§4.19). |

**Event shell**, tabs by role:

| Role | Tabs |
|---|---|
| Guest | Home · My Media · Schedule |
| Admin | Home · My Media · Schedule · Manage |
| Photographer | My Media (default landing) · Schedule |

There is **no Camera tab**. Camera is a full-screen modal Viewfinder launched via a FAB on My Media, the same pattern as Instagram and Snapchat, where capture suspends the tab bar rather than living in it. A role never sees a tab it structurally cannot use. Photographer never sees Home, rather than seeing it grayed out; a disabled tab invites "why can't I tap this" confusion for no benefit.

#### 2.5.2 Home (event) — merged home + album

Home and Album are one screen, not two, and not per-sub-event folders. Every sub-event's folder would render the identical grid with identical actions, so folder navigation would add a navigation tax without adding distinct functionality. The filtering language below already implies flat-with-filters.

- Collapsing header: cover photo, name, countdown/status, and the album-state banner. Admin's banner includes the Open/Close Album toggle inline, since it is the most time-critical Admin action and shouldn't require a trip to Manage.
- **Sub-event chip row**, always visible directly under the header. "All" by default, auto-scrolled to whichever sub-event is currently In Progress. Past roughly 5 or 6 visible chips, overflow collapses into a "More" bottom sheet, since events can have up to 15 sub-events.
- **Filter icon** (funnel, in the header), deliberately separate from the chip row and not another chip, because it filters a different dimension. Identity, not time. Opens a bottom sheet with **People** (Find My Photos pinned at top, then a searchable list of named attendees; "Unknown" clusters aren't searchable by name here, they're only reachable by tapping a face inside a photo) and **Uploader** (searchable list of contributors, including the Photographer).
- **Active-filter pill** renders above the grid only when a People or Uploader filter is active, with its own "×" to clear. Stacks with an active sub-event chip; the query is an AND of active params, which is cheap and genuinely useful for "Sarah's photos from the reception."
- Grid: virtualized, sticky sub-event section headers, 300px WebP thumbnails center-cropped to square, full display resolution on open.
- Pre-event: grid replaced by the itinerary inline. Post-event: read-only, capture disabled, download surfaced in the header.

#### 2.5.3 My media

- **Sectioned by sub-event**, the same visual pattern as the Home grid (sticky header with numeral, sub-event name, date/venue subtitle, item count). Capture-time auto-tagging (§4.7) attaches the correct sub-event at the moment of capture, so the section a photo lands in is already correct data; the sectioning just makes that data visible.
- **"+ Add Media" control per section header**, a pill-shaped button right-aligned next to the section's item count. Opens the device image picker **only**, scoped to add existing photos into that specific sub-event. It never opens the camera. Selected photos go through the same upload pipeline as camera captures. For Photographers, this is the primary and effectively only path into the app.
- Per-thumbnail status badges: clock = queued or gated, spinner = uploading, check = uploaded, lock = Local Only. Optional All / Queued / Uploaded / Local segment control for narrowing on top of the sections.
- Upload queue banner, non-permanent chrome that renders only when the queue is non-empty: "X waiting for verification · Y uploading," collapsible, with a one-tap "Scan Venue QR" shortcut deep-linking to the Scan tab and, if the user has been waiting on verification, the line "Ask the organizer to verify you."

#### 2.5.4 Camera FAB & viewfinder

- FAB (camera icon, bottom-right) renders on My Media for Guest and Admin. Photographers see it too; the pipeline is identical, they simply rarely use it.
- **The FAB is hidden when no sub-event is currently In Progress.** There is no capture path that can produce an ambiguous-sub-event photo. With the extended status rule in §4.3, a sub-event stays In Progress until the next one begins, so this window is genuinely "outside the event," not "between two sessions that ran late."
- Tapping the FAB opens the Viewfinder as a full-screen modal, hiding the tab bar, and drops straight into the currently live sub-event's capture context. No sub-event picker at capture time.
- Viewfinder components: live preview at the camera's native aspect ratio with no forced crop, front/back flip icon (bottom-right), Public / Local Only toggle (top, changeable mid-session), large shutter button, running thumbnail strip of the current session, capture counter. No lens zoom control (§7) and no gallery picker; gallery access is exclusively the "+ Add Media" button per sub-event section in My Media. Exit (X) dismisses the modal and lands on My Media, with new captures appearing at the top of the relevant section immediately via optimistic UI.

#### 2.5.5 Schedule

One list component reused for every role, permission-gated rather than forked: ordered sub-events with an auto-computed status badge (Upcoming / In Progress / Completed). Admin-only inline "Delay" action per row. Tap a row → Sub-event Detail (name, date/time, venue, "Get Directions," "View photos from this session" → Home, pre-filtered to that sub-event's chip).

#### 2.5.6 Single photo view

Full-screen swipeable pager. Tap toggles the metadata overlay (capture time, sub-event, uploader). **Pinch-zoom and pan are supported.** They were deferred in v10 solely to keep the personalized-blur crop overlay welded to the correct pixels through a gesture-driven transform; §4.11 removed the overlay, so this is now an ordinary image viewer with no privacy coupling at all.

- **Recognized Faces strip**: named where matched to a registered user, "Unknown" where not, still individually clustered and tappable. Tapping a face returns to Home filtered to that person, reusing the active-filter-pill mechanism rather than pushing a new screen.
- **Blur info icon (ⓘ)** next to any blurred face surfaces the §4.18 transparency notice: "This person has requested privacy."
- **Self-visible marker.** When you are viewing a photo you appear in and you have Do Not Publish active, a small lock badge renders on the image and the metadata overlay reads "Your face here is visible only to you." This is not decoration. It is the only way you can tell the difference between "personalized blur is working" and "the match failed and everyone can see me" (§4.11). It is a static badge on the photo rather than a positioned box, so it cannot drift out of alignment under zoom.
- **Tap-your-own-face-to-blur.** Available only to users with Do Not Publish active (§4.11). If your face appears with no self-visible marker, tapping it opens a confirm sheet: "Blur my face in this photo." Users without Do Not Publish never see this affordance, because they have nothing to correct.
- Action bar: Download / Share / Flag / Delete, present or absent per role and photo ownership. Suppressed for Photographers on their own photos except Delete.

#### 2.5.7 Manage (admin only)

Grouped hub screen, iOS-Settings-style list of rows each linking to its own sub-screen, not one long page:

- **Live status card** (top): upload count, current sub-event and status, Open/Close Album toggle (mirrors the Home banner, same state, two entry points).
- **Pending Approvals**, kept structurally separate from the Review Queue below. Different data, different actions, not one "moderation" bucket. Row per join requester (photo, name, role they're joining as, determined by which link they used), Approve/Reject per row, multi-select plus bulk action bar.
- **Review Queue**, two sections in one screen:
  - *Flagged photos* (Guest-flagged). Thumbnail grid, each card showing sub-event, uploader, flagged time. Tap → Single Photo View with a moderation action bar: Keep / Remove.
  - *Blur requests* (low-confidence manual self-blur, §4.11). The face is **already blurred** while it sits here. Actions are Confirm / Revert, not Approve / Reject, because the privacy-preserving state is the default and the Admin's job is only to undo abuse.
- **Attendees**: search, filter by role and verification status, row → detail sheet (Change Role, Force Verify, Remove from Event, Block).
- **Invite**: Guest Link and Photographer Link cards (shortcode prominent, URL secondary, Copy, Share, Revoke & Regenerate), plus the Venue QRs (preview per sub-event, "Download for printing," regenerate).
- **Sub-events**: deep-links into the Schedule tab rather than duplicating it, since Admin's Delay affordance already lives there.
- **Event Settings**: edit form (name, description, cover, dates, venue, verification radius, Approval Mode) with a visually separated Danger Zone (Delete / Archive) and a required confirm dialog.

#### 2.5.8 Screens formalized in this pass

| Screen | Trigger | Notes |
|---|---|---|
| Join Confirmation | Valid invite token, new to event | Read-only preview before the join action fires; shows the role being joined as. |
| Pending Approval | Approval Mode = manual | A waiting state, not a spinner. Has a Cancel Request option. |
| Join Error | Expired or revoked token | Reserved for dead tokens. A mistyped shortcode gets inline field validation on Manual Join Entry instead. |
| Forced Logout / Access Removed | Role revoked or account suspended mid-session (§4.1) | Prevents a silent bounce to Login reading as a bug. States what changed if a reason code is cheaply available. |
| Consent re-gate | Privacy Policy version bump (§4.18) | Blocking full-screen re-consent on next launch, before anything else renders. |
| Supabase unavailable | Keep-alive ping missed the auto-pause window | Needs a retry action, not a dead end. |

#### 2.5.9 Account settings (global, §4.19)

Reachable from the Profile tab and, redundantly, from an avatar icon in the Event shell header. These are account-wide, not event-specific, so they aren't duplicated per event. Grouped list matching §4.19 exactly, with one deliberate exception in how Privacy renders.

**Do Not Publish is not a toggle, and it has a precondition.** Activation is blocked unless the user has at least one reference photo or a profile photo (§4.2); without a reference embedding the pipeline has nothing to match on, so the activation would be permanent, irreversible, and protective of nobody. If the user has neither, the screen says so and the confirm button stays disabled with a link to add reference photos. Otherwise: a plain switch implies reversibility this action doesn't have, so the row shows current state ("Off"), tapping opens a full explanation screen stating plainly that the blur applies to every other viewer with no exceptions, that it applies retroactively via asynchronous reprocessing, and that it cannot be reversed by anyone, ever. A checkbox, "I understand this is permanent," gates the confirm button. Once active, the Settings row changes shape: no chevron, no tap target implying "off" exists, just a static "Active" badge, so the row's own affordance reflects that there is nothing left to toggle rather than relying on someone remembering a warning screen they saw once.

#### 2.5.10 Notification deep-links

Push-only. There is no in-app history screen; §6.2 defers a Notification Center.

| Channel | Guest / Photographer target | Admin target |
|---|---|---|
| Approval Alerts | Info only, no queue to view | Manage → Pending Approvals |
| Album Lifecycle | Home | Home |

A lightweight substitute for a full history: event cards on the global Events list carry a "new since last visit" dot, comparing a stored `lastViewedAt` against latest activity. This recovers most of what a notification center would have provided without rebuilding the feature that was cut.

---

## 3. Event lifecycle (end to end)
<!-- abstract: One event walked from creation through invitation, the event day, upload and processing, to the post-event album and retention windows. -->

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  [1] CREATION                                                               │
│      Admin creates event within the fixed duration cap → up to 15           │
│      sub-events → generates Guest Link + Photographer Link → generates      │
│      per-sub-event Venue Check-In QRs for physical posting                  │
│                          ↓                                                  │
│  [2] INVITATION                                                             │
│      Links and shortcodes shared directly (no QR image) → Guests and        │
│      Photographers join with the correct role from the start → auto-join    │
│      or await approval                                                      │
│                          ↓                                                  │
│  [3] PRE-EVENT                                                              │
│      Attendees browse the itinerary. Informational only, no RSVP            │
│                          ↓                                                  │
│  [4] EVENT DAY (per sub-event loop), album opened by Admin                  │
│      Sub-event status flips automatically → Guest captures freely via the   │
│      Viewfinder → photos queue locally until the device verifies location   │
│      on-device or the Guest scans the Venue QR → queue flushes: EXIF        │
│      stripped, HEIC converted, no resize → uploads sequentially, cancelable │
│      in My Media → pre-flight (SHA-256 dedup + server-side verification)    │
│      → direct to R2 via presigned URL → pgmq job → FastAPI worker (detect,  │
│      embed, write public + per-subject variants) → processed_at is set and  │
│      the row becomes album-visible → Realtime updates every device          │
│                          ↓                                                  │
│  [5] PHOTOGRAPHER DELIVERY (typically post-event, often the same night)     │
│      Photographer uploads through the identical pipeline, exempt only from  │
│      the location gate → photos land in the same shared album, visible to   │
│      everyone                                                               │
│                          ↓                                                  │
│  [6] EVENT CLOSE — Admin manually closes the album, no automatic timing     │
│                          ↓                                                  │
│  [7] POST-EVENT — multi-select or individual download to device gallery     │
│                          ↓                                                  │
│  [8] ARCHIVE / EXPIRY — visibility window closes → recoverable grace        │
│      period → permanent deletion only after that passes (§4.21)             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Complete feature list

### 4.1 Authentication & onboarding
- Email address and password registration via Supabase Auth. No OTP, no biometric.
- Deep link handling: an invite URL auto-opens the app **if the app is already installed**. There is no deferred deep link and no install-then-resume path. Firebase Dynamic Links shut down in 2025, the replacements are third-party services, and this app will not be on either store, so the feature could never be tested and is not claimed. A user without the app installs the build first, then opens the link or pastes the shortcode (§9 covers how this works on demo day).
- Short invite code entry (6-character alphanumeric) as a manual alternative. Guest and Photographer codes are distinct values.
- "Join with Invite Link" flow: a user with a code but no account is guided through registration and then dropped directly into the event.
- Login: email and password. Password reset via a recovery link, handled natively by Supabase Auth.
- Session management with configurable token expiry via Supabase.
- Forced logout on role revocation or account suspension, surfacing the Forced Logout / Access Removed screen (§2.5) rather than a silent bounce to Login.
- Multi-device login (the same account active on a tablet and phone simultaneously). The upload queue is stored in device-local SQLite and is therefore per-device: photos queued on a phone do not appear on a tablet.

---

### 4.2 User profile
- Full name and profile photo. No bio field (§6.1).
- Email address as the primary identifier.
- **Reference photos are separate from the profile photo.** A user may upload up to 5 reference photos of themselves for a stronger multi-angle reference embedding, and may do so without ever setting a profile photo. If a profile photo exists, it is also used as a reference. Both count as **curated** references; §4.11 explains why curated and auto-added references are tracked separately. This distinction matters for Find My Photos, for blur accuracy, and for the manual-blur abuse check (§4.11).
- **At least one reference image is required to activate Do Not Publish.** A user with no reference photos and no profile photo cannot enable it. The pipeline matches against reference embeddings, so activating without one is a permanent, irreversible action that protects nobody while the Settings row reads "Active" (§4.19).
- **Do Not Publish privacy flag.** Once enabled, this user's faces in uploaded photos are blurred for every other viewer, and their profile photo is replaced by a name-initial placeholder everywhere in the app, with **no exception for anyone, including the Admin**. Their *name* still appears where it is functionally required (Pending Approvals, Attendees list), because an Admin cannot approve a join request from an anonymous row. The image is what is hidden, not the identity.
- Profile photo can be updated at any time. Updating it does not retroactively change an already-active Do Not Publish reference set; use the reference photos for that.
- Account deletion is handled by contacting the team directly rather than a self-service flow. The full "My Data" dashboard is Future Work.

---

### 4.3 Event management
- Create event: name, type, cover photo, description.
- Date range capped at a fixed maximum (§4.17). No per-event tier selection.
- Up to 15 sub-events, auto-ordered by date/time.
- Verification radius configurable from 50m to 2km, default 200m.
- Album state (open / closed) is always a manual Admin action.
- Two role-specific invite links per event (Guest, Photographer), each a URL plus its own 6-character shortcode. No QR image. Both are revocable and regenerable.
- One Venue Check-In QR per sub-event. Sub-events inheriting the parent venue share that venue's QR.
- Admin can delay a sub-event by any amount of time.
- Delete event (soft delete, §4.21), archive event.

**Sub-event status, computed from timestamps:**

| Status | Rule |
|---|---|
| Upcoming | Now is before the sub-event's start time |
| **In Progress** | Now is after its start time, **and** the next sub-event has not started, **and** the parent event has not ended |
| Completed | The next sub-event has started, or the parent event has ended |

The In Progress rule deliberately ignores the sub-event's own scheduled *end* time. Real events run late, and a sub-event auto-completing on schedule while people are still in the room would hide the capture FAB (§2.5) during the part of the night everyone is photographing. A sub-event now ends when the next one begins, not when the calendar said it should. If sub-event schedules overlap because the Admin set them that way, capture tags to the most recently started one.

---

### 4.4 Invitation & access control
- **Guest Link** and **Photographer Link**, each a distinct token carrying its own role assignment, so joining via a given link grants that role immediately with no separate role-change step.
- Manual role change remains available on the Attendees screen as a fallback, for someone who joined via the wrong link.
- Approval Modes: Auto-Approve All, or Approve New Users (manual review).
- Pending queue, bulk approve/reject, per-user block, revoke access at any time.
- Attendee list: searchable, filterable by role and verification status.
- **There is no role-based media visibility rule.** All uploaded photos are visible to all event members regardless of the uploader's role. A role change therefore has no retroactive effect on any existing photo, and none of the snapshot-versus-live-role machinery from earlier versions of this spec is needed. `uploader_role_at_upload` is retained purely as a display and filtering field. It routes nothing: §4.8 removed the role branch in the upload pipeline, so there is no quality tier left for it to select. It is not an access-control field either.

---

### 4.5 Location verification & attendance

This system is a **gate on uploading**, applied to the *person*, not the *photo*. It never blocks capture.

- **Granularity: per sub-event.** A verification record is scoped to one user and one sub-event. Verifying at the mehndi does not verify you for the nikkah.
- **The queue gate.** If a user is not verified for the sub-event a photo is tagged to, that photo sits in the local SQLite queue and does not upload.
- **On-device GPS check.** While the app is open, it periodically reads GPS and compares it against the active sub-event's cached coordinates and radius **locally**, without needing the network. A match flips the local queue to ready. Wedding venue connectivity is unreliable enough that requiring a round-trip before a guest can even start queueing would fail most of the time.
- **The server records, the client does not decide.** The client's local check is optimistic. Each queued photo carries the GPS reading taken at its capture time, and the pre-flight request (§4.8) submits that reading. The server re-validates it against the sub-event's stored coordinates and writes the `VenueVerification` row. A tampered client can bypass the local gate, but it cannot manufacture a server-side verification record.
- **Venue Check-In QR override.** If GPS is unreliable indoors, a Guest scans the printed QR for that sub-event. **This works offline**: the scanned payload is written to local SQLite and travels with the next pre-flight request when connectivity returns. Nothing is pre-cached; you cannot hold the secret of a QR you have not scanned.
- **Admin override.** Force Verify on the Attendee list sets `admin_verified_at` on that user's membership row. The pre-flight check is `(a VenueVerification row exists for this user and sub-event) OR (admin_verified_at IS NOT NULL)`, so one tap covers every sub-event in the event, past and future. This is deliberately blunt: the Admin should be able to say "this person is fine, stop asking" once, not per session.
- **Photographers are exempt from the gate entirely.** They upload from home, hours after the event, by design (§2.2). A role-linked invite already establishes who they are. Requiring the Admin to remember a Force Verify tap at 2am in order to receive his own wedding photos is a worse trade than the risk this gate mitigates.

---

### 4.6 Event schedule
- A simple, informational, ordered list of sub-events: name, date/time, venue, "Get Directions."
- No RSVP, no attendance confirmation, no reminder notifications.
- Admin can delay a sub-event by any amount.

---

### 4.7 Media capture (viewfinder)
- A custom in-app camera Viewfinder, not the OS native camera. Full-screen live preview.
- **Native aspect ratio.** Capture is not cropped to any fixed ratio; the photo keeps whatever the device sensor produces, and the preview matches the capture bounds so what is framed is what is captured.
- Public / Local Only toggle always visible, setting the mode for the next capture, changeable at any point mid-session.
- Tap to capture, repeatable. A single Viewfinder session can capture multiple photos in a row without leaving the screen, building a running thumbnail strip.
- **No gallery picker in the Viewfinder.** Adding existing photos is done exclusively via "+ Add Media" per sub-event section in My Media (§2.5).
- Exiting always lands on My Media for review.
- No caption field anywhere in the capture flow (§6.1).
- Sub-event tagging is automatic: a capture tags to whichever sub-event is In Progress per §4.3. Overlapping sub-events tag to the most recently started one.
- **The FAB is hidden when no sub-event is In Progress**, so there is no capture path that can produce an ambiguous-sub-event photo. This gate is on *time*, not on verification; an unverified user can still capture freely, their photos simply queue (§4.5).
- **Photo only. There is no video capture mode.**

---

### 4.8 Upload pipeline

#### 4.8.1 Stage 1 — client-side processing

**One pipeline for every role.** v10 branched on role to skip the resize for Photographers. With the resize gone there is nothing left to branch on, so Guest, Admin and Photographer uploads receive byte-identical treatment.

- Retain only timestamp and orientation in EXIF; strip everything else, including GPS.
- Convert HEIC/HEIF to JPEG.
- **No resize, with one guard.** Phone JPEGs are already 1 to 3MB and do not need shrinking; modern JPEG compression is good enough that the resize was solving a problem this project does not have. If the longest edge exceeds **4096px**, resize to 4096px preserving native aspect. This never fires on a phone photo. It exists so a DSLR file dragged in during a rehearsal does not surprise anyone.
- Generate a 300px WebP thumbnail for the album grid. It is made from the unblurred photo, so it is served only for photos with no Do Not Publish face; the worker writes blurred thumbnails for the rest (§4.13, D-69).
- Compute a **SHA-256 hash of the exact byte stream about to be uploaded**, after EXIF stripping and HEIC conversion. v10 hashed the re-encoded 300px thumbnail, which is not reproducible: WebP encoders differ across iOS, Android and library versions, so the same photo would hash differently on two devices and deduplication would have caught almost nothing.

#### 4.8.2 Stage 2 — pre-flight
- A single small JSON round-trip: content hash, sub-event ID, and the GPS reading captured with the photo. There is no album id; media belongs to an event through its sub-event (`docs/ARCHITECTURE.md` §2). No image bytes travel in it, the thumbnail included (D-69).
- **Exact duplicate** (identical SHA-256) is silently rejected, with no upload and no user-facing prompt. This is one indexed lookup, not a distance computation. There is no near-duplicate detection of any kind; anything that isn't byte-identical after processing uploads.
- **Verification check**: `(VenueVerification row exists for this user and sub-event) OR (membership.admin_verified_at IS NOT NULL) OR (role = 'photographer')`. If it fails, the upload is rejected and the photo waits in the local queue.
- If both checks pass, Express names the upload keys and issues presigned R2 upload URLs for the photo and its thumbnail (D-70).

#### 4.8.3 Stage 3 — upload
- Direct to R2 via the presigned URLs, one for the photo and one for its thumbnail. Express never proxies media bytes.
- Sequential, not parallel, per photo in a session, so most of a session stays cancelable from My Media.
- On completion the client notifies Express, which enqueues the processing job via `pgmq`.
- **Background behavior, bounded deliberately:** iOS uses `beginBackgroundTask` (roughly 3 minutes of continued execution after backgrounding); Android uses a foreground service with a visible sticky notification. Neither attempts to guarantee completion hours later or survive a force-kill. If the app is force-killed mid-upload, the local SQLite queue resumes the remaining items on next launch.

---

### 4.9 Album

The album is a single shared view for every Guest and the Admin. Everyone sees the same photos with the same grouping and filtering controls, including the Photographer's uploads. The Photographer is the only role that cannot read it.

#### Shared album
- Grid view, grouped by sub-event and date, not by uploader.
- Two-tier filtering (full UI spec in §2.5): an always-visible sub-event chip row for time-based filtering, plus a separate People / Uploader filter sheet behind a funnel icon for identity-based filtering. These are deliberately not the same control; stacking them as look-alike chips would hide that they filter different dimensions at different frequencies. An active People/Uploader filter shows as a dismissible pill above the grid and stacks with an active sub-event chip.
- Lazy loading with progressive placeholders: 300px WebP cached via `expo-image`, display resolution on open.
- **A media row is not album-visible until processing completes.** The album query filters on `processed_at IS NOT NULL`. Until the worker finishes, the photo is visible only to its uploader in My Media, carrying a spinner badge. This is what makes the blur guarantee hold at all: if visibility keyed off upload completion instead, an unblurred photo would sit in the shared album for the length of the worker backlog. The honest consequence, and it should be said out loud rather than hidden, is that "a photo appears within seconds" holds when the queue is empty and degrades under a burst.
- Real-time updates via Supabase Realtime; a photo appears on every device the moment its row becomes visible, without manual refresh.
- Any user can delete their own uploaded photo via My Media (soft delete, §4.21).
- Admin can additionally remove or restore anyone's photo.
- Multi-select download to the device gallery, or individual download (§4.15).

#### Album state
- Upload access is enabled or disabled purely by the Admin's manual open/close toggle. There is no automatic timing tied to the schedule.
- "Album Closed" banner shown when closed; the upload action is disabled.
- This applies to every role without exception, including Admin, who is prompted to open the album first rather than silently bypassing the state.
- **It applies to Photographers too, and this is the intended design.** Closing the album is how the Admin says "I have everything I expect to receive." Since Photographers typically upload hours after the event ends (§2.2), the Admin is expected to leave the album open until their delivery lands.
- **Close Album confirm dialog.** Closing is destructive to an in-flight workflow, so it requires a confirm step rather than firing on toggle. The dialog states the count of Photographers on the event who have uploaded nothing yet, by name: "Ali Raza hasn't uploaded any photos. Closing the album will block them from uploading. Close anyway?" If every Photographer has uploaded, the dialog is a plain confirm. This is a single query against the media table and it prevents the most likely real failure of this whole role.

---

### 4.10 Photographer workflow
- **Write-only contributor.** Their uploads land in the shared album immediately and are visible to every Guest and the Admin, at the same time as everyone else's.
- **No album read access.** They see only their own uploads, in My Media, with their own upload count and storage used.
- The **Recognized Faces strip is suppressed** on their own photos. It names matched attendees, and reading the guest list off it would defeat the isolation this role exists for.
- No download button. They already possess the original files they uploaded.
- Exempt from the location verification gate (§4.5).
- Uploads through the same single pipeline as every other role (§4.8). The role-specific upload path that existed in v10 is gone.
- **Read access to the Schedule tab**, which they need in order to know which sub-event section to upload into. Read-only: no Delay action, no editing. This is the one piece of event information they are given, and it is given because the upload flow depends on it.
- Strictly restricted from: album content, attendee list, schedule editing, and Admin settings.

**On the asymmetry.** A Photographer contributes to something they cannot see. This is deliberate: the isolation is of the *person* from the *event*, not of their media from the album. In practice the Photographer already has every frame on their own cards, at higher quality than the app holds, so what they lose is the ability to browse other people's photos, which is exactly what the role is meant to prevent. A web-based delivery uploader for the realistic 800-frame case is Future Work (§6.2).

---

### 4.11 AI media intelligence

#### 4.11.1 Deduplication
SHA-256 over the exact byte stream the client uploads (§4.8). An exact match is rejected at pre-flight, silently, before any file transfer. This is a single indexed lookup in Express and is not a worker job.

#### 4.11.2 Face detection & embedding, the shared foundation
- **One detection pass per photo, on the uploaded file.** A face embedding is extracted for every detected face in every uploaded photo at processing time, regardless of whether that person is a registered user, a Do Not Publish user, or a complete stranger to the app. This is identity-agnostic; the network converts a detected face into a comparable vector without knowing who it is looking at. Everything downstream is a cheap similarity search against this already-computed data, not a re-run of detection.
- **The worker records each photo's pixel width and height on the media row** during this pass. It is already opening the file, so this is free. These are the one prerequisite for ever switching the album grid to a masonry layout without a backfill job against R2. Add the columns now even though v1 renders a square grid; retrofitting them once the table has real rows is significantly more annoying. Note that unlike v10, blur correctness no longer depends on them.
- **Reference sets are split in two, and the split is load-bearing.** A user may upload up to 5 reference photos of themselves, and their profile photo is used as a further reference if it exists, for six in total (§4.2, `docs/ARCHITECTURE.md` §2). Those are **curated** references. A face crop added automatically by the correction flow below is an **auto-added** reference.
  - Matching and Find My Photos use curated plus auto-added.
  - **The manual-blur abuse check uses curated only.** Without the split, a user tapping faces that score just above the loose threshold, meaning a sibling or a cousin in similar attire, drifts their reference set toward that other person over the course of an event. The drifted set is exactly what the abuse check runs against, so the check degrades as the drift grows. One boolean column closes the loop.
- **Detection is not re-run on the blurred output.** Earlier versions of this spec claimed a blurred face is structurally undetectable and used a second detection pass to exclude Do Not Publish users from the Recognized Faces list. That claim does not survive testing (detectors routinely find heavily blurred head-shaped regions), and it doubled inference cost to avoid what should be a filter. The Recognized Faces list is built from the single detection pass, with a viewer-scoped filter applied at read time (see below).

#### 4.11.3 Face recognition: named & unknown clustering
- **Find My Photos**: one tap, using the reference embeddings already on the user's profile. If they have neither a profile photo nor reference photos, they are prompted to add reference photos in Settings.
- **Recognized Faces strip** on a single photo: every detected face is matched against known reference embeddings. Matches get the person's name; non-matches are clustered against each other and shown as "Unknown," consistently the same Unknown identity across multiple photos of the same unregistered person via embedding-similarity clustering. Expect this bucket to be less precise than named matching, since there is no curated reference to check it against.
- Tapping any face, named or Unknown, filters the album to every photo containing that person. Note that this makes the app a face-search index over people who never installed it; §8 states that limitation plainly rather than burying it.
- **The Do Not Publish filter is viewer-scoped, not global.** A face matched to a Do Not Publish user is hidden from the Recognized Faces strip for every viewer *except that user themselves*, who sees their own face listed normally.

  This distinction is load-bearing and easy to get wrong. A global exclusion would mean **Find My Photos returns nothing for a Do Not Publish user**, so the one person who most needs to audit which photos contain them would be the one person who cannot search for them. It would also break the correction path below, which assumes the subject can navigate to photos containing themselves. Implement the filter as a predicate on the read, parameterized by the requesting user, never as a hard exclusion at write time.
- Find My Photos therefore works normally for a Do Not Publish user, and is the practical way they audit for missed matches.

#### 4.11.4 Do Not Publish: personalized face blurring

This is the app's centerpiece feature and it is core scope, not a stretch goal.

##### 4.11.4.1 Activation and the files generated per photo

**Activation requires at least one reference image.** A user with no reference photos and no profile photo cannot enable Do Not Publish. The pipeline matches candidate faces against reference embeddings, so with none on file the activation is permanent, irreversible, and protects nobody, while the Settings row displays a static "Active" badge. The confirm button stays disabled and the screen states what is missing, with a link to add reference photos (§4.19).

**What is generated per photo.** For a photo containing N Do Not Publish subjects, the worker writes N+1 files:

| File | Contents | Who receives it |
|---|---|---|
| `public` | Every Do Not Publish face in the photo is blurred | Everyone except the subjects |
| `variant_<subject>` | Every Do Not Publish face blurred **except** that one subject's | That subject only |

The count is linear, never combinatorial, because no viewer ever needs two different subjects unblurred in the same file. A photo containing no Do Not Publish faces produces no extra files at all: the uploaded file is what everyone sees. Each of the N+1 files also gets a blurred 300px thumbnail at a versioned key, written by the worker. For a photo with no Do Not Publish face, the client's own thumbnail is the one served (D-69).

##### 4.11.4.2 Serving, and the self-visible marker

**Serving is one endpoint, and the client never chooses.** A request for a photo's image hits an endpoint that checks whether the requester is a Do Not Publish subject in that photo, then mints a short-lived presigned R2 URL for the correct file. Viewing and downloading use the same mechanism, which is why there is no compositing step anywhere in this system.

**What this replaced, and why.** v10 generated one public blurred file plus a small unblurred crop per subject in a `dnp_crop` table, which the subject's client layered over the blurred image. Pre-generated variants delete four things at once: the `dnp_crop` table and its row-level policy, the client-side image-over-image overlay, the dependency of blur correctness on the stored width and height, and the authenticated crop-and-paste download endpoint that would have routed media bytes through Express in violation of the architecture's own rule. The trade is storage, and at roughly 100 photos with one to three subjects that is negligible.

**The self-visible marker, which is not optional.**
When a Do Not Publish subject views a photo they appear in, a small lock badge renders on the image and the metadata overlay reads "Your face here is visible only to you." Without this, a subject seeing their own clear face cannot distinguish "personalized blur is working correctly" from "the match failed and 300 guests can see me." The two states would be pixel-identical to the only person who can report the problem, which would silently convert every missed match into a permanent, unreportable privacy failure. The marker is the entire discoverability mechanism for the correction flow below. It is a static badge on the photo rather than a box positioned over a crop, so it cannot drift out of alignment when the viewer zooms.

##### 4.11.4.3 Blur geometry and strength

**Blur geometry and blur strength are specified, not left to whoever writes the worker.**
- **Expand the detection box by 30 to 40 percent and apply an elliptical mask.** A tight InsightFace bounding box leaves hair, ears, jawline and clothing visible. At a wedding where the guest list is known, that is still identifying.
- **Downsample then upsample, with a box blur on top.** A single light Gaussian pass is partially invertible. Downsampling discards information for real. This is an answerable viva question and it costs one line in the worker.

##### 4.11.4.4 Correcting a missed match

**Correcting a missed match.**

**Tap-to-blur is available only to users with Do Not Publish active.** The correction path exists because an automatic match missed a Do Not Publish subject, so a user without it has nothing to correct. Gating it there also collapses the abuse surface: an attacker would first have to permanently and irreversibly blur their own face across every event they will ever join. And because activation now requires a reference image, a requester always has a curated reference set, so the comparison below is never undefined.

If a Do Not Publish user sees their own face with no self-visible marker, the automatic match failed. They tap the face and confirm "Blur my face in this photo." Then:

| Similarity of the tapped face to the requester's **curated** reference set | Behavior |
|---|---|
| Above a loose threshold, well below the production match threshold. Measure both on real data before Phase 5 ends; do not ship an example number. | Blur applies immediately. No review, no Admin involvement. |
| Below that threshold | **Blur still applies immediately**, and the request is queued to the Admin's Review Queue with Confirm / Revert actions. |

Two things this design is doing deliberately:

- **The blur is never pending.** Leaving a face unblurred while an Admin gets around to approving it would leave the person exposed for exactly as long as the Admin is busy, which at a wedding is the whole night. Blur first, let the Admin revert abuse afterwards. The retained uploaded file makes revert mechanically free.
- **The embedding check does the work the Admin would otherwise do.** A genuine miss lands in the middle similarity band. Someone maliciously blurring the bride while holding their own reference set scores near zero against her face. Those are not close numbers, and one cosine comparison against data the system already has separates them. The Admin's queue therefore stays small at a real event, instead of every legitimate correction waiting on a rubber stamp. How small is an open question until the thresholds are measured; do not promise a number.

**Two uncertainty paths, two opposite policies, and this is deliberate.** *System-initiated* uncertainty (the automatic match at upload time was borderline) always resolves toward blurring and is never routed to a human, because there is no human who could adjudicate it and no user waiting on an answer. *User-initiated* uncertainty (someone tapped a face and the similarity check scored low) does reach the Admin, because a person is asserting something about themselves and there is a real abuse case to catch. Do not read these as contradictory rules; they are different events with different failure costs.

**What the Admin can and cannot actually judge, stated honestly.** Because Do Not Publish hides the requester's profile photo from everyone including the Admin (§4.2), and the face in question is already blurred, the Admin has no in-app reference image to compare against. In practice he is judging from personal knowledge of the guest. This is accepted rather than solved: the path is expected to be rare, the blur is already applied while it waits, and a legitimate requester whose score came back near zero can simply contact the Admin out of band and ask him to confirm. A rarely-used feature that degrades to a phone call is an acceptable trade at this scale.

**The confirmed crop becomes a new auto-added reference.** When a user taps their own face, that is a correctly-labeled face crop from a real event photo in real lighting, which is a far better reference than a profile selfie. It is added to their reference set as **auto-added**, so the match that failed once becomes less likely to fail again. It never becomes a curated reference and therefore never feeds the abuse check above.

##### 4.11.4.5 Retroactive reprocessing

**Retroactive reprocessing is a match job, never a detection job.**
Enabling Do Not Publish after photos are already published triggers asynchronous reprocessing. That job compares the **stored embeddings** for every face already on record in the event against the newly-active reference set, which is milliseconds of cosine comparison, then regenerates the public file, the new per-subject variant and the thumbnails of both, for the matched photos only. It never re-runs face detection, because every face in every photo already has an embedding from its original processing pass. Re-running the model would be the expensive version of a job that is nearly free.

**Other properties:**
- Every uploaded photo is checked against the Do Not Publish reference sets of **users who are members of this event**, not globally. The system cannot protect anyone who has not installed the app and uploaded a reference (§8).
- Matching is biased toward blurring when uncertain, since a missed match is the costly failure. This bias will produce false positives, particularly among relatives who resemble each other. The manual correction path above cuts the other way too: a person blurred in error is a visible, fixable state, whereas a person missed in error was previously invisible.
- **Retroactive**: enabling Do Not Publish after photos are already published triggers the reprocessing job described above.
- **Do Not Publish itself is permanently irreversible**, for anyone, self-service or Admin-assisted. A single per-photo manual blur correction is a different object and *is* revertible by the Admin if judged fraudulent. Do not conflate the two in the UI copy.
- **What the system actually guarantees about the uploaded file.** v10 said the retained original is never served to anyone including the subject. Under per-subject variants that stops being true: for a photo with exactly one Do Not Publish subject, that subject's variant is byte-identical to the uploaded file. The guarantee that survives, and the one worth defending out loud, is that **no viewer ever receives a file in which a Do Not Publish face other than their own is unblurred.**

---

### 4.12 Local Only mode

Renamed from "Private mode," because the previous design saved to the device camera roll, which is the most publicly-synced location on the phone.

- Local Only is a device-local sandbox for media captured with the Viewfinder's toggle set to Local Only, and for public queued uploads the user cancels before completion.
- Files are written to the **app's own sandboxed storage** (`FileSystem.documentDirectory`), not the camera roll. This is not indexed by MediaStore on Android or the Photos library on iOS, and the do-not-backup flag is set on iOS so it does not sync to iCloud.
- The tradeoff, which must be stated in the UI at the moment of first use: these files do not appear in the device gallery, and they are deleted if the app is uninstalled.
- My Media acts as the viewer for these files, so the user doesn't have to leave the app to see what they took.
- Local Only captures never touch the network, deduplication, or location verification. They are still subject to the time-based FAB rule (§4.7), because that gate is on the capture entry point, not on the mode.
- A Local Only file cannot be converted to Public through the app. If the user changes their mind, they select it via "+ Add Media" and run it through the normal upload pipeline as a fresh action.

---

### 4.13 Media delivery
- 300px WebP thumbnails via `expo-image`, center-cropped to square for grid uniformity across mixed-aspect sources. They are served through the same endpoint as full images and follow the same personalization and versioning rules (D-69).
- **There is one image per photo, not a display variant and an original.** §4.8 removed the client resize, so the file that was uploaded is the file that is served, zoomed, downloaded, and blurred from. The v10 distinction between a 2048px display version and a retained full-quality original no longer exists, and neither does the role-based routing that depended on it.
- **Every image request goes through the serving endpoint in §4.11**, which checks whether the requester is a Do Not Publish subject in that photo and mints a presigned R2 URL for the correct file. Do not wire an image component or a download button directly to a bucket URL; personalization silently stops working for exactly the people it exists for, and nothing throws an error when it does.
- **Blur variant object keys carry a version, and the version lives on the media row.** The public file is a mutable derived artifact: retroactive Do Not Publish regenerates it, and so does a confirmed manual blur. With a stable object key, every client that already loaded that photo keeps serving the pre-blur image out of its own `expo-image` disk cache, and any CDN in front of R2 keeps serving it too. That is the exact failure the whole feature exists to prevent, and it is invisible to any test written against a fresh client.
  - Key shape: `{media_id}/public_v{n}.jpg`, and `{media_id}/{subject_id}_v{n}.jpg` for per-subject variants.
  - `variant_version` is an integer column on the media row, bumped on every regeneration. The Realtime row update carries the new value, so clients with the photo already on screen re-resolve immediately.
- Presigned URLs are issued with a one-hour lifetime, and `expo-image` is given an explicit stable cache key, so a rotating URL does not defeat caching for the one to three people who receive personalized files.
- `uploader_role_at_upload` is display and filter metadata only. §4.8 removed the role branch it used to route, so it appears in no access-control and no routing decision anywhere.
- No video playback surface. There is no video anywhere in the app.

---

### 4.14 Offline mode
- Cached on first load: the schedule, sub-event and venue details including coordinates and radius, and the thumbnail grid.
- Capture and the local upload queue work fully offline. Queued items each carry their own GPS reading, taken at capture time, and run their full pre-flight and upload sequence once reconnected.
- **Offline QR scanning works.** The scanned payload is written to local SQLite and travels with the next pre-flight request. No venue secret is pre-cached, because caching the secret of an unscanned QR would let any client self-verify from anywhere.
- Local GPS verification works offline, since the comparison is against cached coordinates on-device. It flips the queue to ready; the actual upload still needs connectivity for pre-flight and the presigned URL. Local verification removes the wait, not the network requirement.
- Schedule changes always pull fresh from the server on reconnect. Nothing to merge, since there is no local schedule editing on Guest devices.

---

### 4.15 Post-event features
- **Multi-select download** to the device gallery, plus individual photo download. This is the primary export path.
- Full-album ZIP export is a stretch goal (§7). It requires streaming media that would otherwise route through the VM, and the multi-select path covers what people actually do.
- Photographers have no download option; they already possess the originals they uploaded.
- Downloads serve the same file the album serves, personalized per §4.11 for Do Not Publish subjects. There is no quality tier and no role-based routing on the download path.
- **No sharing links in v1.** Anyone who wants to view the album joins the event as a Guest. A web viewer for people who won't install the app is a stretch goal (§7).
- Visibility, grace, and deletion windows: see §4.21.

---

### 4.16 Notifications

| Channel | Trigger |
|---|---|
| Approval Alerts | New join requests, and approval or rejection outcomes |
| Album Lifecycle | Album open/close, visibility window ending, Archive Mode |

These are the only two channels. Schedule Changes and Upload Activity notifications are stretch goals (§7); they add build cost with minimal demo presence. There is no Sub-Event Reminders channel (RSVP and reminders are cut) and no Check-In Confirmation channel (verification is silent; there is nothing to confirm in the moment).

---

### 4.17 Limits (hard-coded, no subscription system)

There is no `PlanTier` concept in v1. Subscriptions are entirely Future Work (§6.2). In their place, fixed constants are hard-coded into the app and API, with no user-facing limit UI, no upgrade flow, and no per-event selection:

- Maximum event duration: **14 days** (this is a *duration* cap, not to be confused with the unrelated 14-day event soft-delete window in §4.21)
- Maximum guest count per event: **150**
- Maximum upload count per event: **2,000**

These are safety rails against a runaway event, not a monetization mechanism. The guest number is deliberately lower than earlier drafts: the Supabase free tier allows 200 peak concurrent Realtime connections and 2 million Realtime messages per month, and a 500-guest event broadcasting every upload would exceed both from a single wedding. 150 leaves headroom under the connection ceiling. Both numbers comfortably exceed anything the demo will need.

---

### 4.18 Privacy & consent management
- Explicit consent screen on first launch, covering:
  - Account creation and basic profile data retention.
  - **Face detection and processing**, stated accurately: every face in every uploaded photo is detected and converted into an embedding, including faces belonging to people who are not app users, in order to support Find My Photos and Do Not Publish blurring.
  - The permanent, non-reversible nature of Do Not Publish.
- Consent version tracking: if the Privacy Policy materially changes, all active sessions are paused on next launch until the new version is accepted.
- **Accurate metadata statement.** GPS, camera model, and device serial are stripped from the image file before it leaves the device. A separate GPS reading is transmitted alongside the pre-flight request for the sole purpose of location verification, is validated against the sub-event's coordinates, and is not persisted on the media record. Say this, rather than the previous version's blanket claim that GPS never reaches the network, which was not what the pipeline actually did.
- Blur transparency: a user viewing a blurred face can tap a small info icon explaining why ("This person has requested privacy"), which reduces confusion about whether the image is simply failing to load.
- The full "My Data" dashboard remains Future Work.

---

### 4.19 Settings & preferences
- **Account:** update profile photo, manage reference photos (up to 5), request account deletion (contacts support; no automated workflow yet), change password, log out.
- **Appearance:** theme (Light / Dark / System Default).
- **Notifications:** push toggles for **Approval Alerts** and **Album Lifecycle**. These are the only two channels that exist (§4.16); earlier versions of this document listed four toggles for two features.
- **Upload:** "Upload over Mobile Data" toggle (default on; phone JPEGs run 1 to 3MB and upload without resizing, §4.8); default Viewfinder mode (start Public vs. start Local Only).
- **Privacy:** Do Not Publish activation, rendered as described in §2.5, clearly marked as one-way and irreversible, and blocked entirely unless the user has at least one reference photo or a profile photo (§4.2).
- **Storage:** clear local image cache; storage usage breakdown (app size vs. cache vs. Local Only files).
- **About & Legal:** Terms of Service, Privacy Policy, Open Source Licenses, app version and build number.

---

### 4.20 Deployment & hosting

**One compute environment for development and the demo, and the viva will ask why.**

- **Development and demo: one Netcup RS 1000 G12 root server** (4 dedicated AMD EPYC 9645 cores, 8 GB RAM, x86-64), rented from 15 October 2026. The team builds and tunes against it and the demo runs on it, so the latency the panel sees is the latency the team has been measuring (D-78). Development uses the dev Supabase project; the demo stack, against the stable project, goes up on the same server one month before the demo (D-76).
- **The M1 is a development machine, not the demo runtime.** An earlier version of this spec ran the demo on it because it measured faster than the free-tier ARM instance. D-78 traded that speed for a demo environment that is not a single laptop.

**What the server does not buy.** It removes the laptop from the demo; it does not remove the network dependency. Supabase, R2, and the judges' phones are all still on the network. If campus WiFi fails, the demo fails with it, which is why §9's fallback is a recorded walkthrough on local storage rather than a seeded remote dataset.

**No tunnel.** The server has a public address, and the API answers on a stable hostname through nginx with a certbot certificate.

- **No Docker.** Express and the FastAPI worker run directly under `systemd` units, behind `nginx` as a reverse proxy, with TLS via `certbot`. A single-provider deployment does not need container portability, and the setup is one fewer moving part for a team that has not deployed anything before. Dependency versions are pinned in `pnpm-lock.yaml` and an exactly-pinned `requirements.txt`.
- **Provisioning is a script.** `scripts/provision.sh` sets up a fresh Ubuntu 24.04 server end to end, so replacing the server means running one script (Handbook §13).
- **Fallback:** the team's Azure for Students, AWS and GCP credits, used in that order, with the standby VM created for the Phase 7 rehearsal and again for demo week and deleted in between (D-79). Nothing runs between those two windows, so no credit is spent guarding an event that has not happened.
- **Database & Auth:** Supabase, two projects (one dev, one stable demo). The free tier allows exactly two, so there is no headroom.
- **Storage:** Cloudflare R2 (S3-compatible, no egress fees, 10 GB permanently free). At roughly 100 seeded photos of 1 to 3MB, plus per-subject variants and thumbnails, total usage stays under 500MB. Storage is not a design constraint for this project.
- **Supabase keep-alive runs from a GitHub Actions scheduled workflow, not from the compute box.** Free projects pause after 7 days of inactivity. Putting the keep-alive on the server it is meant to protect chains two failures together. One YAML file, independent failure domain.
- **AI worker:** a standalone FastAPI service consuming jobs from a `pgmq` queue in Supabase. **The InsightFace model is loaded once at worker startup and stays resident.** Lazy-loading per job costs several seconds of cold start, which is what would actually make the demo feel slow.
- See the companion Engineering Handbook for the deployment walkthrough.

**Verify on the server, not only locally.** InsightFace 2.0 installs as a pure-Python package, and `onnxruntime` and OpenCV ship wheels for both x86-64 and ARM64. The Phase 0 spike passed on an ARM64 server and on the M1 on 2026-09-15. Run it again on the x86-64 server the day it is provisioned, before planning anything on top of it.

---

### 4.21 Retention & deletion windows

Consolidated here because four scattered numbers in four sections is how a three-person team ends up implementing three of them inconsistently.

| Object | Window | Behavior |
|---|---|---|
| Deleted photo (by uploader or Admin) | 30 days | Soft delete. Admin can restore within the window. |
| Deleted event | 14 days | Soft delete. Guests and Admin notified with a download prompt; Photographers are not notified. Download remains available during the window. |
| Album visibility after Admin closes it | 30 days | Album stays browsable, view-only. Flat, not tier-dependent. |
| Expiry warning | 7 days before | Album Lifecycle notification. |
| Recoverable grace period after expiry | 7 days | Then permanent deletion of media from R2 and rows from Postgres. |

---

## 5. Edge cases & exception handling
<!-- abstract: What the app does when things go wrong: failed uploads, lost connectivity, duplicate joins, revoked access, missed face matches and the states each one leaves behind. -->

| Scenario | System behavior |
|---|---|
| Invite link expired or revoked | Clean error screen: "This link has expired or been revoked. Contact the event organizer." |
| User not verified for the active sub-event | Upload does not proceed. Photos wait in the local queue. Banner offers "Scan Venue QR" and "Ask the organizer to verify you." |
| Guest scans the Venue QR, offline | Scan recorded locally; travels with the next pre-flight on reconnect, then the queue flushes. |
| Admin taps Force Verify | `admin_verified_at` is set; every queued and future photo for every sub-event unlocks. |
| User never gets verified at all | Photos remain in the local queue indefinitely and are visible in My Media with a clock badge. They are not lost, and they are not uploaded. The user can delete them locally. |
| A sub-event runs past its scheduled end | It stays In Progress until the next sub-event starts (§4.3). Capture stays available. |
| Sub-events overlap because the Admin scheduled them that way | Capture tags to the most recently started one. |
| Exact duplicate detected (identical SHA-256 of the uploaded bytes) | Silently rejected before any file transfer. No prompt. |
| Upload succeeded but the worker has not processed it yet | The row exists with `processed_at` null. Visible only to the uploader in My Media with a spinner badge, never in the shared album (§4.9). |
| A user with no reference photo and no profile photo tries to enable Do Not Publish | Blocked. The confirm button stays disabled and the screen links to Add Reference Photos. Activating with nothing to match on would be permanent and would protect nobody (§4.2). |
| A user without Do Not Publish taps a face in a photo | Nothing happens. The tap-to-blur affordance renders only for users with Do Not Publish active (§4.11). |
| Do Not Publish match confidence is borderline at upload | Resolves automatically toward blurring. Never routed to a human. |
| Do Not Publish match fails and the subject notices | Subject taps their own face; blur applies immediately. If similarity to their own **curated** reference set is low, the request also lands in the Admin's Review Queue for Confirm / Revert (§4.11). |
| Someone enables Do Not Publish after 100 photos are already in the album | The reprocess job compares stored embeddings against the new reference set, regenerates the public file and thumbnails for matched photos, writes their per-subject variant, and bumps `variant_version` so clients holding a cached copy re-resolve (§4.11, §4.13). Detection is never re-run. |
| Someone abuses manual blur on another person | The similarity check catches it (near-zero score), so the request is queued; the Admin reverts it. The face stays blurred in the meantime. |
| A legitimate request scores near zero anyway (bad angle, heavy occlusion) | The blur is applied and the request is queued. The Admin has no in-app reference to judge from (§4.11), so the requester contacts him out of band. Accepted, because the path is rare and fails toward privacy. |
| Photo uploaded before a Do Not Publish flag is activated | Existing photos are reprocessed asynchronously to blur that face. |
| Photographer uploads at 2am from home | Proceeds. Photographers are exempt from the location gate, and are otherwise handled by the same single upload pipeline as everyone else (§4.8). |
| A file larger than 4096px on the longest edge is added via "+ Add Media" | Resized to 4096px client-side before upload. This never fires on a phone photo (§4.8). |
| Photographer uploads after their sub-event ends, while the event is still open | Normal case, and the intended workflow. The photographer shoots the walima, uploads that night, and notifies the Admin out of band. The Admin closes the album once satisfied. Album state is per event, not per sub-event, so a completed sub-event never blocks an upload. |
| Photographer uploads after the Admin closed the album | Blocked, same as any role. The Close Album confirm dialog (§4.9) names any Photographer who has uploaded nothing yet, specifically to prevent this. |
| Admin deletes event mid-event | Attendees notified, 14-day soft delete, download still available. |
| Any user tries to upload while the album is closed | Upload disabled with a clear banner. Applies to Admin too, who is prompted to open the album first. |
| App force-killed mid-upload | The local SQLite queue resumes the remaining items on next launch. No attempt at guaranteed background completion. |
| Supabase free-tier project auto-pauses after inactivity | Mitigated via a scheduled keep-alive ping. Surfaces a clear "temporarily unavailable" state with a retry action if it happens anyway. |

---

## 6. Deferred & out of scope

### 6.1 Not planned (permanently out of scope)
Reverting Do Not Publish. Face-recognition opt-out. i18n. User bio. Captioning. Feed view. RAW file handling.

### 6.2 Future work (post-FYP roadmap)
- **Video support**, including face blur for video, which is materially harder than the photo case because it requires tracking a face across frames rather than detecting it once.
- **Subscription tiers and payment processing**: the full `PlanTier` structure, guest/upload/duration enforcement, and a website-redirect-and-verify payment flow.
- **Sub-event visibility groups.** A `restricted` flag on a sub-event plus an access join table, so that, for example, mehndi photos are visible only to a named subset of attendees. Cut because there is no reliable way to auto-populate such a group and manual group construction is its own feature. The schema is cheap to retrofit; the RLS policy is one additional AND clause.
- **Retroactive per-sub-event verification requests.** A user asking the Admin to verify them for a sub-event that has already passed. Replaced in v1 by the blunt Force Verify, which covers everything at once.
- **Proxy Blur: Do Not Publish for someone who has no account.** A guest who never installed the app has no reference embedding, so there is nothing for the pipeline to match on and no remedy for her at all today (§8). The design: the woman hands the host one clear photo of herself, which is the consent act. The Admin goes to Manage → Attendees → "Add blur request for a non-user," enters a display name and that photo, and the system creates a **subject row with a reference embedding and a Do Not Publish flag but no linked auth user**. Existing photos reprocess and future photos are checked through the pipeline that already exists. She cannot view herself unblurred, because there is no account to authenticate as, and that is correct: she asked for invisibility, not access. **Admin-only**, because if any guest could file one, somebody would upload the bride's face and blur the entire album, and the Admin has a direct personal incentive to keep his own wedding album usable.
  - **Do the schema split now even though the feature is deferred.** `subject` is its own row with a nullable foreign key to the auth user. Adding that before the table exists is a column definition; retrofitting it against live rows is a real migration.
  - **The contradiction to have an answer ready for.** The app's headline privacy answer is that the Admin owns the event and does not own anybody's face. Proxy Blur hands the Admin a power over somebody else's face. The reconciliation, and it holds: every power the Admin has points toward privacy. He can make a person less visible, never more. The subject-controlled guarantee is about the direction of harm.
- **Manual blur rate limiting.** Each tap-to-blur applies immediately, so nothing in v1 stops one user filing many requests and leaving the Admin a queue to revert one at a time. The similarity check catches each individually and stops none of them in aggregate. The design: cap at 10 requests per user per event, mark the requesting user each time the Admin reverts one, and disable the action for that user after two reverts. A counter column and one conditional. Deferred because the abuse requires a volume of adversarial users this project will never see, not because the fix is expensive.
- **A web uploader for photographers**, which is what the realistic 800-frames-on-a-CF-card workflow actually needs. Lowest priority.
- **The Moderator role** as distinct from Admin.
- **In-app Notification Center**, drag-and-drop sub-event reordering, photo filters, the Shared Private Album with end-to-end encryption, re-authentication before Admin destructive actions, viewing own event history, adding or cancelling an unplanned sub-event, RSVP and its reminder system, near-duplicate comparison UI, exposure and closed-eye detection.
- **Parallel uploads**, currently sequential by design (§4.8).

---

## 7. If time allows (stretch goals this FYP)

Build these only after the core scope above is working, tested, and demo-stable.

- **Lens zoom** (0.5x/1x/2x/3x pill row above the shutter). Core ships with 1x fixed.
- **"Move to…" sub-event reassignment.** Long-press or a "Select" button → multi-select → action bar → "Move to…" → sheet listing this event's sub-events → re-tags every selected photo, with the grid re-sectioning instantly. Applies to queued and already-uploaded photos, with a server-side re-tag for the latter. This is the fix for photos that sat queued overnight or were tagged during an overlapping sub-event.
- **Full-album ZIP export**, organized by sub-event folders. Do not build this by streaming through the VM. The correct shape is a Cloudflare Worker that streams a ZIP directly from R2, which is free at this scale and keeps the media path off the compute box entirely.
- **Web viewer / sharing links.** A read-only browser view of the album for people who won't install the app, with time-limited expiry and configurable access levels. This is what "sharing" was always meant to be.
- **Schedule Changes and Upload Activity notifications**: push when the Admin delays a sub-event, or when a user's own photo is flagged.
- **Burst grouping and best-shot selection.** Group photos sharing a sub-event and uploader captured within roughly 10 seconds of each other, then score each frame using Laplacian variance for sharpness, the same variance weighted on the face bounding boxes, and an eye-aspect-ratio check from the landmarks InsightFace already returns. The scoring is nearly free because the landmarks come from the detection pass you already run; the cost is the album UI. Render a group as a stack with a count badge and the winner on top, tappable to expand, and **always ship a re-crown control**, because a judge who disagrees with the pick will say so out loud. Note that this feature is the only thing that would justify reintroducing perceptual hashing and Hamming distance, which §4.11 removed.
- **Blur/focus quality scoring** as a standalone metadata badge (OpenCV, Laplacian variance).

---

## 8. Known limitations (state these, don't hide them)

Every one of these will be asked about in the viva. Having a written answer is worth more than pretending they don't exist.

**Do Not Publish only protects people who install the app.** Protection requires a registered account, a reference photo, and an explicit opt-in. It cannot protect a guest who never used the app, which is most of the room. The feature is a tool for people who care enough to configure it, not a blanket guarantee for everyone in a photo. There is no remedy in v1 for a non-user who asks to be removed beyond the Admin deleting the photo; Proxy Blur (§6.2) is the designed answer and it is deferred.

**The app builds a face index over people who never consented to one, and that is a real cost, not just a caveat.** Every detected face is embedded, and unregistered people are clustered into a persistent "Unknown" identity that any event member can tap to filter the album to every photo containing them. The comparison usually offered, that a bounded album with an expiry date and stripped metadata beats two hundred phones and a dozen WhatsApp groups, is true on distribution, retention, and metadata. It is **not** true on face indexing, where this app does something WhatsApp does not. Say both halves. The mitigations that exist are real but partial: embeddings are scoped to one event, are never exported, and are deleted when the event is.

**Consent for face processing is obtained from the uploader, not the subject.** Every face in every uploaded photo is embedded, including faces of people who never agreed to anything. This is inherent to any face-search feature and is not something v1 solves. Under a strict reading of biometric-data rules it is the app's most exposed area. The mitigations that do exist: embeddings are scoped per event, they are never exported, and the Do Not Publish path lets a subject act on their own face.

**Downloads defeat every in-app privacy control.** Any Guest can download a photo and forward it, and v1 places no restriction on that beyond requiring event membership. The blur guarantee protects the app's own surface, not the world. The honest framing: the visibility window limits how long the album stays reachable, and it does nothing about copies already made.

**False-positive blurs will happen.** Matching is biased toward blurring, and South Asian weddings feature many related people in similar attire under poor lighting. Some faces will be blurred that shouldn't be. The manual correction path handles the opposite error; the false-positive direction currently has no self-service fix.

**The similarity thresholds are measured on the team's own faces.** They are calibrated against roughly 30 photos of three people in varied lighting, which is a small and unrepresentative sample. Volunteer this rather than waiting to be asked: the numbers would need recalibration against a real guest population, and quoting a threshold the team has not measured is worse than describing the mechanism without one.

**The verification gate is bypassable in principle.** The GPS check runs on-device for offline usability. The server re-validates and is the authority on the verification record, but a determined attacker with a modified client and a spoofed GPS reading can still upload. This is a UX gate, not a security boundary.

**The Photographer link is a broad grant.** It bypasses location verification and uploads straight into the shared album from anywhere. Treat it as a credential, and revoke it after the event.

**A missed match is only found by the subject noticing.** There is no automated audit. A Do Not Publish user checks whether the system caught them by using Find My Photos and looking for the self-visible lock marker on each result. That works, and it is the reason the recognition filter is viewer-scoped (§4.11), but it is manual and it depends on the person actually looking.

**The Admin cannot verify identity on a low-confidence blur request.** The requester's profile photo is hidden by Do Not Publish and the disputed face is already blurred, so there is no in-app reference. The path degrades to out-of-band contact. Accepted because it is rare and because the failure direction is toward privacy, not away from it.

**The upload queue is per-device.** Multi-device login is supported, but photos queued on one device are not visible on another.

---

## 9. The demo script

Roughly 30 minutes, a university classroom, 3 team members and 3 to 4 judges, campus WiFi, GPS verified in a rehearsal one week earlier with a generous verification radius set on the demo event.

Reverse-engineer scope from this list. **If a feature does not appear here, it is not core scope**, and you should be able to say that out loud without flinching.

### Before the room: what has to already be true

**Devices.** The app is not on any store and there is no deferred deep link (§4.1), so it cannot arrive on a stranger's phone during the demo. Judges use **team-owned Android devices handed around**, with the build installed and the accounts signed in at least a week ahead. If a judge wants the app on their own phone, that is an Android APK sideload arranged in advance, never on the day. iOS is not a demo path: TestFlight needs an Apple review pass and invited testers, and ad-hoc provisioning needs UDIDs collected beforehand.

**Backend.** The API and worker run on the Netcup server the team developed against, on its stable hostname (§4.20). The demo stack against the stable project has been up for a month (D-76).

**Pre-configured accounts.** Do Not Publish is enabled beforehand on **two** team accounts: one for beat 5, and one for beat 7, since tap-to-blur is only available to users who have it active (§4.11). Never ask a judge to enable it; the action is permanently irreversible for anyone.

**Seeded dataset**, roughly 100 photos, loading in ten seconds.

**Offline fallback.** A recorded walkthrough of the full script on local storage, on a USB stick and on a laptop that is in the room. The seeded dataset lives in Supabase, so a total network failure takes it too. This costs an afternoon and will probably never be used.

### The beats

1. **Create the event.** Two sub-events, one currently live. Show the Guest Link and Photographer Link, and the printed Venue QR.
2. **Judges join.** Two judges open or paste the Guest Link on the handed-around devices and land in the album. This is where deep links, auth, and role assignment all prove themselves at once.
3. **Capture and upload.** A judge takes a photo. Location verifies silently; the photo appears in the shared album on every device within seconds once the worker finishes and the row becomes visible (§4.9). Then show the queue gate: deny location permission, clear it with a Venue QR scan.
4. **Find My Photos.** A judge with reference photos set taps once and sees only the photos they appear in.
5. **Do Not Publish.** Use the pre-configured team account. Walk them through the consent screen without confirming it, including the reference-photo precondition (§4.2), then hand phones around: the subject sees their own face clearly with the lock badge and "visible only to you," every other phone shows it blurred. This is the moment the project earns its grade.
6. **Manual correction.** Use a **pre-seeded photo where the subject's reference set deliberately does not cover that angle**, so the miss is genuine and reproducible. Do not try to manufacture a miss live, and do not ship code that fakes one. The subject taps their face, blurs it, and it updates on the other phones.
7. **Abuse caught.** The second Do Not Publish team account tries to blur the first person's face. The similarity check against that account's **curated** reference set scores near zero, the blur applies anyway, and the request lands in the Admin's Review Queue for Revert. Short beat, and it is one of the more defensible design decisions in the project, so do not leave it invisible.
8. **Photographer delivery.** A team member on the Photographer account uploads two photos from the gallery, with no location verification, through the same pipeline everyone else uses. They appear in the shared album alongside everything else. Show that the Photographer's own app cannot browse the album.
9. **Close and export.** Admin closes the album, the confirm dialog reports whether every Photographer has uploaded, upload controls disable everywhere, and a judge multi-selects three photos and saves them to their camera roll.

### Two answers to have ready, because they will be asked

**"Why a paid server, and not the free tier or a laptop?"** One server ran development and runs the demo, so what the panel sees is what the team built and tested against. On 23 wedding and group photos, a 2-core free-tier ARM server took 3.5 times as long as an M1 laptop, and a laptop in the room is a single point of failure that still needs the network. Four dedicated cores cost about €15 a month. Quote the numbers in D-78, including the benchmark run on the server itself, and be ready to SSH in and show the systemd units.

**"What are your thresholds?"** Give the measured number and the date it was measured, or describe the mechanism without a number. Never quote the example values that appeared in earlier drafts of this document.
