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

v11 applies the resolution log. Two constraints drove most of it. No real event is ever covered: development and the demo run on about 100 seeded photos, under 500MB against a 10GB R2 budget, so storage shapes nothing in this document (D-49). The second, running the demo backend on an M1 for its inference speed, was superseded by D-78: development and the demo run on one Netcup server (§4.20).

**Architecture changes**

- Personalized variants replace the crop overlay. N Do Not Publish subjects means N+1 files, and the `dnp_crop` table, the client overlay and the compositing download endpoint are gone (§4.11, §4.13, D-57).
- Pinch-zoom is back, because there is no overlay left to keep aligned (§2.5, D-59, D-77).
- No client-side resize, except a guard at 4096px, so every role shares one upload pipeline (§4.8, D-58).
- Blur variant keys carry a version, so no client serves a pre-blur image from its cache (§4.13, D-60).

**Correctness fixes**

- Do Not Publish cannot be activated without a reference to match on (§4.2, D-56).
- No media row is album-visible until processing completes (§4.9, D-55).
- Tap-to-blur was limited to users with Do Not Publish active (D-52). D-83 later removed it in favour of a blur region anyone can draw (§4.11).
- The dedup hash covers the exact bytes uploaded, not a re-encoded thumbnail (§4.8, D-53).
- References were split into curated and auto-added (D-54). With tap-to-blur gone there are no auto-added ones (D-83).
- Retroactive reprocessing never re-runs face detection (§4.11, D-66).
- Blur geometry and strength are specified (§4.11, D-65).

**Scope changes**

- Proxy Blur and manual blur rate limiting are designed and deferred in §6.2 (D-63, D-64). The subject-versus-account split in the schema happens now anyway.
- Full-quality download of photographer originals leaves §6.2, since there is one file per photo (D-58). Pinch-zoom leaves §6.2 for core.
- The deferred deep link claim in §4.1 is dropped (D-61).
- The aspect-ratio question is settled. Capture and full-screen keep native aspect, the grid center-crops to squares, and the worker stores `width` and `height` so masonry stays a one-prop change (D-21, D-22).

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

   Step 2 — Venue
   ├── Venue name, GPS (search or map pin)
   └── Verification radius (default 200m, adjustable 50m to 2km)

   Step 3 — Sub-events
   ├── At least one and up to 15: name, start and end, venue (inherit or
   │   custom), description
   ├── The event runs from the first start to the last end, capped at a
   │   fixed maximum (§4.17); no tier selection, no upgrade flow
   └── Auto-ordered by start time

   Step 4 — Review & confirm

7. Event created → the event's Home, as its Admin. The album is closed to uploads by default
   until the Admin explicitly opens it. Always a manual action, never
   scheduled or automatic.
```

#### 2.1.3 Phase C — invitation & venue QR
```
8. Manage → Invite. Two role-specific invite links are
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

9. Separately, each venue gets one Venue Check-In QR, the only QR image the
   app produces. It is printed and posted at the venue, and it is the
   fallback to GPS verification (§4.5). Sub-events at the same venue share
   its QR; a scan verifies whichever of them is In Progress at the time.

10. If Approval Mode = "Approve New Users": pending requests queue
    (name, photo, join time) → Approve / Reject / Block, individually or in
    bulk.

11. Manage attendees: searchable list, check-in / verification status, manual
    role change as a fallback, Force Verify, remove from event.
```

#### 2.1.4 Phase D — during the event
```
12. Manage's live status card shows: upload count, current sub-event and its
    auto-computed status, and album state (Open / Closed).

13. Admin actions, always available:
    ├── Open / close the album (manual, the only mechanism)
    ├── Remove / restore any photo (soft delete, §4.21)
    ├── Promote / demote / remove any user's role
    ├── Force Verify any user from the Attendee list (covers every
    │   sub-event at once)
    ├── Delay a sub-event by any amount of time
    └── Review Queue: flagged photos, blur regions and removed photos
        (§2.5.7)

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
   permissions, through the event's Approval Mode like any join (§4.4). No
   intermediate Guest state, no waiting on a manual role change from Admin.

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
   flips the local queue to ready, keeps that one reading for the server,
   and the queue starts flushing (§4.5).

9. If GPS fails or is unreliable, the Guest can scan the Venue Check-In QR
   printed at the venue. This works offline; the scan is recorded locally
   with its time and travels with the next pre-flight request (§4.5).

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
| Scan | Venue Check-In QR only (§4.5). Works standalone, since the QR payload carries its venue, and the server works out which sub-event it verifies from the scan time (D-85). |
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
- **Filter icon** (funnel, in the header), deliberately separate from the chip row and not another chip, because it filters a different dimension. Identity, not time. Opens a bottom sheet with **People** (Find My Photos pinned at top, then a searchable list of the named people matched in this event's photos, with Do Not Publish subjects left out for every viewer but themselves, §4.11.3; "Unknown" clusters aren't searchable by name here, they're only reachable by tapping a face inside a photo) and **Uploader** (searchable list of contributors, including the Photographer).
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
- **The FAB is hidden when no sub-event is currently In Progress.** There is no capture path that can produce an ambiguous-sub-event photo. A sub-event ends at its scheduled end (§4.3), so the FAB is also hidden between sub-events, and the Admin delays one that runs late. Photos taken meanwhile with the phone's own camera can still be added through "+ Add Media".
- Tapping the FAB opens the Viewfinder as a full-screen modal, hiding the tab bar, and drops straight into the currently live sub-event's capture context. No sub-event picker at capture time.
- Viewfinder components: live preview at the camera's native aspect ratio with no forced crop, front/back flip icon (bottom-right), Public / Local Only toggle (top, changeable mid-session), large shutter button, running thumbnail strip of the current session, capture counter. No lens zoom control (§7) and no gallery picker; gallery access is exclusively the "+ Add Media" button per sub-event section in My Media. Exit (X) dismisses the modal and lands on My Media, with new captures appearing at the top of the relevant section immediately via optimistic UI.

#### 2.5.5 Schedule

One list component reused for every role, permission-gated rather than forked: ordered sub-events with an auto-computed status badge (Upcoming / In Progress / Completed). Admin-only inline "Delay" action per row. Tap a row → Sub-event Detail (name, date/time, venue, "Get Directions," "View photos from this session" → Home, pre-filtered to that sub-event's chip, shown to every role but the Photographer, who has no Home).

#### 2.5.6 Single photo view

Full-screen swipeable pager. Tap toggles the metadata overlay (capture time, sub-event, uploader). **Pinch-zoom and pan are supported.** They were deferred in v10 solely to keep the personalized-blur crop overlay welded to the correct pixels through a gesture-driven transform; §4.11 removed the overlay, so this is now an ordinary image viewer with no privacy coupling at all.

- **Recognized Faces strip**: named where matched to a registered user, "Unknown" where not, still individually clustered and tappable. Tapping a face returns to Home filtered to that person, reusing the active-filter-pill mechanism rather than pushing a new screen.
- **Blur info icon (ⓘ)** next to any blurred face surfaces the §4.18 transparency notice: "This person has requested privacy." A blur region somebody else drew is not a request from the person under it, so its ⓘ says "Someone at this event blurred this area" instead.
- **Self-visible marker.** When you view a photo you appear in with Do Not Publish active, a small lock badge renders on the image and the metadata overlay reads "Your face here is visible only to you." It is the only way to tell "personalized blur is working" from "the match failed and everyone can see me" (§4.11.4.2). It is a static badge, not a positioned box, so zoom cannot move it out of place.
- **Blur a region.** Any Guest or the Admin can draw a rectangle over part of the photo, usually a face the detector missed. It blurs for every viewer at once, in every file of the photo. The person who drew it and the Admin can remove it (§4.11.4.4, D-83). A Photographer never sees this.
- Action bar: Download / Share / Flag / Blur a region / Delete, present or absent per role and photo ownership; the Admin sees Remove on anyone's photo. Delete and Remove are soft deletes the Admin can undo for 30 days (§4.21). Share opens the phone's share sheet with the same file Download saves (§4.15); it is not a sharing link. Suppressed for Photographers on their own photos except Delete.

#### 2.5.7 Manage (admin only)

Grouped hub screen, iOS-Settings-style list of rows each linking to its own sub-screen, not one long page:

- **Live status card** (top): upload count, current sub-event and status, Open/Close Album toggle (mirrors the Home banner, same state, two entry points).
- **Pending Approvals**, kept structurally separate from the Review Queue below. Different data, different actions, not one "moderation" bucket. Row per join requester (photo, name, role they're joining as, determined by which link they used), Approve/Reject per row, multi-select plus bulk action bar.
- **Review Queue**, three sections in one screen:
  - *Flagged photos* (Guest-flagged). Thumbnail grid, each card showing sub-event, uploader, flagged time. Tap → Single Photo View with a moderation action bar: Keep / Remove.
  - *Blur regions*, each already applied. The card shows the photo with the region outlined, who drew it and when. Actions: Keep / Remove region; removing restores what was there (D-83).
  - *Removed photos*, deleted by their uploader or removed by the Admin, within the 30-day window (§4.21). Action: Restore.
- **Attendees**: search, filter by role and verification status, row → detail sheet (Change Role, Force Verify, Remove from Event, Block).
- **Invite**: Guest Link and Photographer Link cards (shortcode prominent, URL secondary, Copy, Share, Revoke & Regenerate), plus one Venue QR per venue (preview, "Download for printing," regenerate).
- **Sub-events**: deep-links into the Schedule tab rather than duplicating it, since Admin's Delay affordance already lives there.
- **Event Settings**: edit form (name, description, cover, venue, verification radius, Approval Mode). The event's dates are its sub-events' span and change only through the Schedule (§4.3, D-88). The form has a visually separated Danger Zone (Delete / Archive) and a required confirm dialog.

#### 2.5.8 Screens formalized in this pass

| Screen | Trigger | Notes |
|---|---|---|
| Join Confirmation | Valid invite token, new to event | Read-only preview before the join action fires; shows the role being joined as. |
| Pending Approval | Approval Mode = manual | A waiting state, not a spinner. Has a Cancel Request option. |
| Join Error | Expired or revoked token | Reserved for dead tokens. A mistyped shortcode gets inline field validation on Manual Join Entry instead. |
| Forced Logout / Access Removed | The Supabase session ends, or the user is removed or blocked from an event mid-session (§4.1) | Prevents a silent bounce to Login reading as a bug. Access Removed returns to the Events list; only a dead session logs out. |
| Consent re-gate | Privacy Policy version bump (§4.18) | Blocking full-screen re-consent on next launch, before anything else renders. |
| Supabase unavailable | Keep-alive ping missed the auto-pause window | Needs a retry action, not a dead end. |

#### 2.5.9 Account settings (global, §4.19)

Reachable from the Profile tab and, redundantly, from an avatar icon in the Event shell header. These are account-wide, not event-specific, so they aren't duplicated per event. Grouped list matching §4.19 exactly, with one deliberate exception in how Privacy renders.

**Do Not Publish is not a toggle, and it has a precondition.** Without an accepted reference (§4.2) the screen says what is missing, the confirm button stays disabled, and a link goes to reference photos. Otherwise the row shows its state ("Off"), because a plain switch implies a reversibility this action does not have. Tapping it opens a full explanation screen: the blur applies to every other viewer with no exceptions, it applies retroactively through reprocessing, and nobody can ever reverse it. A checkbox, "I understand this is permanent," gates the confirm button. Once active, the row becomes a static "Active" badge with no chevron and no tap target, because there is nothing left to toggle.

#### 2.5.10 Notification deep-links

Push-only. There is no in-app history screen; §6.2 defers a Notification Center.

| Channel | Guest / Photographer target | Admin target |
|---|---|---|
| Approval Alerts | Info only, no queue to view | Manage → Pending Approvals |
| Album Lifecycle | Home (Guest), My Media (Photographer) | Home |

A lightweight substitute for a full history: event cards on the global Events list carry a "new since last visit" dot, comparing a stored `lastViewedAt` against latest activity. This recovers most of what a notification center would have provided without rebuilding the feature that was cut.

---

## 3. Event lifecycle (end to end)
<!-- abstract: One event walked from creation through invitation, the event day, upload and processing, to the post-event album and retention windows. -->

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  [1] CREATION                                                               │
│      Admin creates event within the fixed duration cap → up to 15           │
│      sub-events → generates Guest Link + Photographer Link → generates      │
│      one Venue Check-In QR per venue, for physical posting                  │
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
- Forced Logout when the Supabase session ends, and Access Removed when the user is removed or blocked from an event, which the app learns from the API's 403 for that event (§2.5.8). Neither is a silent bounce to Login. There is no account suspension in v1.
- Multi-device login (the same account active on a tablet and phone simultaneously). The upload queue is stored in device-local SQLite and is therefore per-device: photos queued on a phone do not appear on a tablet. Each queued item, and each Local Only file, belongs to the account that created it, and a queued item uploads only under that account's session, so a shared phone never uploads one person's photos as another's.

---

### 4.2 User profile
- Full name and profile photo. No bio field (§6.1).
- Email address as the primary identifier.
- **Reference photos are separate from the profile photo.** A user may upload up to 5 reference photos of themselves for a stronger multi-angle reference embedding, and may do so without ever setting a profile photo. If a profile photo exists, it is also used as a reference. **Each must show exactly one face.** The worker checks within seconds of the upload and rejects a photo with none or several, and the app shows why, for several faces: "Multiple faces detected. Please upload a solo photo where only your face is visible." A profile photo that fails the check stays the avatar but is not used as a reference (D-91).
- **Do Not Publish needs an accepted reference to match on**, a reference or profile photo the worker accepted. Activation is blocked until one exists, and while Do Not Publish is active the last one cannot be deleted. Without one the pipeline has nothing to match, and the Settings row would read "Active" while protecting nobody (D-56, D-87).
- **Do Not Publish privacy flag.** Once enabled, this user's faces in uploaded photos are blurred for every other viewer, and their profile photo is replaced by a name-initial placeholder everywhere in the app, with **no exception for anyone, including the Admin**. Their *name* still appears where it is functionally required (Pending Approvals, Attendees list), because an Admin cannot approve a join request from an anonymous row. The image is what is hidden, not the identity.
- Profile photo can be updated at any time. Updating it does not retroactively change an already-active Do Not Publish reference set; use the reference photos for that.
- Account deletion is handled by contacting the team directly rather than a self-service flow. The full "My Data" dashboard is Future Work.

---

### 4.3 Event management
- Create event: name, type, cover photo, description.
- The event runs from its first sub-event's start to its last sub-event's end, capped at a fixed maximum (§4.17). No per-event tier selection.
- At least one and up to 15 sub-events, auto-ordered by start time.
- Verification radius configurable from 50m to 2km, default 200m.
- Album state (open / closed) is always a manual Admin action.
- Two role-specific invite links per event (Guest, Photographer), each a URL plus its own 6-character shortcode. No QR image. Both are revocable and regenerable.
- One Venue Check-In QR per venue. Sub-events at the same venue share it (§4.5).
- Admin can delay a sub-event by any amount of time.
- Delete event (soft delete, §4.21), archive event.

**Sub-event status, computed from timestamps:**

| Status | Rule |
|---|---|
| Upcoming | Now is before the sub-event's start time |
| **In Progress** | Now is at or after its start time and before its end time |
| Completed | Now is at or after its end time |

A sub-event ends at its scheduled end (D-88). Sub-events are planned across several days, and the host knows ahead of time when one will run late or move; the Delay action shifts one in under a minute. The event runs from its first sub-event's start to its last sub-event's end, so there can be stretches inside it when nothing is In Progress, and the capture FAB is hidden then (§2.5.4). If sub-event schedules overlap because the Admin set them that way, capture tags to the most recently started one.

---

### 4.4 Invitation & access control
- **Guest Link** and **Photographer Link**, each a distinct token carrying its own role assignment, so joining via a given link grants that role immediately with no separate role-change step.
- Manual role change remains available on the Attendees screen as a fallback, for someone who joined via the wrong link.
- Approval Modes: Auto-Approve All, or Approve New Users (manual review).
- Pending queue, bulk approve/reject, per-user block, revoke access at any time.
- Attendee list: searchable, filterable by role and verification status.
- **There is no role-based media visibility rule.** All uploaded photos are visible to all event members regardless of the uploader's role, so a role change has no retroactive effect on any photo (D-13). `uploader_role_at_upload` drives the Uploader filter and nothing else: no access control, no routing.

---

### 4.5 Location verification & attendance

This system is a **gate on uploading**, applied to the *person*, not the *photo*. It never blocks capture.

- **Granularity: per sub-event.** A verification record is scoped to one user and one sub-event. Verifying at the mehndi does not verify you for the nikkah.
- **The queue gate.** If a user is not verified for the sub-event a photo is tagged to, that photo sits in the local SQLite queue and does not upload.
- **On-device GPS check.** While the app is open, it periodically reads GPS and compares it against the active sub-event's cached coordinates and radius **locally**, without needing the network. A match flips the local queue to ready. Wedding venue connectivity is unreliable enough that requiring a round-trip before a guest can even start queueing would fail most of the time.
- **The server records, the client does not decide.** The client's local check is optimistic. When it passes, the device keeps that one reading with its time and sends it with the next pre-flight request (§4.8). The server checks it against the venue and the sub-event In Progress at that time, then writes the `VenueVerification` row. A tampered client can bypass the local gate, but it cannot manufacture a server-side verification record.
- **Photos carry no location.** Verification belongs to the person, so a photo taken with location off, or added from the gallery, uploads once its sub-event is verified (D-89).
- **Venue Check-In QR override.** If GPS is unreliable indoors, a Guest scans the QR printed at the venue. **This works offline**: the payload and the scan time are written to local SQLite and travel with the next pre-flight request. The payload names the venue, not a sub-event. The server checks the venue's secret and verifies the sub-event that was In Progress at that venue at the scan time, so a QR shared by the mehndi and the nikkah verifies only the one being held (D-85). Nothing is pre-cached; you cannot hold the secret of a QR you have not scanned.
- **Admin override.** Force Verify on the Attendee list sets `admin_verified_at` on that user's membership row, and the pre-flight check (§4.8.2) accepts it for every sub-event in the event, past and future. This is deliberately blunt: the Admin should be able to say "this person is fine, stop asking" once, not per session.
- **The device learns what the server decided.** The event response carries the user's verification state: `admin_verified_at` and the sub-events they hold a verification row for. The queue unlocks on either the local check or that state, and the app refetches it on foreground and on reconnect. Without this, a Force Verify, or a verification made on the user's other device, never reaches a queue the local check keeps shut.
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
- **A Public capture is also saved to the phone's gallery**, as the camera took it; the copy that uploads is the stripped one (§4.8.1). A Local Only capture is not saved there (§4.12, D-90).
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

**One pipeline for every role.** Guest, Admin and Photographer uploads receive byte-identical treatment (D-58).

- Rotate the pixels to match the EXIF orientation tag, then retain only the timestamp in EXIF and strip everything else, the tag and GPS included. The uploaded file is upright and says nothing about orientation, so the app and the worker agree on where every face box and blur region sits (D-99).
- Convert HEIC/HEIF, and any other format that is not JPEG, to JPEG, so every upload is `upload.jpg` (D-105).
- **No resize, with one guard.** Phone JPEGs are already 1 to 3MB. If the longest edge exceeds **4096px**, resize to 4096px preserving native aspect. This never fires on a phone photo; it exists so a DSLR file dragged in during a rehearsal does not surprise anyone.
- Generate a WebP thumbnail 300px on its long edge for the album grid (D-105). It is made from the unblurred photo, so it is served only for photos with no Do Not Publish face and no blur region; the worker writes blurred thumbnails for the rest (§4.13, D-69, D-83).
- Compute a **SHA-256 hash of the exact byte stream about to be uploaded**, after EXIF stripping and HEIC conversion. Never the thumbnail: WebP encoders differ across platforms and versions, so that hash is not reproducible (D-53).

#### 4.8.2 Stage 2 — pre-flight
- A single small JSON round-trip: content hash, sub-event ID, the photo's EXIF capture time (the pre-flight time stands in when it has none, D-98), and any verification records the device holds, a GPS reading or a Venue QR scan, each with its time (§4.5). The photo carries no location of its own. There is no album id; media belongs to an event through its sub-event (`docs/ARCHITECTURE.md` §2). No image bytes travel in it, the thumbnail included (D-69).
- **Membership and album state.** The caller must be an active member, the event must not be deleted, and the album must be open (§4.9). A closed album leaves the photo in the local queue, and the queue retries once the album opens (D-82).
- **Exact duplicate** (identical SHA-256 to a finished photo in the event, even one since deleted) is silently rejected, with no upload and no user-facing prompt (D-96). This is one indexed lookup, not a distance computation. There is no near-duplicate detection of any kind; anything that isn't byte-identical after processing uploads. **The one exception is the caller's own unfinished upload.** A row with this hash that the same user created and never completed gets fresh upload URLs for its existing keys, so a photo whose app was killed mid-upload resumes instead of vanishing (D-82).
- **Another user's unfinished upload of the same photo is not a duplicate.** Both upload, the first to complete wins, and the second completion is answered as a duplicate (D-96).
- **Verification and cap, for a new row.** `(VenueVerification row exists for this user and sub-event) OR (membership.admin_verified_at IS NOT NULL) OR (role = 'photographer')`. If verification fails, the upload is rejected and the photo waits in the local queue. Then the event must be under its 2,000-photo cap (§4.17), counted with the event row locked so two uploads at 1,999 cannot both pass (D-95). A resumed upload already passed both.
- If every check passes, Express names the upload keys and issues presigned R2 upload URLs for the photo and its thumbnail, which live 15 minutes (D-70, D-105).

#### 4.8.3 Stage 3 — upload
- Direct to R2 via the presigned URLs, one for the photo and one for its thumbnail. Express never proxies media bytes.
- Sequential, not parallel, per photo in a session, so most of a session stays cancelable from My Media.
- On completion the client notifies Express. Express checks that both files arrived in R2, then marks the row uploaded and enqueues the processing job via `pgmq` in one transaction. A repeated completion call enqueues nothing (D-82, D-95). A missing file sends the photo back to upload again.
- **Background behavior, bounded deliberately:** iOS uses `beginBackgroundTask` (roughly 3 minutes of continued execution after backgrounding); Android uses a foreground service with a visible sticky notification. Neither attempts to guarantee completion hours later or survive a force-kill. If the app is force-killed mid-upload, the local SQLite queue resumes the remaining items on next launch.

---

### 4.9 Album

The album is a single shared view for every Guest and the Admin. Everyone sees the same photos with the same grouping and filtering controls, including the Photographer's uploads. The Photographer is the only role that cannot read it.

#### Shared album
- Grid view, grouped by sub-event and date, not by uploader.
- Two-tier filtering (full UI spec in §2.5): an always-visible sub-event chip row for time-based filtering, plus a separate People / Uploader filter sheet behind a funnel icon for identity-based filtering. These are deliberately not the same control; stacking them as look-alike chips would hide that they filter different dimensions at different frequencies. An active People/Uploader filter shows as a dismissible pill above the grid and stacks with an active sub-event chip.
- Lazy loading with progressive placeholders: 300px WebP cached via `expo-image`, display resolution on open.
- **A media row is not album-visible until processing completes.** The album query filters on `processed_at IS NOT NULL`. Until the worker finishes, the photo is visible only to its uploader in My Media, carrying a spinner badge. Keyed off upload completion instead, an unblurred photo would sit in the shared album for the length of the worker backlog. Say out loud that "a photo appears within seconds" holds when the queue is empty and degrades under a burst (D-55).
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

**On the asymmetry.** A Photographer contributes to something they cannot see, on purpose (§2.2, D-08). They already hold every frame on their own cards, so what they lose is browsing other people's photos, which is what the role exists to prevent. A web uploader for the realistic 800-frame case is Future Work (§6.2).

---

### 4.11 AI media intelligence

#### 4.11.1 Deduplication
SHA-256 over the exact byte stream the client uploads (§4.8). An exact match is rejected at pre-flight, silently, before any file transfer. This is a single indexed lookup in Express and is not a worker job.

#### 4.11.2 Face detection & embedding, the shared foundation
- **One detection pass per photo, on the uploaded file.** A face embedding is extracted for every detected face in every uploaded photo at processing time, regardless of whether that person is a registered user, a Do Not Publish user, or a complete stranger to the app. This is identity-agnostic; the network converts a detected face into a comparable vector without knowing who it is looking at. Everything downstream is a cheap similarity search against this already-computed data, not a re-run of detection.
- **The worker records each photo's pixel width and height on the media row** during this pass. It is already opening the file, and the columns are what a masonry grid would need without a backfill against R2 (D-22). Blur correctness does not depend on them.
- **References.** A user may upload up to 5 reference photos of themselves, and their profile photo is used as a further reference if it exists, for six in total (§4.2, `docs/ARCHITECTURE.md` §2). Each must show exactly one face (D-91). Matching and Find My Photos use every accepted reference. No reference is ever added automatically (D-83).
- **Detection is not re-run on the blurred output.** The Recognized Faces list comes from the single detection pass, with a viewer-scoped filter applied at read time (below). Detectors find heavily blurred heads, so a second pass would not have excluded anyone (D-29).

#### 4.11.3 Face recognition: named & unknown clustering
- **Find My Photos**: one tap, using the reference embeddings already on the user's profile. If they have neither a profile photo nor reference photos, they are prompted to add reference photos in Settings.
- **Recognized Faces strip** on a single photo: every detected face is matched against known reference embeddings. Matches get the person's name; non-matches are clustered against each other and shown as "Unknown," consistently the same Unknown identity across multiple photos of the same unregistered person via embedding-similarity clustering. Expect this bucket to be less precise than named matching, since there is no curated reference to check it against.
- Tapping any face, named or Unknown, filters the album to every photo containing that person. Note that this makes the app a face-search index over people who never installed it; §8 states that limitation plainly rather than burying it.
- **The Do Not Publish filter is viewer-scoped, not global.** A face matched to a Do Not Publish user is hidden from the Recognized Faces strip and the People filter (§2.5.2) for every viewer *except that user themselves*, who sees their own face listed normally. No other viewer can filter the album by that person.

  This distinction is load-bearing and easy to get wrong. A global exclusion would mean **Find My Photos returns nothing for a Do Not Publish user**, so the one person who most needs to audit which photos contain them would be the one person who cannot search for them. It would also break the correction path below, which assumes the subject can navigate to photos containing themselves. Implement the filter as a predicate on the read, parameterized by the requesting user, never as a hard exclusion at write time.
- Find My Photos therefore works normally for a Do Not Publish user, and is the practical way they audit for missed matches.

#### 4.11.4 Do Not Publish: personalized face blurring

This is the app's centerpiece feature and it is core scope, not a stretch goal.

##### 4.11.4.1 Activation and the files generated per photo

**Activation requires an accepted reference** (§4.2, D-56, D-87).

**What is generated per photo.** For a photo containing N Do Not Publish subjects, the worker writes N+1 files:

| File | Contents | Who receives it |
|---|---|---|
| `public` | Every Do Not Publish face in the photo is blurred | Everyone except the subjects |
| `variant_<subject>` | Every Do Not Publish face blurred **except** that one subject's | That subject only |

The count is linear, never combinatorial, because no viewer ever needs two different subjects unblurred in the same file. A photo with no Do Not Publish face and no blur region produces no extra files at all: the uploaded file is what everyone sees. Each of the N+1 files also gets a blurred 300px thumbnail at a versioned key, written by the worker. For a photo with no Do Not Publish face and no blur region, the client's own thumbnail is the one served (D-69, D-83).

##### 4.11.4.2 Serving, and the self-visible marker

**Serving is one endpoint, and the client never chooses.** A request for a photo's image hits an endpoint that checks whether the requester is a Do Not Publish subject in that photo, then mints a short-lived presigned R2 URL for the correct file. Viewing and downloading use the same mechanism, so there is no compositing step anywhere in this system. D-57 records the crop-and-overlay design this replaced.

**The self-visible marker, which is not optional.** When a Do Not Publish subject views a photo they appear in, a small lock badge renders on the image and the metadata overlay reads "Your face here is visible only to you." Without it, a subject seeing their own clear face cannot tell "personalized blur is working" from "the match failed and 300 guests can see me," and every missed match becomes a permanent privacy failure nobody can report (D-26). The serving endpoint says, with each URL, whether the file is the requester's own variant, and that flag is what draws the marker; the app never learns who the subjects are (D-86). It is a static badge, not a box over a crop, so zoom cannot move it out of place.

##### 4.11.4.3 Blur geometry and strength

**Blur geometry and blur strength are specified, not left to whoever writes the worker.**
- **Expand the detection box by 30 to 40 percent and apply an elliptical mask.** A tight InsightFace bounding box leaves hair, ears, jawline and clothing visible. At a wedding where the guest list is known, that is still identifying.
- **Downsample then upsample, with a box blur on top.** A single light Gaussian pass is partially invertible. Downsampling discards information for real. This is an answerable viva question and it costs one line in the worker.

##### 4.11.4.4 Correcting a missed match

**Automatic matching blurs a close match and nothing else.** A face that matches a Do Not Publish subject at or above the match threshold is blurred for everyone else. Below it, nothing is blurred automatically and nothing goes to the Admin: at a wedding of relatives a loose match is usually a cousin, and a queue of them would flag almost everyone against someone (D-83).

**A missed face is fixed with a blur region.** Any Guest or the Admin can draw a rectangle over part of a photo in the album, most often a face the detector never found or matched too loosely. It applies at once for every viewer, in the public file, every subject's file and all their thumbnails, and it is stored, so every later regeneration keeps it (root invariant 6). A Do Not Publish subject finds such a face with Find My Photos, by looking for photos of themselves without the self-visible marker (§4.11.4.2).

**Removing one restores what was there.** The person who drew a region can remove it, and the Admin can remove any, from the photo or from the Review Queue (§2.5.7). The privacy-preserving state is the default and removal is the fallback (D-24).

**What this gives up.** Nothing checks who is being hidden: any Guest can blur the bride out of a photo until its drawer or the Admin removes the region. That is accepted, because a missed blur is the costly failure and the Admin sees every region in one list. A per-user cap is designed and deferred (§6.2, D-64).

##### 4.11.4.5 Retroactive reprocessing

**Retroactive reprocessing is a match job, never a detection job.** Enabling Do Not Publish after photos are already published triggers asynchronous reprocessing. That job compares the **stored embeddings** for every face already on record in the event against the newly-active reference set, which is milliseconds of cosine comparison. Then, for every photo whose set of Do Not Publish subjects changed, it regenerates the public file, every subject's file in that photo and all their thumbnails, with every stored blur region, at the next `variant_version`. A subject who was already in the photo gets a new file too; their old one still shows the newly protected face. Photos whose subjects did not change are left alone. It never re-runs face detection, because every face in every photo already has an embedding from its original processing pass. Re-running the model would be the expensive version of a job that is nearly free.

**Other properties:**
- Every uploaded photo is checked against the reference sets of **users who are active members of this event**, not globally. The system cannot protect anyone who has not installed the app and uploaded a reference (§8).
- **Joining an event triggers the same job.** A user with references who becomes an active member is matched against the photos already in the event. Otherwise a Do Not Publish user who joins late stays unblurred in every earlier photo, and Find My Photos misses them all (D-84).
- Matching is biased toward blurring when uncertain: the match threshold is set low, since a missed match is the costly failure. This bias will produce false positives, particularly among relatives who resemble each other. A person missed in error is fixed with a blur region once someone notices; a person blurred in error stays blurred (§8).
- **Do Not Publish itself is permanently irreversible**, for anyone, self-service or Admin-assisted. A blur region is a different object: its drawer or the Admin can remove it (§4.11.4.4). Do not conflate the two in the UI copy.
- **What the system guarantees: no viewer ever receives a file in which a Do Not Publish face other than their own is unblurred.** A subject's own variant can be byte-identical to the uploaded file, when they are the only subject in the photo and it has no blur region (D-27, D-83).

---

### 4.12 Local Only mode

Renamed from "Private mode," which saved to the camera roll, the most publicly synced place on the phone (D-34).

- Local Only is a device-local sandbox for media captured with the Viewfinder's toggle set to Local Only, and for public queued uploads the user cancels before completion.
- Files are written to the **app's own sandboxed storage**, its document directory through `expo-file-system`, not the camera roll. That package's API changed in SDK 54, so build from the SDK 57 page rather than the `FileSystem.documentDirectory` name in D-34. This is not indexed by MediaStore on Android or the Photos library on iOS, and the do-not-backup flag is set on iOS so it does not sync to iCloud.
- The tradeoff, which must be stated in the UI at the moment of first use: these files do not appear in the device gallery, and they are deleted if the app is uninstalled.
- My Media acts as the viewer for these files, so the user doesn't have to leave the app to see what they took.
- Local Only captures never touch the network, deduplication, or location verification. They are still subject to the time-based FAB rule (§4.7), because that gate is on the capture entry point, not on the mode.
- A Local Only file cannot be converted to Public. It lives in the app sandbox, so the device image picker behind "+ Add Media" cannot see it either. The first-use notice says so.
- Local Only files belong to the account that captured them (§4.1), and My Media shows each account only its own.

---

### 4.13 Media delivery
- WebP thumbnails 300px on the long edge via `expo-image`, center-cropped to square when the grid draws them, for uniformity across mixed-aspect sources (D-105). They are served through the same endpoint as full images and follow the same personalization and versioning rules (D-69).
- **There is one image per photo.** The file that was uploaded is the file that is served, zoomed, downloaded and blurred from (D-58).
- **Every image request goes through the serving endpoint in §4.11**, which checks whether the requester is a Do Not Publish subject in that photo and mints a presigned R2 URL for the correct file. Do not wire an image component or a download button directly to a bucket URL; personalization silently stops working for exactly the people it exists for, and nothing throws an error when it does.
- **Blur variant object keys carry a version, and the version lives on the media row.** Retroactive Do Not Publish and a blur region both regenerate the public file. With a stable key, every client that already loaded the photo keeps serving the pre-blur image out of its `expo-image` disk cache, and no test written against a fresh client notices (D-60). Key shapes are in `docs/ARCHITECTURE.md` §3. `variant_version` is bumped on every regeneration and the Realtime row update carries it, so a client with the photo on screen asks for it again.
- Presigned URLs live one hour. `expo-image` caches under the key the serving endpoint returns with each URL, which is built from the object key it signed plus `variant_version`, so a rotating URL does not defeat the cache and two accounts on one phone never share a cached file. Logging out clears the image cache (D-86).
- `uploader_role_at_upload` is display and filter metadata only (§4.4).
- No video playback surface. There is no video anywhere in the app.

---

### 4.14 Offline mode
- Cached on first load: the schedule, sub-event and venue details including coordinates and radius, and the thumbnail grid.
- Capture and the local upload queue work fully offline. Queued items run their full pre-flight and upload sequence once reconnected, taking along the GPS reading or QR scan the device recorded for verification (§4.5).
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
| Album Lifecycle | Album open/close, visibility window ending, event archived or deleted |

The visibility-window warning needs the scheduled retention job (§4.21), which no demo beat uses (D-44), so the demo build sends Album Lifecycle for album open and close and for an event archived or deleted.

These are the only two channels. Schedule Changes and Upload Activity notifications are stretch goals (§7); they add build cost with minimal demo presence. There is no Sub-Event Reminders channel (RSVP and reminders are cut) and no Check-In Confirmation channel (verification is silent; there is nothing to confirm in the moment).

---

### 4.17 Limits (hard-coded, no subscription system)

There is no `PlanTier` concept in v1. Subscriptions are entirely Future Work (§6.2). In their place, fixed constants are hard-coded into the app and API, with no user-facing limit UI, no upgrade flow, and no per-event selection:

- Maximum event duration: **14 days**, from the first sub-event's start to the last sub-event's end (D-88). This is a *duration* cap, not to be confused with the unrelated 14-day event soft-delete window in §4.21
- Maximum guest count per event: **150**
- Maximum upload count per event: **2,000**
- Maximum sub-events per event: **15** (§4.3)
- Maximum reference photos per user: **5**, not counting the profile photo (§4.2)

These are safety rails against a runaway event, not a monetization mechanism. 150 guests leaves headroom under the Supabase free tier's 200 concurrent Realtime connections (D-33). The API enforces each one where it can be crossed: duration whenever a sub-event is added, edited or delayed, guests when a join is approved, uploads at pre-flight (§4.8.2), sub-events when one is added, references when one is uploaded.

---

### 4.18 Privacy & consent management
- Explicit consent screen right after signup, before anything else renders. Consent is recorded per account (`docs/ARCHITECTURE.md` §2), so it needs the account to exist. It covers:
  - Account creation and basic profile data retention.
  - **Face detection and processing**, stated accurately: every face in every uploaded photo is detected and converted into an embedding, including faces belonging to people who are not app users, in order to support Find My Photos and Do Not Publish blurring.
  - The permanent, non-reversible nature of Do Not Publish.
- Consent version tracking: if the Privacy Policy materially changes, all active sessions are paused on next launch until the new version is accepted.
- **Accurate metadata statement.** GPS, camera model, and device serial are stripped from the image file before it leaves the device. One GPS reading per sub-event, taken when the device's check passes, travels to the server for verification only, is checked against the venue, and is stored nowhere. Photos carry none (D-89). Never claim that GPS does not reach the network (D-36).
- Blur transparency: a user viewing a blurred face can tap a small info icon explaining why ("This person has requested privacy"), which reduces confusion about whether the image is simply failing to load.
- The full "My Data" dashboard remains Future Work.

---

### 4.19 Settings & preferences
- **Account:** update profile photo, manage reference photos (up to 5, and never the last accepted one while Do Not Publish is active, §4.2), request account deletion (contacts support; no automated workflow yet), change password, log out.
- **Appearance:** theme (Light / Dark / System Default).
- **Notifications:** push toggles for **Approval Alerts** and **Album Lifecycle**. These are the only two channels that exist (§4.16); earlier versions of this document listed four toggles for two features.
- **Upload:** "Upload over Mobile Data" toggle (default on; phone JPEGs run 1 to 3MB and upload without resizing, §4.8); default Viewfinder mode (start Public vs. start Local Only).
- **Privacy:** Do Not Publish activation, rendered as described in §2.5.9, one-way, and blocked without an accepted reference (§4.2).
- **Storage:** clear local image cache; storage usage breakdown (app size vs. cache vs. Local Only files).
- **About & Legal:** Terms of Service, Privacy Policy, Open Source Licenses, app version and build number.

---

### 4.20 Deployment & hosting

The current layout is `docs/ARCHITECTURE.md` §7 and the walkthrough is Handbook §13. What the spec commits to, and what the viva will ask about:

- **One Netcup server runs development and the demo** from 15 October 2026, so the latency the panel sees is the latency the team measured (D-78). Development uses the dev Supabase project. The demo stack, against the stable project, goes up on the same server one month before the demo (D-76). The M1 is a development machine only.
- **The server removes the laptop, not the network.** Supabase, R2 and the judges' phones still need campus WiFi, which is why §9's fallback is a recording rather than a seeded remote dataset (D-62).
- **No Docker and no tunnel.** Express and the worker run as systemd units behind nginx, with a certbot certificate on a stable hostname, set up on Ubuntu 24.04 by `scripts/provision.sh` (D-39). Dependencies are pinned in `pnpm-lock.yaml` and an exactly pinned `requirements.txt`.
- **Supabase** runs two projects, dev and stable, which is the free tier's limit. **Cloudflare R2** holds under 500MB against 10GB free, so storage is not a design constraint (D-49). The keep-alive runs from GitHub Actions, not from the server it protects (D-67).
- **Standby:** the team's Azure for Students, AWS and GCP credits, in that order, with a VM created only for the Phase 7 rehearsal and for demo week (D-79).
- **The worker** is a pgmq consumer with the InsightFace model resident from startup (D-40). The Phase 0 spike passed on ARM64 and on the M1 on 2026-09-15. Rerun it on the x86-64 server the day it is provisioned.

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

One table per area, so a slice cites the part it needs.

### 5.1 Joining and access

| Scenario | System behavior |
|---|---|
| Invite link expired or revoked | Clean error screen: "This link has expired or been revoked. Contact the event organizer." |

### 5.2 Location verification

| Scenario | System behavior |
|---|---|
| User not verified for the active sub-event | Upload does not proceed. Photos wait in the local queue. Banner offers "Scan Venue QR" and "Ask the organizer to verify you." |
| Guest scans the Venue QR, offline | Scan recorded locally; travels with the next pre-flight on reconnect, then the queue flushes. |
| Admin taps Force Verify, or the user verifies on another device | `admin_verified_at` or the verification row is set on the server. The device learns of it the next time it fetches the event, on foreground or reconnect, and every queued photo it covers unlocks (§4.5). |
| User never gets verified at all | Photos remain in the local queue indefinitely and are visible in My Media with a clock badge. They are not lost, and they are not uploaded. The user can delete them locally. |

### 5.3 Sub-event timing

| Scenario | System behavior |
|---|---|
| A sub-event runs past its scheduled end | It completes at its scheduled end and the capture FAB hides, unless the Admin delays it (§4.3). Photos taken with the phone's own camera can still be added to it through "+ Add Media". |
| No sub-event is In Progress, inside the event's span | The capture FAB is hidden. Gallery imports into any sub-event section still work (§2.5.4). |
| Sub-events overlap because the Admin scheduled them that way | Capture tags to the most recently started one. |

### 5.4 Uploads and the queue

| Scenario | System behavior |
|---|---|
| Exact duplicate detected (identical SHA-256 of the uploaded bytes) | Silently rejected before any file transfer. No prompt. |
| A photo is deleted by its uploader or removed by the Admin | It leaves every album at once. The Admin can restore it from the Review Queue for 30 days (§4.21). |
| Upload succeeded but the worker has not processed it yet | The row exists with `processed_at` null. Visible only to the uploader in My Media with a spinner badge, never in the shared album (§4.9). |
| Photographer uploads at 2am from home | Proceeds. Photographers are exempt from the location gate, and are otherwise handled by the same single upload pipeline as everyone else (§4.8). |
| A file larger than 4096px on the longest edge is added via "+ Add Media" | Resized to 4096px client-side before upload. This never fires on a phone photo (§4.8). |
| Photographer uploads after their sub-event ends, while the event is still open | Normal case, and the intended workflow. The photographer shoots the walima, uploads that night, and notifies the Admin out of band. The Admin closes the album once satisfied. Album state is per event, not per sub-event, so a completed sub-event never blocks an upload. |
| Photographer uploads after the Admin closed the album | Blocked, same as any role. The Close Album confirm dialog (§4.9) names any Photographer who has uploaded nothing yet, specifically to prevent this. |
| Any user tries to upload while the album is closed | Upload disabled with a clear banner. Applies to Admin too, who is prompted to open the album first. Pre-flight rejects it as well, so a modified app gets nowhere (§4.8.2). |
| The album closes while photos are queued | They stay in the local queue and upload if the Admin reopens the album. |
| A guest re-uploads a photo that was deleted from the album | Rejected as a duplicate, with no prompt. A deleted photo's bytes cannot come back except through Restore (D-96). |
| Two guests upload the same photo and one of them crashes mid-upload | The other's upload is not blocked. Whoever completes first wins, and the other is treated as a duplicate (D-96). |
| The event reaches its 2,000-photo cap with photos still queued | Each one stays in My Media with "This event is full" and never uploads. The person can delete it (D-97). |
| A user with queued photos is removed or blocked | The app shows Access Removed, and the queued photos stay on the phone, stopped, until the membership is active again (§4.1, D-102). |
| App force-killed mid-upload | The local SQLite queue resumes the remaining items on next launch. A photo that had passed pre-flight resumes on its existing row instead of being rejected as its own duplicate (§4.8.2). No attempt at guaranteed background completion. |

### 5.5 Do Not Publish and blur

| Scenario | System behavior |
|---|---|
| A user with no accepted reference tries to enable Do Not Publish, including one whose reference photo is still processing or was rejected | Blocked. The confirm button stays disabled and the screen links to Add Reference Photos (§4.2). |
| A Do Not Publish user tries to delete their last accepted reference | Refused, with the reason. Deleting it would leave the flag protecting nobody (§4.2). |
| A reference photo shows no face, or several | Rejected within seconds of the upload, with the reason. For several faces: "Multiple faces detected. Please upload a solo photo where only your face is visible." (§4.2) |
| Do Not Publish match confidence is borderline at upload | At or above the match threshold, which is set low on purpose (§4.11.4.5), the face blurs. Below it nothing blurs automatically and nothing reaches a human; anyone can draw a blur region over it (§4.11.4.4). |
| A Do Not Publish face is missed, by matching or by detection, and someone notices | They draw a blur region over it. It applies at once for everyone, and its drawer or the Admin can remove it (§4.11.4.4). |
| Someone enables Do Not Publish after 100 photos are already in the album | The reprocess job compares stored embeddings against the new reference set. For each photo whose set of subjects changed, it regenerates the public file, every subject's file and all their thumbnails, not only the new subject's, and bumps `variant_version` so clients holding a cached copy re-resolve (§4.11, §4.13). Detection is never re-run. |
| Someone draws a blur region over another person to hide them | It applies. The Admin sees it in the Review Queue, with who drew it, and removes it (§4.11.4.4). |
| A photo with a blur region is reprocessed | The region is applied again. No regeneration drops it (root invariant 6). |
| Photo uploaded before a Do Not Publish flag is activated | Existing photos are reprocessed asynchronously to blur that face. |
| A Do Not Publish user joins an event that already has photos | Joining triggers reprocessing for that user in that event, so earlier photos blur the same way (§4.11.4.5). |

### 5.6 The event and the service

| Scenario | System behavior |
|---|---|
| Admin deletes event mid-event | Attendees notified, 14-day soft delete, download still available. |
| Supabase free-tier project auto-pauses after inactivity | Mitigated via a scheduled keep-alive ping. Surfaces a clear "temporarily unavailable" state with a retry action if it happens anyway. |

---

## 6. Deferred & out of scope

### 6.1 Not planned (permanently out of scope)
Reverting Do Not Publish. Face-recognition opt-out. i18n. User bio. Captioning. Feed view. RAW file handling.

### 6.2 Future work (post-FYP roadmap)
- **Video support**, including face blur for video, which is materially harder than the photo case because it requires tracking a face across frames rather than detecting it once.
- **Subscription tiers and payment processing**: the full `PlanTier` structure, guest/upload/duration enforcement, and a website-redirect-and-verify payment flow.
- **Sub-event visibility groups.** A `restricted` flag on a sub-event plus an access join table, so that, for example, mehndi photos are visible only to a named subset of attendees. Cut because there is no reliable way to auto-populate such a group and manual group construction is its own feature. The schema is cheap to retrofit; the rule is one more AND clause in the API's media check and in the `media` policy.
- **Retroactive per-sub-event verification requests.** A user asking the Admin to verify them for a sub-event that has already passed. Replaced in v1 by the blunt Force Verify, which covers everything at once.
- **Proxy Blur: Do Not Publish for someone who has no account.** A guest who never installed the app has no reference embedding, so there is nothing for the pipeline to match on and no remedy for her at all today (§8). The design: the woman hands the host one clear photo of herself, which is the consent act. The Admin goes to Manage → Attendees → "Add blur request for a non-user," enters a display name and that photo, and the system creates a **subject row with a reference embedding and a Do Not Publish flag but no linked auth user**. Existing photos reprocess and future photos are checked through the pipeline that already exists. She cannot view herself unblurred, because there is no account to authenticate as, and that is correct: she asked for invisibility, not access. **Admin-only**, because if any guest could file one, somebody would upload the bride's face and blur the entire album, and the Admin has a direct personal incentive to keep his own wedding album usable.
  - **The schema split happens now** even though the feature is deferred: `subject` is its own table with a nullable foreign key to the auth user (D-63).
  - **The contradiction it raises**, that the Admin gains power over somebody else's face, has its answer in D-63: every Admin power points toward privacy.
- **Blur region rate limiting.** Each blur region applies immediately, so nothing in v1 stops one user drawing many and leaving the Admin a list to remove one at a time. The design: cap at 10 regions per user per event, mark the user each time the Admin removes one of theirs, and disable drawing for that user after two removals. A counter column and one conditional. Deferred because the abuse requires a volume of adversarial users this project will never see, not because the fix is expensive (D-64, D-83).
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

**The app builds a face index over people who never consented to one, and that is a real cost, not just a caveat.** Every detected face is embedded, and unregistered people are clustered into a persistent "Unknown" identity that any event member can tap to filter the album to every photo containing them. Consent for that processing comes from the uploader, not the subject, which under a strict reading of biometric-data rules is the app's most exposed area. The usual comparison, that a bounded album with an expiry date and stripped metadata beats two hundred phones and a dozen WhatsApp groups, holds on distribution, retention and metadata. It does **not** hold on face indexing, where this app does something WhatsApp does not. Say both halves. The mitigations are real but partial: face embeddings belong to one event's photos, are never exported, and a subject can act on their own face through Do Not Publish. The retention job that would delete them with the event is not built in v1 (§4.21, D-44).

**Downloads defeat every in-app privacy control.** Any Guest can download a photo and forward it, and v1 places no restriction on that beyond requiring event membership. The blur guarantee protects the app's own surface, not the world. The honest framing: the visibility window limits how long the album stays reachable, and it does nothing about copies already made.

**False-positive blurs will happen.** Matching is biased toward blurring, and South Asian weddings feature many related people in similar attire under poor lighting. Some faces will be blurred that shouldn't be. A blur region fixes the opposite error; a false-positive match currently has no fix at all.

**The similarity thresholds are measured on the team's own faces.** They are calibrated against roughly 30 photos of three people in varied lighting, which is a small and unrepresentative sample. Volunteer this rather than waiting to be asked: the numbers would need recalibration against a real guest population, and quoting a threshold the team has not measured is worse than describing the mechanism without one.

**The verification gate is bypassable in principle.** The GPS check runs on-device for offline usability. The server re-validates and is the authority on the verification record, but a determined attacker with a modified client and a spoofed GPS reading can still upload. This is a UX gate, not a security boundary.

**The Photographer link is a broad grant.** It bypasses location verification and uploads straight into the shared album from anywhere. Treat it as a credential, and revoke it after the event.

**A missed match is only found by the subject noticing.** There is no automated audit. A Do Not Publish user checks whether the system caught them by using Find My Photos and looking for the self-visible lock marker on each result, then draws a blur region over any face it missed. That works, and it is the reason the recognition filter is viewer-scoped (§4.11), but it is manual and it depends on the person actually looking.

**Any Guest can blur any part of any photo** until its drawer or the Admin removes the region. Nothing checks whose face is being hidden; the Admin catches abuse by looking at the Review Queue (D-83).

**The upload queue is per-device.** Multi-device login is supported, but photos queued on one device are not visible on another.

---

## 9. The demo script

Roughly 30 minutes, a university classroom, 3 team members and 3 to 4 judges, campus WiFi, GPS verified in a rehearsal one week earlier with a generous verification radius set on the demo event.

Reverse-engineer scope from this list. **If a feature does not appear here, it is not core scope**, and you should be able to say that out loud without flinching.

### Before the room: what has to already be true

**Devices.** The app is not on any store and there is no deferred deep link (§4.1), so it cannot arrive on a stranger's phone during the demo. Judges use **team-owned Android devices handed around**, with the build installed and the accounts signed in at least a week ahead. If a judge wants the app on their own phone, that is an Android APK sideload arranged in advance, never on the day. iOS is not a demo path: TestFlight needs an Apple review pass and invited testers, and ad-hoc provisioning needs UDIDs collected beforehand.

**Backend.** The API and worker run on the Netcup server the team developed against, on its stable hostname (§4.20). The demo stack against the stable project has been up for a month (D-76).

**Pre-configured accounts.** Do Not Publish is enabled beforehand on one team account, used in beats 5 and 6. Never ask a judge to enable it; the action is permanently irreversible for anyone.

**Seeded dataset**, roughly 100 photos, loading in ten seconds.

**Offline fallback.** A recorded walkthrough of the full script on local storage, on a USB stick and on a laptop that is in the room. The seeded dataset lives in Supabase, so a total network failure takes it too. This costs an afternoon and will probably never be used.

### The beats

1. **Create the event.** Two sub-events, one currently live. Show the Guest Link and Photographer Link, and the printed Venue QR.
2. **Judges join.** Two judges open or paste the Guest Link on the handed-around devices and land in the album. This is where deep links, auth, and role assignment all prove themselves at once.
3. **Capture and upload.** A judge takes a photo. Location verifies silently; the photo appears in the shared album on every device within seconds once the worker finishes and the row becomes visible (§4.9). Then show the queue gate: deny location permission, clear it with a Venue QR scan.
4. **Find My Photos.** A judge with reference photos set taps once and sees only the photos they appear in.
5. **Do Not Publish.** Use the pre-configured team account. Walk them through the consent screen without confirming it, including the reference-photo precondition (§4.2), then hand phones around: the subject sees their own face clearly with the lock badge and "visible only to you," every other phone shows it blurred. This is the moment the project earns its grade.
6. **A missed face.** Use a **pre-seeded photo where the detector genuinely misses the subject's face**, turned away or partly covered, so the miss is real and reproducible. Do not try to manufacture a miss live, and do not ship code that fakes one. The subject draws a blur region over it, and it updates on the other phones.
7. **Admin restore.** A judge draws a blur region over the Admin's face in another photo. The Admin opens the Review Queue, sees who drew it, and removes it, and the face is back on every phone. Short beat, and it shows why a region anyone can draw is acceptable: nothing stays hidden without the Admin seeing it.
8. **Photographer delivery.** A team member on the Photographer account uploads two photos from the gallery, with no location verification, through the same pipeline everyone else uses. They appear in the shared album alongside everything else. Show that the Photographer's own app cannot browse the album.
9. **Close and export.** Admin closes the album, the confirm dialog reports whether every Photographer has uploaded, upload controls disable everywhere, and a judge multi-selects three photos and saves them to their camera roll.

### Two answers to have ready, because they will be asked

**"Why a paid server, and not the free tier or a laptop?"** One server ran development and runs the demo, so what the panel sees is what the team built and tested against. On 23 wedding and group photos, a 2-core free-tier ARM server took 3.5 times as long as an M1 laptop, and a laptop in the room is a single point of failure that still needs the network. Four dedicated cores cost about €15 a month. Quote the numbers in D-78, including the benchmark run on the server itself, and be ready to SSH in and show the systemd units.

**"What are your thresholds?"** Give the measured number and the date it was measured, or describe the mechanism without a number. Never quote the example values that appeared in earlier drafts of this document.
