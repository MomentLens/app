# MomentLens decision log
> Why the system is the way it is.

## How to use this file

Every entry records a decision, the reasoning behind it, and **what was rejected and why**. That last part is the point. A decision without its rejected alternatives gets re-argued every few months by whoever forgot, and it cannot be defended in a viva, because examiners ask why you did not do the other thing.

Each entry has a **Reopen if** line. That is not permission to reopen casually. It is the specific condition that would make revisiting rational. If that condition has not occurred, the decision stands and the discussion is over.

**Rules for this file.** Append, do not rewrite. If a decision is reversed, add a new entry that supersedes the old one and mark the old one, rather than editing history. When you make a decision that is not here, add it the same day, while you still remember the alternative you rejected. New entries are headed `### D-nn: Title`. Mark a retired one by adding `~~(SUPERSEDED by D-nn)~~` or `~~(VOID, see D-nn)~~` to its heading, the only two forms `doc` masks (Handbook §18.7).

**Superseded and void entries keep their text.** The heading says which entry replaced them, and `doc` never expands one into a brief. Their reasoning is still worth reading, because the reason a decision stopped applying is itself an answer in a viva.

Entries marked ⚠ are ones where the team knowingly accepted a risk. Know these cold before your defense; they are the most likely questions.

---

# A. Scope and product

### D-01 — Personalized face blur is core scope, not a stretch goal
**Decision.** The Do Not Publish subject sees their own face unblurred while everyone else sees it blurred, and this extends to downloads via server-side compositing.
**Why.** It is the project's technical centerpiece and the single feature that distinguishes it from a shared Google Photos album. Everything else in the app is competent CRUD.
**Rejected.** The v9.1 baseline, where the subject also saw themselves blurred. Simpler to build, but it produces a demo where the interesting thing is invisible: every phone in the room shows the same image, so there is nothing to hold up and compare.
**Cost.** The most technically involved feature in the app.
**Amended (see D-57).** The original cost line read "retained originals, per-face access-controlled crops, a client overlay, and an authenticated download path." Three of those four are gone. Pre-generated per-subject variants replaced the crop-and-overlay design, so the cost is now one extra file per subject per photo and one authorization check on the serving endpoint.
**Reopen if.** Phase 5 runs long enough to threaten the Phase 7 buffer. The fallback ladder in Handbook §14 is the graceful way down.

### D-02 — Sub-event visibility groups are cut ⚠
**Decision.** No per-sub-event restricted albums in v1. Deferred to Future Work with the schema noted as cheap to retrofit.
**Why.** There is no reliable way to auto-populate a group. The obvious use case, restricting mehndi photos to women who were in the room, requires either asking gender at signup, which is not acceptable, or having the Admin hand-build a group of 80 people, which is its own feature.
**Rejected.** Building it anyway. It was argued for on the grounds that it is roughly a column plus an RLS clause, that it matches what South Asian wedding guests actually want, and that it cannot fail live the way an ML pipeline can. That argument was heard and declined on the grounds that manual group construction is a rabbit hole and the schedule cannot absorb both this and D-01.
**Cost.** The app's privacy story only protects people who install it and opt in (see D-30). The thing many guests actually want, room-level rather than face-level control, is absent.
**Reopen if.** Personalized blur ships early and the Phase 7 buffer is genuinely intact. This is the highest-value item on the stretch list if that happens.

### D-03 — Burst grouping and best-shot selection stay a stretch goal
**Decision.** Not core scope.
**Why.** It was briefly promoted, then cut, when it became clear the additions in one planning pass exceeded the removals. The algorithm is nearly free, since InsightFace already returns the landmarks needed for an eye-aspect-ratio check and Laplacian variance is trivial. The cost is entirely in the album UI: a stack cell, an expand interaction, and a re-crown control.
**Rejected.** Shipping it in core. Rejected because it is the only feature that would justify keeping perceptual hashing (D-20), and because it competes directly with D-01 for the same weeks.
**Reopen if.** Phase 7 has real slack after the blur pipeline is tested. It is the most demo-friendly item remaining on the stretch list.

### D-04 — Full-album ZIP export is out; multi-select download is the primary export
**Decision.** Users select photos and save them to the device gallery. No ZIP in v1.
**Why.** ZIP was the one feature in v9.1 with no architecture behind it. Generating an archive of a full album means streaming every byte through the compute instance, which violates the rule in Handbook §7 that media never routes through Express, on the one box the whole system depends on.
**Rejected.** Building it on the VM (would time out or exhaust memory) and building it client-side (worse on mobile). If it returns, the correct shape is a Cloudflare Worker streaming a ZIP directly from R2, which is free at this scale and keeps media off the compute box entirely.
**Cost.** Nothing meaningful. Multi-select save to camera roll is what people actually do.

### D-05 — Sharing links and a web viewer are stretch, not core
**Decision.** In v1, anyone who wants to see the album joins the event as a Guest.
**Why.** A web viewer is a second frontend. It is the correct long-term answer for relatives who will not install an app, and for photographer delivery, but it is a whole application.
**Cost.** ⚠ The most common real-world way wedding photos circulate is unsupported. Combined with D-04, note the tension: the app refuses share links partly on privacy grounds while giving every guest a download button. Be ready to say that the download restriction was never the security boundary; see D-31.

### D-06 — Pinch-zoom and pan in the photo viewer are deferred ~~(SUPERSEDED by D-59)~~
> **Superseded.** This decision existed for exactly one reason, and D-57 removed that reason. The viewer supports pinch-zoom and pan in v11. Read on for why it was deferred; the reasoning is correct for the architecture it was written against.

**Decision.** The full-screen viewer supports swipe between photos and tap to toggle metadata. No pinch-zoom.
**Why.** This is a direct enabler for D-01. Overlaying an unblurred crop onto a static, aspect-fit image is absolute positioning inside a known frame. Keeping that crop welded to the correct pixels through a gesture-driven transform is a materially harder problem.
**Rejected.** Shipping zoom and solving the transform-tracking problem. Not worth it for a feature no judge will ask about.

---

# B. Roles and permissions

### D-07 — Photographer media goes straight into the shared album
**Decision.** Photographer uploads are visible to every event member by default, immediately, with no staging or approval.
**Why.** The v9.1 isolated pool gave the photographer nothing. They could not see the album, could not download, and their photos reached nobody. The role existed to make the permission matrix interesting rather than because anyone wanted it.
**Rejected.** Two alternatives. **A staging pool** where Admin publishes into the album, which was argued for as giving the couple control and giving the Review Queue real content. Declined because the Admin should not be working a media queue around an important event. **Cutting the role entirely**, declined because photographer delivery is a real workflow worth demonstrating.
**What this deleted for free.** The role-change visibility rule, the `uploader_role_at_upload` access-control clause in RLS, the "live role-based visibility" stretch goal, and the isolated-pool language in the album spec. One decision removed a stretch goal, a permission rule, and an RLS predicate.

### D-08 — The Photographer is write-only and cannot read the album ⚠
**Decision.** They see only their own uploads in My Media. No album access, no attendee list, no Admin settings. The Recognized Faces strip is suppressed on their own photos, because it names attendees and would otherwise leak the guest list.
**Why.** The isolation is of the *person* from the *event*, not of their *media* from the album.
**Rejected.** Giving them read access to Home, argued on the grounds that "I cannot see what I contributed" is the kind of thing a judge notices. Declined: the photographer is a hired outsider who should not be browsing guests' personal photos.
**Cost.** They contribute to something they cannot see. Defensible answer: they already hold every frame at higher quality on their own cards, so what they lose is the ability to browse other people's photos, which is precisely what the restriction exists for.

### D-09 — The Photographer keeps read-only access to the Schedule tab
**Decision.** They can see sub-event names, times, and venues. No Delay action, no editing.
**Why.** The upload flow requires choosing which sub-event section to upload into, so they need to know what the sub-events are. This is the one piece of event information the role is given, and it is given because a workflow depends on it.

### D-10 — Photographers are exempt from the location verification gate
**Decision.** The pre-flight verification check passes automatically for `role = 'photographer'`.
**Why.** Their actual workflow is shooting on gear all day and uploading from home at 2am. Under the gate they would never be able to upload at all, which would break the role's entire purpose.
**Rejected.** Requiring the Admin to Force Verify them. Declined because it makes receiving your own wedding photos depend on the groom remembering a step in the middle of the night.
**Cost.** ⚠ The Photographer Link is now a broad grant: anyone holding it can upload to the shared album from anywhere, at full quality, unverified. Mitigation is that the link is revocable and regenerable, and the spec labels it as sensitive.

### D-11 — Photographers upload at full quality; the worker generates the display variant ~~(SUPERSEDED by D-58)~~
> **Superseded.** Nobody resizes now, so there is no display variant to generate and no role branch to maintain. The single pipeline in spec §4.8 handles every role identically. D-48, which amended this entry, is void for the same reason.

**Decision.** No client-side 2048px resize for that role. The original is retained in R2, the worker produces a 2048px display variant, the album serves the variant, and download serves the original.
**Why.** Downsizing a professional's 45MP files to 2048px destroys the reason they would use the app.
**Cost.** Two client pipelines with a role branch, and a second worker job. Handbook §7 has the table; implement it as one function with a branch and unit-test the branch.
**Amended (see D-48).** The original wrote "download serves the original" without saying to whom, and since Photographers have no download button, the person pulling a 45MP file would have been a Guest. In v1 every download is the 2048px version. The original is still retained; only the routing changed.

### D-12 — Album-closed applies to Photographers too
**Decision.** No role bypasses album state, including Admin and Photographer.
**Why.** Closing the album is how the Admin declares "I have everything I expect to receive," which by design means waiting for the photographer's delivery.
**Rejected.** Exempting photographers the way D-10 exempts them from the location gate. Declined because it would make the close action meaningless.
**Mitigation.** The Close Album confirm dialog names any Photographer who has uploaded nothing yet. One query, and it prevents the most likely real failure of this role.

### D-13 — There is no role-based media visibility rule at all
**Decision.** All uploaded photos are visible to all event members regardless of the uploader's role. `uploader_role_at_upload` survives as display metadata only, never in an RLS predicate.
**Amended (see D-58).** This originally said "display and routing metadata." The routing half is gone: with one pipeline and one file per photo, there is no quality tier for the column to select on the download path. It now drives the Uploader filter chip and nothing else.
**Why.** Follows directly from D-07. With one shared album there is nothing for the rule to decide.
**Consequence worth remembering.** A role change has no retroactive effect on any photo, so none of the snapshot-versus-live-role machinery from earlier drafts is needed.

---

# C. Location verification

### D-14 — Verification is a blocking gate, not a visible flag ⚠
**Decision.** Unverified photos do not upload. They wait in the local queue.
**Why.** The rejected alternative was the `unverified_location` flag, where photos always upload and unverified ones carry a badge the Admin can filter. That was declined specifically because it leaves the Admin sorting through unverified media after an exhausting event. Force Verify lets him resolve a person in one tap instead.
**Rejected reasoning worth recording, because it was argued at length.** The flag model removes the worst demo failure, which is GPS failing indoors and nothing uploading at all. The counter-argument that won: the demo is in a known classroom on campus with a rehearsal a week prior and a generous verification radius, so the risk is controlled.
**Cost.** If GPS and QR both fail and the Admin is unavailable, a guest's photos are stuck indefinitely. The spec makes this an explicit, non-lossy state rather than an error.
**Reopen if.** The rehearsal shows GPS is unreliable in the demo room and widening the radius does not fix it.
**Confirmed (2026-09-23).** Ukasha confirmed GPS is reliable in the demo room, so the reopen condition has not occurred.

### D-15 — Verification granularity is per sub-event, with a blunt admin override
**Decision.** A `VenueVerification` row is scoped to one user and one sub-event. Force Verify sets `admin_verified_at` on the membership row, and the pre-flight check is `(per-sub-event row) OR (admin_verified_at IS NOT NULL) OR (role = 'photographer')`.
**Why.** v9.1 said three different things in three places, which is why this is written down once and referenced everywhere. Per sub-event is the honest reading of "were you actually there for this part." The override is deliberately blunt because the Admin should be able to say "this person is fine, stop asking" once, not per session.
**Rejected.** Per-event verification, which would let someone verify at the mehndi and upload from home during the nikkah. Also rejected: writing N verification rows on Force Verify, which does the same job with more state.

### D-16 — GPS verification runs on-device; the server re-validates
**Decision.** The client compares GPS against cached sub-event coordinates locally and optimistically unlocks the queue. Each queued photo carries its capture-time GPS reading, the pre-flight submits it, and only the server writes the `VenueVerification` row.
**Why.** Venue connectivity at weddings is bad enough that requiring a round-trip before a guest can even queue photos would fail most of the time.
**Rejected.** A pure server-side check (fails offline) and a pure client-side check with a client-supplied `verified: true` boolean (trivially forged).
**Cost.** ⚠ A modified client with a spoofed GPS reading can still get a real verification row. This is a UX gate, not a security boundary, and it is listed as such in the spec's Known Limitations.
**Amended (see D-89).** Photos carry no GPS reading. The device sends one reading per sub-event when its check passes, and the server writes the row from that.

### D-17 — The Venue QR works offline without pre-caching any secret
**Decision.** A scan is written to local SQLite and travels with the next pre-flight request when connectivity returns.
**Why.** v9.1 said the QR's signed secret was cached on first load so offline verification would work. That is both a contradiction (you cannot send it to the server offline) and a security hole (a client holding the venue secret can self-verify from anywhere, without ever scanning).
**Rejected.** Pre-caching the secret. You cannot cache the secret of a QR you have not scanned; that is the entire point of the QR.

### D-18 — Retroactive per-sub-event verification requests are deferred
**Decision.** No flow where a user asks the Admin to verify them for a sub-event that already passed.
**Why.** It was proposed and then withdrawn, because it needs a new screen, a request table, a notification channel, and an Admin queue. That is strictly more Admin work than the flag model D-14 rejected for creating Admin work.
**Replacement.** The stuck-queue banner reads "Ask the organizer to verify you," and the Admin taps Force Verify once from the existing Attendees screen. Zero new screens.

---

# D. Capture

### D-19 — A sub-event stays In Progress until the next one starts ~~(SUPERSEDED by D-88)~~
> **Superseded.** A sub-event now ends at its scheduled end, and the Admin delays one that runs late. The reasoning below is the risk D-88 accepts.
**Decision.** Status ignores the sub-event's own scheduled end time. It ends when the next sub-event begins, or when the parent event ends.
**Why.** The capture FAB is hidden when no sub-event is In Progress (D-20). Under the old rule, a sub-event scheduled 7pm to 8pm auto-completed at 8pm, so if the next started at 10pm and the baraat actually arrived at 9:40, **the camera disappeared for the two most photographed hours of the night**. South Asian events running late is the modal case, not an edge case.
**Rejected.** Relying on the Admin to pad durations or delay sub-events manually. That works, and it is a one-minute task, but it means the failure mode is silent: nobody discovers it until people are already unable to take photos.
**Cost.** One extra row read in the status derivation, since it now depends on the next sub-event's start. Nothing else.

### D-20 — The capture FAB stays hidden when no sub-event is In Progress
**Decision.** Capture is available only during a live sub-event.
**Why.** It guarantees no photo can ever have an ambiguous sub-event tag, which removes an entire class of data problem and makes "Move to..." reassignment optional rather than required.
**Rejected.** Making the sub-event a default tag with an "Unsorted" bucket and always-available capture. Argued for on the grounds that a gate is riskier than a tag. Declined, and D-19 removes most of the risk that argument rested on. The gate is on *time*, not on verification: an unverified user can still capture freely.
**Amended (see D-88).** Sub-events end at their scheduled time, so the FAB is also hidden in the gaps between them, and D-19 no longer covers a sub-event that runs late.

### D-21 — Capture keeps the camera's native aspect ratio
**Decision.** No forced 4:3 or any other crop.
**Why.** A fixed ratio can only bind in-app capture anyway. Gallery imports are whatever the phone shot, and photographer files are almost always 3:2. Cropping a professional's framing to fit a grid is destroying the work.
**Related.** Album grid thumbnails are center-cropped to square for grid uniformity across mixed-aspect sources; full-screen view always renders native aspect. This is a display decision, not a storage one; the stored file is never cropped.

### D-22 — FlashList grid, not masonry, but store dimensions anyway
**Decision.** Square-cropped uniform grid. The worker writes `width` and `height` onto every media row regardless.
**Why.** Masonry's packing math is free, but FlashList v2 removed size estimates and measures items as they render, so a masonry layout without known heights produces a collapse-then-expand reflow on every image load. Worse for this app specifically: the album has sticky sub-event section headers, and sticky headers over independently-packed variable-height columns is a day or two of layout debugging on a screen nobody is grading.
**Why store dimensions anyway.** The personalized-blur crop overlay needs to position an absolute box inside a known frame, and the worker is already opening every file, so it is free. Backfilling these columns against R2 once the table has real rows is a real job.
**Amended (see D-57).** The overlay is gone, so that half of the reason no longer applies. The other half holds: masonry without known heights reflows on every image load, and the worker already opens every file (Handbook §4).
**Reopen if.** Someone wants masonry later. It becomes a one-prop change because the data is already there.

---

# E. Face processing and blur

### D-23 — Manual self-blur is gated by an embedding check, not by Admin approval ~~(SUPERSEDED by D-83)~~
> **Superseded.** Tap-to-blur is removed. A missed face is fixed with a blur region, which has no embedding check.
**Decision.** When a user taps their own face to blur it, compare that face to the requester's own reference set. Above a loose threshold, apply with no review. Below it, apply **and** queue the request to the Admin.
**Amended (see D-52 and D-54).** Two things were undefined here. The action is now available only to users with Do Not Publish active, and the comparison runs against the requester's **curated** references only, never the auto-added ones from D-25.
**Why.** The concern that drove this was real: without a check, anyone could blur the bride out of every photo. But a genuine missed match lands in the middle similarity band, while someone maliciously blurring another person scores near zero against their own references. Those are not close numbers, and separating them is one cosine comparison against data the system already has.
**Rejected.** Routing every manual blur to the Admin. That fills the queue with legitimate corrections he has to rubber-stamp, which is the same "Admin juggling a queue during the event" problem that D-07 rejected a staging pool over.
**Cost.** It contradicts v9.1's rule that no AI uncertainty is ever routed to a human. That rule was rewritten deliberately, not violated by accident.

### D-24 — The blur applies immediately and the Admin reverts, rather than approving first
**Decision.** A queued blur request is already applied while it waits. The Admin's actions are Confirm and Revert, not Approve and Reject.
**Why.** Pending review means the face stays unblurred for as long as the Admin is busy, which at a wedding is the whole night. That is exactly the exposure the feature exists to prevent. The privacy-preserving state should be the default and the Admin's job should be undoing abuse.
**Enabler.** The retained original (D-27) makes revert mechanically free.
**Amended (see D-83).** The principle now governs blur regions: a region applies at once, and the person who drew it or the Admin removes it.

### D-25 — A confirmed face crop becomes a new reference embedding ~~(SUPERSEDED by D-83)~~
> **Superseded.** With no tap-to-blur there is no confirmed crop, so no reference is ever added automatically.
**Decision.** When a user taps their own face, that crop is added to their reference set automatically.
**Why.** It is a correctly-labeled face from a real event photo in real lighting, which is a substantially better reference than a profile selfie. The match that failed once becomes less likely to fail again, so the correction improves the system rather than just fixing one photo.
**Amended (see D-54).** As written this was an undamped feedback loop. Crops are now tagged auto-added and are excluded from the abuse check in D-23, which is what stops a drifting reference set from degrading the check that depends on it.

### D-26 — The self-visible marker is mandatory, not decoration
**Decision.** When a Do Not Publish user views their own unblurred crop, a lock icon renders on it and the metadata overlay reads "visible only to you."
**Why.** Without it, a subject seeing their own clear face cannot tell whether personalized blur is working or whether the match failed and everyone can see them. **The two states are pixel-identical to the only person who can report the problem.** The marker is the entire discoverability mechanism for D-23; without it, every miss becomes a permanent, unreportable privacy failure.
**Treat this as a correctness requirement, not a polish item.**
**Amended (see D-57).** There is no crop now. The subject views their own personalized variant, and the marker is a static badge on the photo.
**Amended (see D-83).** A subject who finds a missed face fixes it by drawing a blur region, since tap-to-blur is gone.

### D-27 — Retained originals are load-bearing, not speculative
**Decision.** The pre-blur uploaded file stays in R2 and is the source every blur variant is generated from.
**Amended (see D-57 and D-58).** Two clauses stopped being true. There is no compositing, because variants are pre-generated. And "never served to anyone including the subject" is false for a photo with exactly one Do Not Publish subject, whose variant is byte-identical to the uploaded file. The surviving guarantee, and the one to state in a viva, is that no viewer ever receives a file in which a Do Not Publish face other than their own is unblurred.
**Why.** In v9.1 this was storage held for a stretch goal that might never ship, which was worth questioning. Now that D-01 made personalized blur core and D-24 requires revert, the original is required rather than optional.
**Amended (see D-83).** A lone subject's variant is byte-identical to the upload only when the photo also has no blur region; a region is applied to every file (root invariant 6).

### D-28 — Downloads are personalized, so DNP photos leave the public CDN path ~~(SUPERSEDED by D-57)~~
> **Superseded.** The premise holds: two people must receive two different files. The mechanism does not. Server-side compositing would have routed media bytes through Express, which Handbook §7 forbids on the box the whole system depends on, and neither document ever resolved that contradiction. Pre-generated per-subject variants make the download a presigned URL for a file that already exists.

**Decision.** A Do Not Publish subject downloading their own photo gets a server-composited version with their face unblurred. Any photo containing a DNP face is served on the download path through an authenticated endpoint, never a public R2 URL.
**Why.** Two people must receive two different files, which a cacheable public URL cannot do.
**Cost.** That subset loses CDN cacheability on download. Album viewing is unaffected, since everyone sees the same blurred variant there. The implementation trap: wiring the download button to a bucket URL makes personalization silently stop working for exactly the people it exists for.

### D-29 — One detection pass, with an explicit filter
**Decision.** Detect faces once, on the original. Build the Recognized Faces list from that pass and filter out faces matched to a Do Not Publish user.
**Why.** v9.1 claimed a blurred face has no detectable features left, so DNP users were "structurally" absent from the list rather than filtered. That claim does not survive testing, since detectors routinely find heavily blurred head-shaped regions. It also ran detection twice per photo to avoid what should be a filter, doubling inference cost on a 2-core box in the name of elegance.
**Amended (see D-46).** The v10 first draft wrote the filter as a *global* exclusion, which broke Find My Photos for Do Not Publish users. The filter is viewer-scoped.

### D-30 — The blur pipeline runs on every upload regardless of role
**Decision.** Detection and blur run on Photographer uploads too, and blur boxes are stored.
**Why.** Follows from D-07. If photographer media reaches the shared album, skipping the pipeline would let unblurred faces in through a side door.

### D-31 — Do Not Publish is permanently irreversible; a single manual blur is not
**Decision.** Two different objects. Enabling DNP cannot be undone by anyone, ever. A single per-photo manual blur correction can be reverted by the Admin if judged fraudulent (D-24).
**Why.** Conflating them in the UI copy is the easiest way to make the irreversibility warning look like a lie.
**Amended (see D-83).** The single manual blur here is now a blur region. Any Guest or the Admin draws one, and its drawer or the Admin removes it; "reverted by the Admin if judged fraudulent" no longer describes it.
**Amended (see D-129).** Do Not Publish is set per event. Within its event it stays permanent for anyone; another event is not affected.

---

# F. Data and storage

### D-32 — SHA-256 content hash replaces pHash
**Decision.** Hash with SHA-256. Exact match is rejected at pre-flight via one indexed lookup. There is no near-duplicate detection of any kind.
**Amended (see D-53).** This originally hashed the 300px WebP thumbnail. WebP encoders differ across iOS, Android and library versions, so that hash is not reproducible and the dedup would have caught almost nothing. The hash is now computed over the exact byte stream being uploaded.
**Why.** Perceptual hashing exists to find near-duplicates, and near-duplicate detection was cut. At distance zero, pHash catches exactly one case, the same file added twice, which a content hash catches better with no image-processing library.
**Consequence.** Deduplication moved out of the worker and into Express. That removed the Phase 5 warm-up task, which is now the `variant` job instead.
**Amended (see D-58, D-72).** The `variant` job was deleted as well. The warm-up is now `thumbnail_dims`, and D-72 moved it into Phase 3.
**Reopen if.** Burst grouping (D-03) comes back. It needs perceptual distance, and it is the only thing that does.

### D-33 — Guest cap 150, upload cap 2,000
**Decision.** Down from 500 and 10,000.
**Why.** The old numbers were chosen without reference to any free tier. Supabase's free plan allows 200 peak concurrent Realtime connections and 2 million Realtime messages per month; a 500-guest event broadcasting every upload exceeds both from a single wedding.
**Cost.** None practically. Both numbers are far above anything a demo will produce.
**Amended (see D-102).** The 150 counts active Guests. The Admin and Photographers do not count.

---

# G. Privacy posture

### D-34 — "Private mode" is renamed Local Only and writes to the app sandbox
**Decision.** Local Only files go to `FileSystem.documentDirectory`, not the camera roll, with the do-not-backup flag set on iOS.
**Why.** The old design saved to `DCIM/MomentLens_Private`, which is Android-only path thinking and, worse, the most publicly synced location on the phone. Files there reach iCloud and Google Photos. Calling that "Private" is a naming lie.
**Cost.** These files do not appear in the device gallery and are deleted on uninstall. That is the honest price of actually being local, and the UI states it at first use.
**Amended (see D-90).** A Public capture is also saved to the phone's gallery. Only Local Only stays out of it.

### D-35 — Do Not Publish hides the profile photo, not the name
**Decision.** The image is replaced by a name-initial placeholder everywhere, including for the Admin. The name still appears where a workflow requires it, such as Pending Approvals and the Attendees list.
**Why.** v9.1 said DNP hides the profile photo "everywhere with no exception, including the Admin," while other sections rendered requester photos and names in the approval queue. An Admin cannot approve a join request from an anonymous row.
**Amended (see D-109).** "Everywhere" means every other viewer. The user still sees their own profile photo.
**Amended (see D-129).** The placeholder applies wherever an event shows the person, in each event where their membership has Do Not Publish on. Another event shows the photo.
**Amended (see D-143).** Attendees returns initials for everyone until S-29 supplies the event-scoped flag and upgrades the shared avatar presigner.

### D-36 — GPS is transmitted for verification and not persisted
**Decision.** Stripped from the image file. A separate reading rides with the pre-flight request, is validated against the sub-event's coordinates, and is not written to the media record.
**Why.** v9.1's onboarding promised GPS never reaches the network while the pipeline sent a per-photo GPS reading with every upload and stored one per queued item. The promise was misleading as written, which matters more in a consent screen than anywhere else.
**Amended (see D-89).** The device keeps one GPS reading per sub-event with its time and sends it with the next pre-flight, instead of one per photo. The server still stores no coordinates, only the `venue_verification` row.

### D-37 — Known Limitations are written down rather than hidden
**Decision.** The spec carries a section stating plainly that DNP only protects people who install the app and opt in, that face-processing consent is obtained from the uploader rather than the subject, that downloads defeat every in-app control, that false-positive blurs will happen, that the verification gate is bypassable in principle, and that the Photographer link is a broad grant.
**Why.** Every one of these will be asked. A written answer beats improvising, and volunteering a limitation reads as competence while being caught hiding one does not.

---

# H. Infrastructure

### D-38 — One Oracle Always Free ARM instance, no provider rotation ~~(SUPERSEDED by D-78)~~
> **Superseded.** Both halves were reversed. D-78 moved development and the demo to a Netcup server, and D-79 made the rotation this entry rejected into the standby plan. The reasons below were correct for a free-tier plan.

**Decision.** A single `VM.Standard.A1.Flex` in Singapore, permanently. One team member's Azure student credit held completely untouched as a standby for demo week.
**Why.** Of the four options considered, three were not what they appeared. AWS "xLarge" is not a free-tier shape at all. GCP's c2-standard-4 burns a $300 credit in under three months, and the credit expires on the calendar rather than on use. Azure B2ms consumes $100 of student credit in about six weeks. Oracle is the only permanently free option, and even after its allowance was halved to 2 OCPUs and 12 GB in mid-2026, it beats the others on cost by an unbounded margin.
**Rejected.** The rotation plan, where the team burns each member's credits in turn. Every migration means a new IP, DNS, TLS certificates, secrets, firewall rules, and a fresh install, for a team that has never done it once. Three rotations is a week of buffer spent on infrastructure, and the Supabase keep-alive cron lives on the box that keeps moving.
**Why Singapore.** ARM capacity is contested and frequently returns "Out of host capacity." Singapore provisions faster than US regions and is closest to Lahore. **The home region is fixed at signup and cannot be changed later**, which is why this is a week-one task.
**Bonus.** The instance is ARM64 and so is the M1, so local and production architecture match for the Python worker.
**Amended (see D-50).** The instance is still provisioned in week one and still runs production, for reasons this entry gives that have not changed. The demo itself runs on the M1. Read D-50 before repeating any part of this entry in a viva.
**Amended (see D-78).** From 2026-10-15 development and the demo run on a rented Netcup server, so the Oracle instance stops being the project's server.
**Amended (see D-79).** The rotation this entry rejected is now the standby plan. D-67 moved the keep-alive off the box that would be moving, and a VM that exists only for the rehearsal and demo week spends almost none of a credit.

### D-39 — No Docker; systemd, nginx, and certbot instead
**Decision.** Express and the worker run as systemd units behind nginx, with TLS from certbot.
**Why, stated correctly.** The reason is *not* that Docker is slow on limited hardware. On Linux, containers are namespaces and cgroups, not virtualization, and the runtime overhead is near zero. Saying otherwise in a viva will get you corrected. The real reason is that Docker buys portability between environments and there is exactly one environment. For a team that has never deployed anything, the container layer is one more thing to learn and one more layer between a failure and its stack trace.
**Replacement for what Docker would have given.** Pinned dependencies (`pnpm-lock.yaml`, an exactly-pinned `requirements.txt`) and a written `scripts/deploy.sh`.

### D-40 — The InsightFace model loads once at worker startup
**Decision.** Resident in memory, never lazy-loaded per job.
**Why.** This matters more than which cloud provider was chosen. Inference on a 2048px photo is roughly one to two seconds; a cold model load is several seconds. Lazy loading is the single most likely reason the demo would feel slow, and it is entirely avoidable.
**Related.** Run one worker process on a 2-core box, not two. The second core belongs to Express, Postgres connections, and nginx.
**Amended (see D-78).** The server has four cores. One worker process still holds (`docs/ARCHITECTURE.md` §5). How many ONNX Runtime threads it runs is measured on the server, not carried over from the 2-core reasoning.

### D-41 — React Native over Flutter
**Decision.** React Native with Expo.
**Why.** All three team members know React through prior MERN work, and there are more React jobs in the Pakistani market than Flutter jobs. The second reason is not a technical argument and does not need to be.
**Recorded here specifically because** an earlier iteration of this project had settled on Flutter and Riverpod, and the switch happened without a written rationale. That is exactly the kind of drift that gets re-litigated in month five when something is painful and nobody remembers why.

---

# I. Process

### D-42 — Retention windows live in one table
**Decision.** Photo soft delete 30 days, event soft delete 14 days, album visibility 30 days after close, expiry warning 7 days ahead, recoverable grace period 7 days.
**Why.** v9.1 had four windows scattered across four sections, one of them written as a range ("7 to 14 days") rather than a decision. Three people will implement three of them inconsistently if the numbers are not in one place.
**Amended (see D-130).** A deleted photo has no window. Deletion is permanent, nobody can restore it, and the worker deletes its files at once. The event, album and expiry windows stand.

### D-43 — Two notification channels, not four
**Decision.** Approval Alerts and Album Lifecycle only. Settings shows exactly two toggles.
**Why.** v9.1's Settings screen listed four toggles for two features, because Schedule Changes and Upload Activity had been deferred without updating Settings.

### D-44 — The demo script is the scope boundary
**Decision.** An eight-beat script lives in the spec, and anything not in it is not core scope.
**Why.** Scope discussions without an anchor drift forever. With one, "is this core?" becomes "does it appear in a beat?", which is answerable in five seconds.
**Corollary.** A seeded dataset that loads in ten seconds must exist before the defense, so that a WiFi failure does not become a live debugging session.
**Amended (see D-62).** The v11 script in spec §9 has nine beats. D-62 replaced this corollary's fallback with a recording.
**Amended (see D-77).** Pinch-zoom is core without appearing in any beat, the one named exception to this rule.

### D-45 — Every AI-generated line must be explainable by a human on the team ~~(SUPERSEDED by D-68)~~
> **Superseded.** The line-by-line comprehension gate is gone; see D-68. Two clauses survive there in a different form: the dangerous surfaces still get read before merging, and `ARCHITECTURE.md` is still the source of truth.

**Decision.** Nothing merges if none of the three can explain it line by line. RLS policies and blur-pipeline code get a human read regardless. One hand-maintained `docs/ARCHITECTURE.md` is the source of truth rather than any agent session's memory.
**Why.** The project will be orally examined. "The AI wrote it" is a failing answer even when the code is excellent.
**The specific danger.** Agents write plausible SQL, and a plausible RLS policy that is subtly too permissive looks identical to a correct one and throws no error. It just returns rows it should not.
**Amended (see D-57).** This entry originally named the `dnp_crop` policy as the place where that failure exposes a Do Not Publish user's face. That table no longer exists. The danger did not go away, it moved: the equivalent failure is now the **image-serving endpoint's authorization check**, which decides whether a requester gets the public file or a subject's personalized variant. It is application logic rather than SQL, which makes it easier to test and no less dangerous to get wrong. An agent will happily derive "is this the subject" from a client-supplied parameter and it will look completely reasonable.

### D-46 — The Do Not Publish recognition filter is viewer-scoped, not global
**Decision.** A face matched to a Do Not Publish user is hidden from the Recognized Faces strip for every viewer except that user, who sees their own face listed normally. Find My Photos works for them as it does for anyone.
**Why.** The first draft of v10 excluded those faces globally, which meant **Find My Photos returned nothing for a Do Not Publish user**. The one person who most needs to audit which photos contain them would have been the only person unable to search for them. It also broke the correction path in D-23, which assumes the subject can navigate to photos of themselves.
**Rejected.** The global exclusion, which is simpler and reads as a stronger guarantee. It is not stronger; it is the same guarantee for other viewers plus a broken feature for the subject.
**Implementation note that matters.** Write it as a read predicate parameterized by the requesting user, never as omitting the row at write time. The wrong version throws no error and passes every test written from another viewer's perspective, failing only for the subject.

### D-47 — The Admin's inability to verify a blur requester's identity is accepted, not solved ⚠ ~~(SUPERSEDED by D-83)~~
> **Superseded.** There are no blur requests to judge. The Admin restores blur regions instead.
**Decision.** When a low-confidence manual blur request reaches the Review Queue, the Admin judges it from personal knowledge. There is no in-app reference image, because Do Not Publish hides the requester's profile photo from everyone including the Admin and the disputed face is already blurred. A legitimate requester whose score came back near zero contacts the Admin out of band.
**Why.** The path is expected to be rare, and it already fails in the safe direction: the blur is applied while the request waits (D-24), so the cost of a slow or wrong decision is a face staying hidden rather than a face being exposed.
**Rejected.** Surfacing the requester's profile photo to the Admin on this one screen, which would put a hole in the "no exception for anyone, including the Admin" guarantee in §4.2 for a feature almost nobody will use. Also rejected: removing the Admin from the loop entirely, since that is what invites the abuse D-23 exists to catch.
**Defensible answer if asked.** A rarely-used privacy correction that degrades to a phone call is an acceptable trade at this scale, and the alternative weakens a guarantee that applies to everyone.

### D-48 — Full-quality download of photographer originals is deferred ~~(VOID, see D-58)~~
> **Void, not superseded.** This entry described a choice between two files. There is one file per photo now, so there is nothing left to choose between and nothing left to defer.

**Decision.** Every download in v1 serves the 2048px version regardless of who uploaded the photo. The photographer's original stays in R2.
**Why.** D-11 said "download serves the original" without specifying the recipient, and since Photographers have no download button (D-08), the recipient would have been a Guest. A guest tapping Download and pulling a 45MP file over mobile data is a surprise, and v1's download button should mean one predictable thing.
**Cost.** None to the demo. Enabling it later is a routing change on the download endpoint plus a size warning in the UI, not a re-upload, because the originals are already retained.
**Reopen if.** Someone wants professional-quality delivery through the app rather than out of band, which is the same need the deferred web uploader addresses.

---

# J. Applied from the resolution log (spec v11)

Two constraints settled a third of these before any of them were argued individually, and they are recorded here as a decision because everything below depends on them.

### D-49 — No real event is ever covered; the dataset is ~100 seeded photos
**Decision.** Development and the demo run on roughly 100 photos at 1 to 3MB each, under 500MB against a 10GB R2 budget.
**Why.** This is a project to defend, not a product to operate. Stating it plainly stops the team from paying design cost for scale it will never see.
**What this killed outright.** R2 storage pressure. The retention-of-photographer-originals problem. The worker-backlog argument against generating extra variants. Rate limiting as a build item (D-64).
**Cost.** ⚠ Anything justified by scale is now unjustified, which cuts both ways: several v10 decisions that read as prudent were prudent about a constraint that does not exist. Do not reintroduce one by reflex.
**Reopen if.** Someone decides to cover a real wedding. Nobody has.

### D-50 — The demo backend runs on the M1; the Oracle instance is provisioned anyway ~~(SUPERSEDED by D-78)~~
> **Superseded.** D-78 moved development and the demo to one Netcup server, so the M1 no longer runs the demo backend and the Oracle instance goes on 2026-10-15.
**Decision.** Express and the FastAPI worker run on the team's M1 behind a Cloudflare Tunnel named hostname for the demo. Supabase and R2 are unchanged. The Oracle ARM instance is still provisioned in week one, still runs production, and is still reachable during the defense.
**Why.** The M1 runs InsightFace 3 to 5 times faster than 2 OCPUs of Ampere, and demo latency is what a panel experiences. Dev and demo become the same environment. Oracle's capacity lottery stops being a demo-day risk.
**Why the instance stays regardless.** The deployment claim has to survive "show me." It is a fallback that is not sitting in the demo room. It is the shared backend the other two team members develop against, which is also the fix for a bus factor of one on demo morning. And D-38's reason is untouched: the home region is fixed at signup and ARM capacity is contested, so it is a week-one task or it never happens.
**Rejected.** Claiming a deployment without having one. "We deployed but chose our laptop due to compute costs" invites exactly one follow-up, and a panel that asks for the systemd unit and gets improvisation has learned something about the whole project rather than just about the server. D-45 is the team's own rule; this is that rule pointed at the deployment story.
**Cost.** ⚠ The laptop moves compute out of the cloud. It does not remove the network dependency: Supabase, R2 and the phones are all still on it. See D-61.
**The line to use.** Production runs on an Oracle ARM instance. The demo runs the API and worker locally behind a Cloudflare Tunnel because the M1 gives roughly four times the inference throughput of the free tier, and the panel should see real latency rather than free-tier latency.
**Amended (see D-76).** Development runs on the Oracle instance and the M1 demo stack goes up one month before the demo, so dev and demo are no longer the same environment.

### D-51 — ngrok is not the tunnel ~~(SUPERSEDED by D-78)~~
> **Superseded.** D-78 removed the tunnel. The API is served from the Netcup server under `api.momentlens.me`.
**Decision.** Cloudflare Tunnel with a named hostname.
**Why.** ngrok's free URLs rotate, which means rebuilding the app or reconfiguring the API base URL on demo morning.

### D-52 — Tap-to-blur is available only to users with Do Not Publish active ~~(SUPERSEDED by D-83)~~
> **Superseded.** Tap-to-blur is removed. Blur regions are open to every Guest and the Admin.
**Decision.** The manual correction affordance renders only for users who have Do Not Publish enabled. Everyone else never sees it.
**Why.** Spec v10 left this undefined: §4.11 framed the correction path as something a Do Not Publish user does, while demo beat 7 had a team member tapping somebody else's face. The two readings have very different abuse surfaces and the spec chose neither.
Three reasons for this side of it. It matches what the feature is for, since a user without Do Not Publish has nothing to correct. It collapses the abuse surface, because an attacker must first permanently and irreversibly blur their own face across every event they will ever join. And combined with D-56 it removes the undefined case where a requester has no reference set to compare against.
**Rejected.** Leaving it open to everyone, which is the more permissive reading and the one that makes "what stops a malicious guest" a harder question than it needs to be.
**Cost.** Demo beat 7 now needs a second pre-configured account with Do Not Publish enabled. One line on the pre-demo checklist.

### D-53 — Hash the bytes being uploaded, not a re-encoded thumbnail
**Decision.** SHA-256 over the exact byte stream the client is about to PUT, after EXIF stripping and HEIC conversion.
**Why.** D-32 hashed the 300px WebP thumbnail. WebP encoders differ across iOS, Android and library versions, so the same source photo hashes differently on two devices and after any dependency bump. The dedup would have caught close to nothing while looking like it worked.
**Rejected.** Hashing the source file before processing, which is also deterministic but misses the case where the same photo arrives as HEIC on one device and JPEG on another.
**Amended (see D-96).** The hash is unique per event among finished rows, deleted ones included. Another user's unfinished row with the same hash is not a duplicate.

### D-54 — Curated and auto-added references are tracked separately ~~(SUPERSEDED by D-83)~~
> **Superseded.** With no auto-added references, every reference is one the user uploaded, so there is nothing to split.
**Decision.** One boolean column. Matching and Find My Photos use curated plus auto-added. The D-23 abuse check uses curated only.
**Why.** D-25 adds a confirmed tap crop to the reference set automatically with nothing damping it. A user tapping faces that score just above the loose threshold, meaning the sibling-and-cousin population spec §8 already expects to produce false positives, drifts their reference set toward that other person. The drifted set is what the abuse check runs against, so the check degrades exactly as the thing it guards against gets easier.
**Rejected.** Capping the number of auto-added references, which slows the drift without stopping it, and dropping D-25 entirely, which throws away the best reference data the system ever gets.

### D-55 — A media row is not album-visible until processing completes
**Decision.** The album query filters on `processed_at IS NOT NULL`. Before that the photo is visible only to its uploader in My Media, with a spinner badge.
**Why.** The spec §3 lifecycle diagram had this right and spec §4.9 did not say it, and spec §4.9 is what the album gets built from. If visibility keys off upload completion, an unblurred photo is in the shared album for the length of the worker backlog. On an M1 with 100 photos that window is about a second, which makes the rule cheap rather than optional.
**Cost.** "A photo appears within seconds" is true when the queue is empty and degrades under a burst. Say that rather than claiming otherwise.

### D-56 — Do Not Publish cannot be activated without a reference image
**Decision.** Activation is blocked unless the user has at least one reference photo or a profile photo.
**Why.** Spec v10 made both optional and gated activation on a checkbox, so a user could complete a permanent, irreversible privacy action, see a static "Active" badge, and be protected against nobody, because the pipeline had no vector to match on. This is the same class of bug as D-34, where "Private mode" wrote to the camera roll: a name that promises something the mechanism does not do.
**Rejected.** Activating anyway and prompting for references afterwards, which leaves a window where the badge lies.
**Amended (see D-87 and D-91).** "A reference" means an accepted `face_reference` row: the worker found exactly one face in it. The last one cannot be deleted while Do Not Publish is active.
**Amended (see D-129 and D-141).** Activation is per event and needs an accepted reference in that event. The last one there cannot be deleted while Do Not Publish is on there. A profile photo is never a reference.

### D-57 — Personalized variants replace the crop-and-overlay design ⚠
**Decision.** For a photo with N Do Not Publish subjects the worker writes N+1 files: one public with every subject blurred, and one per subject with only that subject clear. One serving endpoint checks whether the requester is a subject and mints a presigned R2 URL for the correct file. Viewing and downloading use the same mechanism.
**Why.** The crop-and-overlay design in v10 cost four separate things: the `dnp_crop` table with the row-level policy D-45 names as the most dangerous SQL in the project, a client-side image-over-image overlay, a hard dependency of blur correctness on the stored width and height, and an authenticated compositing endpoint that would have routed media bytes through Express against Handbook §7's own rule. Pre-generated variants delete all four and replace them with one authorization check.
**Rejected.** Keeping the crops, which win decisively on storage at 5 to 20KB against a full file, and lose on everything else. D-49 made storage irrelevant, which is what let this trade flip.
**Also rejected.** Compositing on the client with `react-native-view-shot`, which is the cheapest possible fix for downloads alone and does nothing about the overlay or the `dnp_crop` policy.
**Cost.** ⚠ The subject's own views lose CDN caching, which affects one to three people per event. Mitigated with a one-hour presigned URL lifetime and an explicit `expo-image` cache key.
**Amended (see D-86).** The cache key is the signed object key plus `variant_version`, returned by the endpoint, so two accounts on one phone never share a cached file.
**Enables.** D-59.

### D-58 — No client-side resize, with a 4096px guard
**Decision.** Phone JPEGs upload as they are. If the longest edge exceeds 4096px, resize to 4096px. One pipeline for every role.
**Why.** Phone JPEGs are already 1 to 3MB, so the resize was solving a storage and bandwidth problem D-49 removed. Inference cost barely moves either, because InsightFace resizes internally to `det_size` for detection and crops to 112x112 for recognition; input resolution mostly costs JPEG decode time.
**Rejected.** Removing the resize entirely with no guard. The guard never fires on a phone photo and exists so a DSLR file dragged in during a rehearsal does not surprise anyone.
**What this deleted for free.** D-11's two client pipelines and the role branch. D-48 entirely. The download routing that `uploader_role_at_upload` used to drive (D-13). The `variant` worker job, which was also Phase 5's warm-up task, so Handbook §14 needed a new one.

### D-59 — Pinch-zoom and pan are restored
**Decision.** The full-screen viewer supports pinch-zoom and pan. Supersedes D-06.
**Why.** D-06 deferred them for exactly one reason: keeping an unblurred crop welded to the correct pixels through a gesture-driven transform. D-57 removed the crop, so the subject is looking at an ordinary image like everyone else and the self-visible marker is a static badge that cannot drift.
**Cost.** None to the privacy design. It is now a normal feature with normal cost, built if there is time.
**Amended (see D-77).** Core scope, not "if there is time."

### D-60 — Blur variant object keys carry a version ⚠
**Decision.** `{media_id}/public_v{n}.jpg` and `{media_id}/{subject_id}_v{n}.jpg`, with `variant_version` as an integer column on the media row, bumped on every regeneration and carried in the Realtime row update.
**Why.** The public file is a mutable derived artifact. Retroactive Do Not Publish regenerates it and so does a confirmed manual blur, while spec §4.13 also says it is cached client-side by `expo-image` and cacheable by any CDN in front of R2. With a stable key, every client that already loaded that photo keeps serving the pre-blur image out of its own disk cache. That is precisely the failure the feature exists to prevent, and it is invisible to any test written against a fresh client.
**Rejected.** Cache-busting query strings, which some CDNs ignore, and short cache lifetimes, which trade the bug for a bandwidth cost and still leave a window.
**Treat this as a correctness requirement, not an optimisation.** It is one integer column and it must exist before the first table does.
**Amended (see D-83).** "A confirmed manual blur" above is now a blur region, which regenerates the files the same way.

### D-61 — Judges use team-owned Android devices; there is no deferred deep link ⚠
**Decision.** Demo beat 2 runs on team-owned Android devices handed around, with the build installed and accounts signed in a week ahead. The deferred deep link claim is removed from spec §4.1.
**Why.** Firebase Dynamic Links shut down in 2025 and the replacements are third-party services. More to the point, this app will not be on either store in June 2027: it is an APK or a TestFlight build. TestFlight needs an Apple review pass and invited testers; ad-hoc provisioning needs UDIDs collected in advance. A judge arriving with an iPhone and no prior setup breaks the beat outright.
**Rejected.** Integrating a third-party deferred-linking service for a path that would never be exercised, and claiming the feature without testing it.
**Related.** Beat 3 already assumed an Android phone for the location-denial step, so the project was halfway to this decision.

### D-62 — The offline fallback is a recording, not a seeded dataset
**Decision.** A recorded walkthrough of the full script on local storage, on a USB stick and on a laptop in the room.
**Why.** D-44's corollary says a seeded dataset must load in ten seconds if WiFi fails. That dataset lives in Supabase, so a total network failure takes it too. D-50 does not help: the laptop moves compute, not the network dependency.
**Cost.** An afternoon, and it will probably never be used.

### D-63 — Proxy Blur is designed and deferred; the schema split happens now
**Decision.** Not built. Written into spec §6.2 in full. The `subject` row with a nullable foreign key to the auth user is created in the first migration regardless.
**Why.** The critique that produced this was correct and mattered: the team's own draft answer to the bystander question was "ask the Admin to enable Do Not Publish on her behalf," which is not implementable. Do Not Publish is a reference embedding plus a flag, so with no embedding an Admin flipping a switch blurs nobody. Proxy Blur is the real answer and it reuses a pipeline that already exists.
**Rejected.** Building it, because it is new scope on a locked spec and competes with nothing currently at risk. Also rejected: deferring the schema split with it, because retrofitting subject-versus-account against live rows is a real migration and adding it now is a column definition.
**⚠ The contradiction to prepare for.** The headline privacy answer is that the Admin owns the event and does not own anybody's face. Proxy Blur hands the Admin power over somebody else's face. The reconciliation: every Admin power points toward privacy. He can make a person less visible, never more. The subject-controlled guarantee is about the direction of harm, and stating that before being asked is worth more than the feature.

### D-64 — Manual blur rate limiting is designed and deferred
**Decision.** Not built in v1. Written into spec §6.2: cap at 10 requests per user per event, mark the requester on each Admin revert, disable after two reverts.
**Why.** The hole is real. Each tap applies immediately, so the similarity check catches requests individually and stops none of them in aggregate. It is also unreachable with 100 seeded photos and three people who know each other.
**Rejected.** Building it now. It is a counter column and one conditional, so if it ever looks like more than twenty minutes of work, something has gone wrong with the design.
**Amended (see D-83).** The cap applies to blur regions per user per event, since tap-to-blur is gone.

### D-65 — Blur geometry and blur strength are specified, not left to the implementer
**Decision.** Expand the detection box by 30 to 40 percent, apply an elliptical mask, and blur by downsampling then upsampling with a box blur on top.
**Why.** A tight InsightFace bounding box leaves hair, ears, jawline and clothing visible, and at a wedding where the guest list is known that is still identifying. A single light Gaussian pass is also partially invertible. Both are one line in the worker and both are answerable viva questions that nobody had an answer to.

### D-66 — Retroactive reprocessing never re-runs detection
**Decision.** The reprocess job compares stored embeddings against the newly-active reference set, then regenerates variants for matched photos only.
**Why.** Every face in every photo already has an embedding from its original processing pass. Re-running the model is the expensive version of a job that is milliseconds of cosine comparison. The naive reading of "asynchronous reprocessing" is the expensive one, which is why it is stated as a rule.

### D-67 — The Supabase keep-alive runs from GitHub Actions
**Decision.** A scheduled workflow, not a cron on the compute box.
**Why.** D-38 put the keep-alive on the instance it was meant to protect against, chaining two failures together. Under D-50 it is worse, because the laptop will not be running at 3am on a Tuesday. One YAML file, independent failure domain.

### D-68 — Code comprehension is not a merge gate, and simplicity is not an instruction to the agent
**Decision.** Supersedes D-45.

1. **Never ask an agent to simplify for its own sake, and never accept a simpler rewrite that costs correctness or efficiency.** Ask for the correct implementation. Correctness and efficiency come first; readability is a distant third and is not worth a bug.
2. **Understanding the codebase is not a merge gate and is not continuous.** It happens in the Phase 7 month reserved for rehearsal, to whatever depth the defense requires.
3. **The dangerous surfaces are still read before merging**, because that is a correctness practice rather than a comprehension one. The list: any RLS policy, the image-serving endpoint's authorization check, the upload queue's state machine, and auth or invite-token handling. Each is also paired with a negative integration test (Handbook §11), which is the mechanism that actually catches the failure.

**Why.** Two separate reasons, and they point the same way.

Instructing a model to write simple code is instructing it to write different code, not clearer versions of the same code. It drops error handling, collapses edge cases, and removes the awkward branch that existed for a reason. The output reads better and is wrong more often, which is the opposite of what the rule was trying to buy.

And the comprehension gate was solving a problem the team does not have. TypeScript and Python syntax is not the obstacle; the abstract logic of the application is already shared across all three of them; a panel asks about architecture and the demo rather than a specific function. The rule also grew with generated line count while gaining nothing from generation speed, which is the shape of a rule that quietly stops being followed and then provides false assurance.

**Rejected.** Keeping a softened version of the comprehension gate. A rule that is partly followed is worse than an explicit schedule, and Phase 7 is the schedule.

**Cost being accepted, stated plainly.** Generated code nobody has read will exist in this repo outside the named list, for months. If something breaks in an unfamiliar area during demo week, the debugging starts from zero. That is judged acceptable against a month of reserved reading time and a panel that does not examine code line by line.

---

# K. Found while scaffolding the repo (2026-09-13)

Four gaps found by reading the spec, handbook and this log against each other before the first migration. Three would have failed silently. The fourth invited a stopgap that would have.

### D-69: The client thumbnail is served only for photos with no Do Not Publish face ⚠
**Decision.** The client keeps generating the 300px WebP thumbnail (spec §4.8.1 Stage 1) and PUTs it straight to R2 with its own presigned URL. It no longer travels in the pre-flight JSON. When `face_process` matches one or more Do Not Publish subjects, the worker also writes a blurred thumbnail for every file it writes, N+1 in total, at versioned keys, and points the rows at them. `reprocess` regenerates thumbnails along with the full files. A photo with no Do Not Publish face serves the client's thumbnail.
**Why.** v11 blurred every full-size file and no thumbnail. The client builds the thumbnail from the unblurred photo and the album grid shows it to every member, so a Do Not Publish face would have been clear in the grid and blurred one tap later. The pre-flight JSON also carried the thumbnail through Express, against Handbook §7.
**Rejected.** The worker writing every thumbnail, with the client never uploading one. One code path instead of two, and one fewer Stage 1 step. The reason it lost is not recorded yet (see Open items).
**What keeps it safe.** A replacement thumbnail always gets a new versioned key; nothing is overwritten in place (D-60). The row stays invisible until `processed_at`, so before the worker decides, the unblurred thumbnail reaches only its uploader (D-55).
**Cost.** ⚠ Two writers for one kind of file. The likely failure is `reprocess` regenerating the full files and forgetting the thumbnails, which throws nothing and exposes the face in the grid only. The S-25 negative test asserts on both.
**Amended (see D-83).** The client thumbnail is served only for a photo with no Do Not Publish face and no blur region (root invariant 13).

### D-70: R2 keys have one builder per key family
**Decision.** Replaces the "one place" rule in Handbook §3 and root invariant 12. The API builds upload keys, the original photo and the client thumbnail, in one function, and writes them onto the media row at pre-flight before presigning the PUT URLs. The worker builds every derived key, blurred files and blurred thumbnails, and writes those onto the rows. Neither side builds the other's keys. Whatever serves a file reads the column.
**Why.** Invariant 12 said only the worker builds keys, but the API has to presign an upload URL for a file the worker has never seen. The rule could not have been followed on the first upload, and an agent told to follow it would have invented a workaround.
**Rejected.** A Postgres function returning every key format, called by both sides. One place in the literal sense, at the cost of a round trip per key and the version-bump logic living in SQL.
**What still holds.** The drift the original rule prevented, two languages formatting the same key, still cannot happen, because each family has one builder in one language.

### D-71: Express queries Supabase as the caller ~~(SUPERSEDED by D-73)~~
> **Superseded.** Writing as the caller needs RLS write policies that the app can also use directly, skipping pre-flight. D-73 moved every API query to the secret key and made RLS deny direct access except the two Realtime reads.

**Decision.** The auth middleware builds a Supabase client from the caller's JWT for each request, so RLS applies to every API query. The secret key, which bypasses RLS, is used by the worker and by one clearly named module in `apps/api/src/db/` for operations that run before the caller has a membership row, such as resolving an invite token.
**Why.** Handbook §5 justifies RLS as the guard against one buggy Express path leaking data. With the secret key in Express, RLS would skip every API query and guard only Realtime and direct client queries.
**Rejected.** The secret key for every Express query. Simpler wiring. The team picked it first and switched once the conflict with Handbook §5 was pointed out: every Express permission check would have been the only guard, and the RLS negative tests would have covered no API route.
**Cost.** Policies now run on every API query, so the membership lookups inside them must stay indexed. Importing the secret-key module in an ordinary route skips RLS and throws nothing, so every call site counts as auth or invite-token handling and gets a human read (D-68).

### D-72: The `thumbnail_dims` warm-up job ships in Phase 3
**Decision.** Slice S-18a builds the worker skeleton (pgmq consumer loop, `/health`) and the `thumbnail_dims` job directly after S-12, with no ML dependency. Model loading and all face work stay in Phase 5. S-21 replaces `thumbnail_dims` with `face_process` on upload completion, and the two never run on the same upload.
**Why.** The album shows a row only once `processed_at` is set (D-55), and only the worker sets it. With the worker in Phase 5, the album built in Phase 3 would show nothing for two phases, and the obvious stopgap, setting `processed_at` in the completion endpoint, is root invariant 1 broken under a "temporary" label.
**Rejected.** Keeping the worker in Phase 5 and testing the album against seeded rows. It works, and it leaves the stopgap within reach for two phases.
**Watch for.** Once Do Not Publish users exist, `thumbnail_dims` is a publishing bug. It sets `processed_at` without blurring and points the public keys at the unblurred upload. On the same upload as `face_process`, it can publish the photo first or overwrite the blurred keys afterwards. S-21 deletes its enqueue, and the S-21 PR confirms nothing else enqueues it.
**Amended (see D-123).** `thumbnail_dims` acts only on a row whose `variant_version` is 0, so a message re-sent from the archive never points a row another job wrote back at the upload.

---

# L. Decided while completing ARCHITECTURE.md (2026-09-13)

The rule the team set for these: MomentLens is built for a demo, not a public deployment, so the more robust option wins only when it costs about the same to build.

### D-73: Express uses the secret key, and RLS denies direct access ⚠
**Decision.** Supersedes D-71. The API queries Supabase with the secret key and makes every authorization decision in its service layer. RLS is on for every table with no policies except `SELECT` on `media` and `event`, which Realtime needs. The app uses Supabase directly only for Auth and those two Realtime subscriptions.
**Why.** D-71 ran API queries as the caller so RLS would cover them. That holds for reads only. Writing as the caller needs RLS write policies, and the app can use those same policies directly with its own login, skipping pre-flight, for example by inserting a media row with `processed_at` already set. Face and subject data also needs per-viewer column filtering, which RLS cannot express. Fixing both meant server-only writes plus Postgres functions for every sensitive read. That costs clearly more than this option, and the risk it covers belongs to a public deployment.
**Rejected.** D-71 corrected as described above: more policies, SQL functions and two test paths. Per-table write policies with column revokes: more work than either, and a modified app could still make those writes.
**Cost.** ⚠ Handbook §5's reason for RLS no longer covers the API. A service function with a missing check returns another user's data and the database does not stop it. Every endpoint ships with a negative authorization test (another user, another event, the wrong role), and the image-serving check stays on the human-read list (D-68).

### D-74: The worker does all face matching and stores the results
**Decision.** Embeddings are stored in pgvector `vector(512)` columns. The worker runs every comparison: when a photo is processed, when a subject's references change, and on a tap-to-blur. It writes the result onto the `face` row (matched subject, similarity, Unknown cluster). The API never compares vectors; Find My Photos and the face filters are indexed lookups.
**Why.** The worker never serves live requests (Handbook §2), so request-time matching would have put the similarity logic and thresholds in SQL functions as well as in the worker. Stored results keep every threshold in one codebase.
**Rejected.** pgvector similarity queries run by the API on each request. No re-match job, and two places to keep in sync.
**Cost.** New reference photos show up in Find My Photos only after a `reprocess` run. At this scale that is milliseconds of work (D-66).
**Amended (see D-83).** There is no tap-to-blur comparison any more. The worker compares on processing and on reference changes only.

### D-75: Ukasha owns ARCHITECTURE.md, and agents write it
**Decision.** Settles the ownership open item and replaces "you maintain it by hand" in Handbook §18.1 Rule 2. Ukasha owns `docs/ARCHITECTURE.md` and decides what it says. Agents write the text. An agent changes the file only to record a decision Ukasha made or what merged code actually does, in the same PR. It never edits the file to match code that disagrees with it, and it asks instead of filling in anything undecided.
**Why.** Rule 2 exists so the source of truth does not drift with each agent session. An owner deciding every change keeps that property. Typing the text by hand adds nothing to it.
**Rejected.** Writing the file by hand, which costs the owner's time and protects nothing that the owner's review does not.
**Cost.** Ukasha reviews every PR that touches the file, which adds to the bottleneck WorkSlices already warns about.

### D-76: Development runs on the Oracle instance; the M1 demo stack goes up a month before the demo
**Decision.** Amends D-50 and Handbook §13 and Handbook §14.0 Phase 0. All three developers build against the Oracle instance on the dev Supabase project and the dev R2 bucket. The M1 demo stack (API, worker, Cloudflare named tunnel, stable project and bucket) goes up one month before the demo, at the start of Phase 7. The tunnel leaves Phase 0.
**Why.** Handbook §13 put the tunnel in Phase 0 for everyday remote testing, and the Oracle instance already gives the team a public HTTPS backend from Phase 0. The M1's advantage, faster inference (D-50), matters on demo day.
**Rejected.** The tunnel in Phase 0 as the everyday remote-testing setup.
**Cost.** The demo stack runs for the first time a month out. The M1 and Oracle share an architecture, so the remaining risk is configuration, which the Phase 7 rehearsal covers. If the M1 fails in demo week, Oracle only works as the fallback after its `.env` switches to the stable project, because the demo build logs in against stable.
**Amended (see D-78).** From 2026-10-15 development runs on a Netcup server instead of the Oracle instance, and the demo stack goes up on that same server rather than on the M1. The one-month timing stands.

### D-77: Pinch-zoom is core, as a named exception to D-44
**Decision.** Amends D-59 and D-44. The single photo viewer ships with pinch-zoom and pan (spec §2.5) in S-22, although no demo beat shows it. It is the one named exception to D-44's rule that scope is what the demo script shows.
**Why.** Spec §0 and Spec §2.5 already called it core while D-59 said "built if there is time." The team judged it small: an agent has already built it in another project.
**Rejected.** Adding a zoom moment to beat 5, which would have changed the demo script.
**Watch for.** Pan and the pager's swipe compete for the same gesture while zoomed in, and zoom has to reset when the pager moves to another photo.

---

# M. Decided after benchmarking the worker (2026-09-16)

### D-78: One Netcup server runs development and the demo from 2026-10-15 ⚠
**Decision.** Supersedes D-50 and D-51 and amends D-38 and D-76. From 15 October 2026 the API and worker run on one rented Netcup RS 1000 G12 root server (4 dedicated AMD EPYC 9645 cores, 8 GB DDR5 ECC, 256 GB NVMe, x86-64), set up by `scripts/provision.sh`. The team develops against it and the demo runs on it. The M1 is a development machine only, and there is no tunnel.
**Why.** What the team develops and tunes against is what the panel sees, so an optimization measured during development holds on demo day. Demo morning stops depending on one laptop booting and a tunnel connecting. Netcup states 99.9% minimum availability. The free tier promises nothing, and Oracle halved the Always Free A1 allowance on 15 June 2026 without announcing it.
**Measured, 2026-09-15 and 2026-09-16.** InsightFace `buffalo_l` with detection and recognition only, on 23 openly licensed wedding and group photos resized to at most 4096px.
- Time is a cost per photo plus a cost per face, because every face gets its own recognition pass. At two threads a 2-OCPU Oracle A1 instance took 0.40s per photo plus 201ms per face.
- With default threads over the whole set, that instance took 3.5 times as long as the M1.
- On one ONNX Runtime thread the M1 took 71.9s and the A1 took 170.7s, so an M1 core is 2.38 times an A1 core. Geekbench 6 single-core predicted 1.98 times, underselling the M1 by 20%.
- Threads scale on A1. Two threads ran 1.84 times as fast as one, and four ran 3.11 times as fast.
- Batching recognition gave identical embeddings and a 1 to 2% gain, so batching is not worth adding.
- Netcup is estimated, not measured. Its cores score 1.5 to 1.9 times an A1 core on Geekbench, which at four threads puts it anywhere from somewhat faster than the M1 to about 1.6 times slower on large group photos once the 20% error is allowed for.
**Rejected.** Staying on Oracle Always Free, which from 15 October is 2 OCPUs, where a median photo took 1.8s and a 40-face photo 8.4s, with no uptime guarantee. The M1 demo (D-50), which measured fastest but is a single laptop, a tunnel, and a different environment from the one the team develops against. Hetzner CPX32, at €35.49 a month after Hetzner's June 2026 price rise.
**Cost.** ⚠ About €15 a month. The server is x86-64 and the M1 is ARM64, so local and production no longer share the architecture D-38 and D-76 relied on, although InsightFace 2.0 installs as pure Python and its dependencies ship wheels for both. The network dependency on Supabase, R2 and the room's WiFi is unchanged (D-62).
**Reopen if.** The benchmark on the server, run inside Netcup's 30-day refund window at four threads, is slower than the pessimistic end of the estimate, meaning a median photo over 0.86s or a 40-face photo over 4.0s.
**Open.** How the stable stack sits beside development on one server by Phase 7 (`docs/ARCHITECTURE.md` §7). The location was settled on 2026-09-16, Nuremberg, and the demo-week fallback by D-79.
**Amended (see D-107).** This entry supersedes D-38, as D-38's heading says. "Amends D-38" above understates it.

### D-79: The standby is a rotation across three student credits, and it runs only twice ⚠
**Decision.** Amends D-38. The demo-week standby is not one untouched Azure credit. It is the team's Azure for Students, AWS and GCP credits, held across the three members and used in that order, moving to the next when one runs out. The standby VM is created for the Phase 7 rehearsal, deleted, and created again for demo week. It never runs between those two windows.
**Why.** D-38 rejected rotation for two reasons and one of them is gone: D-67 moved the Supabase keep-alive to GitHub Actions, so it no longer lives on the box that would be moving. The other, that each migration costs days, stands and is accepted knowingly. What it buys is a standby that outlives any one credit, because a VM existing for two short windows spends almost nothing, while a single credit expires on the calendar whether or not anything runs on it.
**Rejected.** A warm standby running continuously, which spends a credit to guard against something that has not happened. One provider with no successor, which is D-38's plan and ends the day that credit expires.
**Cost.** ⚠ The rehearsal proves one provider. Switching later makes it stale, and a different image or firewall model is exactly where `scripts/provision.sh` would break. Ubuntu 24.04 everywhere keeps that small, and the script refuses anything else.
**What makes it real.** Handbook §13's three criteria. The script exists. The DNS record is written down in `docs/ARCHITECTURE.md` §7, with the registrar, the A record and its 300s TTL. The rehearsal is still owed, half a day in Phase 7.

---

# N. Decided while making the docs addressable (2026-09-19)

### D-80: The docs are retrieved by id through one command, not by grepping headings
**Decision.** Every heading in `docs/` is an addressable chunk whose id is its GitHub anchor slug, scoped by file. Section numbers (`spec §4.11.4`, `hb §13.3`) are aliases computed from the heading, not the key. `scripts/docindex.mjs` parses the five docs, derives an abstract per chunk, resolves all 783 cross-references and builds the backlinks; `scripts/doc.mjs` is the only retrieval command (`doc`, `slice`, `why`, `grep`, `toc`, `check`). `pnpm docs:check` fails on a dangling citation, a code fence that is unbalanced or indented out of use, a `D-nn` heading the parser cannot read, a duplicate slug, a duplicate section number or a duplicate id, and nothing else. It reads the five docs plus every source file under `apps/`, `worker/`, `scripts/`, `supabase/`, `.github/` and `.claude/` for backlinks, so `doc why` reaches the code that enforces a decision, but only the docs and the files that route to them can fail the gate. The index is derived on every run, in about 40ms, and never written to disk, so there is no generated file to commit, to conflict on, or to go stale.
**Why.** The five docs are a relational database in heap files: 80 decisions, ~70 spec sections, 41 slices, 783 resolved cross-references, no index. The recipe this replaces made every lookup a full scan plus line arithmetic, and it was wrong: `grep -n '^#'` reports the `#` comments inside fenced blocks as headings, so agents have been seeing a phantom section in the handbook. Loading slice S-21 cost about 12 commands and 9,800 tokens of documents following the recipe the old slice skill prescribed, or about 7,000 if you already knew which lines to cut. It now costs two commands, because §4.11.4 is too large to print, and about 4,600. Decomposed over all 41 slices from the old recipe to the new command, holding one variable at a time: retrieving by line range instead of listing headings is 63% of the saving, numbering the sub-sections and narrowing the citations is 30%, and the scripts themselves are 7%. The scripts are the smallest lever and still worth keeping, because they deliver the other two by default to someone who does not know the corpus, and because they carry the warning paragraph, the phase paragraph and the superseded flags that no retrieval technique finds on its own.
**Rejected.** A precomputed transitive closure of the citation graph, which is what the first draft specified. Measured on S-21's four seed decisions, the closure saturates at **23 of 80 entries and about 7,100 tokens**, more than the retrieval it was meant to replace, and it drags in four superseded entries, D-06, D-45, D-50 and D-51. Depth 1 with one-line stubs replaced it, and the walk refuses to expand a superseded decision.
**Also rejected.** An inline `<!-- @id -->` marker above all 259 headings: an agent rewriting a paragraph reflows the region and drops a comment line that is not part of any sentence, while a heading survives because it is load-bearing text. A hand-maintained tag taxonomy and alias map, on the grounds that nobody wants a standing authoring job; the sub-part citations (`§2.1 Phase B`, `hb §14 Phase 5`) were normalized into real section numbers once instead. A committed index file, which `lint-staged`'s prettier pass rewrites after the generator writes it, failing `format:check` on the first commit. Blocking CI on abstract drift, which fires on typo fixes. The read-path staleness warning that replaced it was dropped too, after three attempts failed to make it fire on a real edit without also firing on reformats. One file per decision (`docs/decisions/D-57.md`, the adr-tools and MADR convention), which would dissolve the parser, the append conflicts and the inverted index by construction, and was rejected because the log reads as one document, the team reads it that way, and 79 files is worse for a human skimming.
**Measured.** Over all 41 slices, with `cl100k_base` and the tool-call framing counted as well as the text: 91,000 tokens and 43 calls through `doc slice`, against 89,000 and 105 calls fetching only the cited sections by hand from someone who already knows every section number, 118,000 and 146 calls fetching everything the brief carries, and 180,000 and 313 calls following the heading-listing recipe this replaced. On tokens the command and expert hand retrieval are level, and slice by slice the command is the more expensive one on 35 of 41, because every brief carries a phase paragraph, a provenance line per section and the rows of its dependencies. It earns its place on the call count and on the three things hand retrieval drops silently, not on the token count. The printed `~N tok` figures are an estimate with no dependency, fitted to this corpus against `cl100k_base`: 85% of chunks land within 10%, the corpus total within 0.1%.

**Cost.** Two scripts to keep working on three machines, one of them Windows. Every part is built to degrade to the current state rather than to a wrong answer: ids derive from headings, retrieval never throws and never exits non-zero, every section carries a number that `grep` finds without the tooling, and the grep fallback stays documented in root `CLAUDE.md` on purpose. If both scripts are deleted the corpus is still better addressed than it was before this entry. `docs/ARCHITECTURE.md` gained two `<!-- abstract: -->` comments, which record neither a decision nor merged code, so D-75 takes an explicit exception for them in this PR.
**Reopen if.** The corpus outgrows a linear scan, which at 300 chunks and roughly 45ms it is nowhere near, or the team stops running `doc` and goes back to grep, which would mean the command is not earning its place.
**Amended (see D-107).** The gate also fails on a slice row with the wrong number of cells, a Depends-on cell that holds anything but ids, a dangling citation in `AGENTS.md` or an agent file, and an unowned spec section whose children are all unnumbered.

### D-81 — Every slice opens with a read-back, and the docs are a draft rather than a contract
**Decision.** `/slice` produces a read-back before anything is written: what the slice is in one paragraph, how it would be built and which files that touches, what interface it inherits from the slices it depends on and what later slices will read from it, every edge case with "the docs do not say" where that is the honest answer, everything the docs get wrong about it with section ids, and the invariants and human-read surfaces it touches. Work stops there until the owner says go or fixes the docs for that slice and its dependencies. Alongside it: the docs are a draft. An agent that finds two sections disagreeing says so and proposes the wording instead of picking one or inventing a reading that reconciles them. The numbered invariants in root `CLAUDE.md` and the entries in this file are decisions rather than descriptions, so those get raised and ruled on rather than routed around, and `docs/ARCHITECTURE.md` still wins over the spec and the handbook when they disagree (D-75).
**Why.** Eight reviews of the corpus found something real every time, and the last three were still finding contradictions that would have produced wrong code: a handbook paragraph that told you to drop the two RLS policies the project needs, two spec sections disagreeing about a cap, a job with two different trigger lists. Fixing the documents ahead of time is unbounded, because the next review finds the next thing. Fixing them one slice deep, at the moment someone is about to build that slice, is bounded and happens when the reader has the most context they will ever have about it. It also stops the failure this corpus makes easy: an agent reading a contradiction, choosing the reading that lets it proceed, and building from it silently.
**Cost.** One more stop before every slice, and the owner has to read it. That is the trade: one round of reading against a class of silent bug that has appeared in every audit so far. The read-back is also where the docs stop being a thing to be defended, which is a real change in posture for a corpus this heavily cross-referenced.
**Reopen if.** Three consecutive read-backs turn up nothing worth fixing, which would mean the corpus has converged and the stop is pure overhead.

---

# O. Found in the whole-corpus audit (2026-09-23)

Written by the audit and ruled on by Ukasha the same day. D-82 and D-84 to D-87 were accepted. The audit's draft of D-83, a refusal rule for tap-to-blur, was rejected, and D-83 records Ukasha's ruling instead.

### D-82: Pre-flight resumes a crashed upload and enforces every upload rule the API owns
**Decision.** Pre-flight checks, in order: the caller is an active member, the event is not deleted and the album is open; then the hash; then, for a new row, the 2,000-photo cap and verification. A row with the same hash that the same caller created and never completed is not a duplicate: pre-flight re-signs PUT URLs for its existing keys, and a resumed upload skips the cap and verification it already passed. `media.uploaded_at` marks completion. The completion call sets it only while it is null and enqueues the job in the same transaction, so a retried completion enqueues nothing.
**Why.** Pre-flight inserts the media row, hash included, before any byte reaches R2. An app killed between pre-flight and completion retries on the next launch, the dedup lookup finds its own unfinished row, and the photo is rejected as a duplicate with no prompt. The queue marks it done and the row never gets processed. That is the upload queue's state machine losing a photo with no error (D-68). Separately, album state (D-12), membership and the upload cap were enforced only in the app, and D-73 puts every rule in the API.
**Rejected.** Inserting the row at completion, which breaks D-70, because the upload keys go onto the row before the PUT URLs are signed. Asking R2 whether the object exists, which puts a network call inside the endpoint that must stay cheap.
**Cost.** The album-open check blocks every upload until an Admin opens the album, and the toggle only arrives in S-31. S-12 builds the check switched off and S-31 turns it on, as Phase 3 does with the verification gate.
**Amended (see D-95 and D-96).** Pre-flight's insert and completion run in SQL functions, completion checks both objects in R2, and another user's unfinished row with the same hash is not a duplicate.
**Amended (see D-122).** Verification comes before the cap, which `start_upload` counts. When the caller's own unfinished row and another user's finished row share the hash, pre-flight resumes and completion answers `duplicate`.

### D-83: Tap-to-blur is removed; a missed face is fixed with a blur region anyone can draw ⚠
**Decision.** Supersedes D-23, D-25, D-47, D-52 and D-54; amends D-24, D-26, D-64 and D-74. Automatic matching blurs a face that matches a Do Not Publish subject at or above the match threshold, and nothing else is blurred automatically. There is no tap-to-blur and no Admin queue for loose matches. Any Guest or the Admin can draw a rectangular blur region on a photo in the album. It applies at once to the public file, every subject's file and all their thumbnails, is stored in `manual_blur_region`, and every later regeneration applies it (root invariant 6). The person who drew it and the Admin can remove it. With no tap-to-blur there are no auto-added references, so every reference is one the user uploaded.
**Why.** Tap-to-blur needs a detected face to tap, and the miss that matters most is a face the detector never found, which a region covers and a tap cannot. A queue for loose matches would flood: at a wedding of relatives a loose match is usually a cousin, so it would flag almost everyone against someone. The Admin is busy all night and guests care about their privacy, so a blur that applies at once with a restore as the fallback beats a face left visible while it waits for anyone.
**Rejected.** The audit's first draft of this entry: keep tap-to-blur and refuse a tap on a face already matched to another subject. A loose-match band sent to the Admin, blurred or visible while it waits.
**Cost.** ⚠ Any Guest can blur any part of any photo until its drawer or the Admin removes it. D-23's similarity check no longer stands between a guest and the bride's face, so abuse is caught only by the Admin looking at the Review Queue. A face below the match threshold stays visible until someone draws a region over it. D-64's rate limit is the designed answer if abuse ever appears.

### D-84: Joining an event re-matches the new member's references
**Decision.** When a subject with references becomes an active member of an event, by auto-approve or by an Admin's approval, the API enqueues `reprocess` for that subject in that event.
**Why.** `face_process` matches against the subjects who are active members at the moment a photo is processed (D-74). A Do Not Publish user who joins after photos were uploaded stays unblurred in all of them, and nothing reruns the match. The same gap leaves Find My Photos missing every photo taken before the user joined.
**Rejected.** Matching against every subject in the system, which D-74 and spec §4.11.4.5 scope to event members on purpose.
**Cost.** One enqueue on each join path. The job is milliseconds of cosine comparison (D-66).
**Amended (see D-129 and D-141).** References belong to one event, so a new member has none there and the join enqueues nothing. The job runs for a removed member who rejoins, whose references in the event survived the removal.

### D-85: A Venue QR verifies the sub-event running at its venue when it was scanned
**Decision.** The QR payload carries the venue and its `qr_secret`, never a sub-event. The device stores the scan time with the payload. At pre-flight the API checks the secret and writes a `venue_verification` row for the sub-event at that venue that was In Progress at the scan time, by spec §4.3's rule. A scan while nothing at that venue was In Progress verifies nothing.
**Why.** `docs/ARCHITECTURE.md` §2 prints one QR per venue, shared by every sub-event there. Spec §2.5.1 said the payload names a sub-event, and D-15 makes verification per sub-event. With one QR per venue and no time rule, a scan at the mehndi would verify the nikkah held in the same hall, which is the case D-15 rejected.
**Rejected.** One QR per sub-event, which puts near-identical posters on one wall and leaves the Guest to pick the right one. Verifying every sub-event at the venue, which is simpler and breaks D-15.
**Cost.** The scan time comes from the device clock, so a modified client can choose it. The gate was never a security boundary (D-16).

### D-86: The image cache key is the signed object key plus `variant_version`
**Decision.** Amends D-57's cache-key mitigation. The serving endpoint returns, with each presigned URL, a cache key built from the object key it signed and the row's `variant_version`, and a flag saying whether the file is the requester's own variant. `expo-image` caches under that key, and the flag drives the self-visible marker. Logging out clears the image disk cache. The endpoint takes a batch of media ids, so a grid page costs one request.
**Why.** A key of media id plus version is the same for the public file and a subject's variant. On a shared phone, and the demo hands team phones around (D-61), the next account to log in would get the subject's unblurred variant from the disk cache. An object key names one file whose bytes never change (D-60), so it cannot hand one viewer another's file. The app also had no way to know when to draw the marker, since it never learns who the subjects are.
**Rejected.** Caching by URL, which rotates every hour and defeats the cache. Deriving the marker on the client, which needs subject identity the client must not have (root invariant 4).

### D-87: Do Not Publish always keeps a reference to match on
**Decision.** Amends D-56. Activation counts accepted `face_reference` rows, those in which the worker found exactly one face (D-91), so a photo still being processed, or one the worker rejected, does not unlock activation. While Do Not Publish is active, the API refuses to delete the last accepted reference.
**Why.** D-56 blocked activation without a reference, and nothing stopped the user deleting every reference afterwards, which puts the badge back to reading "Active" while it protects nobody. "Has a reference photo", the spec's wording, was also true before `reference_process` ran and when the photo held no usable face.
**Rejected.** Allowing the deletion behind a warning, which is the failure D-56 exists to prevent.
**Amended (see D-83).** The audit's draft also made `is_curated` a generated column. With no auto-added references that column has nothing to distinguish, and it is dropped.
**Amended (see D-91).** A reference counts only once `reference_process` has accepted it with exactly one face. A pending or rejected one does not.
**Amended (see D-129 and D-141).** References and the flag are both per event. Activation in an event counts accepted references in that event, and the API refuses to delete the last one there while that event has Do Not Publish on.

---

# P. Ukasha's rulings on the audit (2026-09-23)

### D-88: A sub-event ends at its scheduled end, and the event spans its sub-events
**Decision.** Supersedes D-19; amends D-20. A sub-event is In Progress from its start to its end. The event runs from its first sub-event's start to its last sub-event's end, computed on read and never stored, so an event needs at least one sub-event and the 14-day cap applies to that span. There can be stretches inside the event when no sub-event is In Progress, and the capture FAB is hidden then (D-20). When a sub-event runs late, the Admin delays it.
**Why.** Sub-events are planned across several days, and the host knows ahead of time when one will run late or move. Adjusting one with Delay takes under a minute. D-19's rule kept a sub-event open until the next one started, which across a multi-day event holds capture open overnight.
**Rejected.** D-19's rule, In Progress until the next sub-event starts.
**Cost.** A sub-event that overruns closes capture at its scheduled end until the Admin delays it, which is the failure D-19 was written for: a late baraat with no in-app camera. "+ Add Media" is not time-gated, so photos taken with the phone's own camera can still be added to that sub-event afterwards.

### D-89: Verification belongs to the person, and photos carry no location
**Decision.** Amends D-16 and D-36. A `venue_verification` row is for one person and one sub-event. When the device's local GPS check passes, it stores that one reading with its time, as it stores a Venue QR scan (D-85), and sends it with the next pre-flight. The server checks the reading against the venue and the sub-event In Progress at that time, then writes the row. Photos carry no location, so a photo taken with location off, or imported from the gallery, uploads once the person is verified for its sub-event.
**Why.** Some guests keep location off, and a gallery import was never captured by the app, so neither has a capture-time reading. Verification was always about the person being there. The photo's own location added nothing but a way to fail.
**Rejected.** A reading attached to every photo, the previous design, which blocks gallery imports and location-off photos. Reading the GPS out of a gallery photo's EXIF.
**Cost.** The person has to be at the venue with GPS on at least once during the sub-event, scan its QR, or be Force Verified. Less location data leaves the phone than before: one reading per sub-event instead of one per photo.

### D-90: A Public capture is also saved to the phone's gallery
**Decision.** Amends D-34. A photo captured in Public mode is saved to the phone's gallery as the camera took it. A Local Only capture is not. The copy that uploads is the stripped one (spec §4.8.1).
**Why.** Guests expect photos from a camera to appear in their camera roll.
**Rejected.** Keeping Public captures out of the gallery.
**Cost.** The gallery copy keeps its EXIF, location included, and syncs wherever the phone syncs its gallery, like any camera app's photo. The app needs write access to the gallery, which `expo-media-library` already provides for downloads.

### D-91: A reference photo must show exactly one face
**Decision.** Amends D-56 and D-87. The API records a new reference photo as `pending`. `reference_process` accepts it with its embedding when it finds exactly one face, and otherwise rejects it as `no_face` or `multiple_faces`. The app waits for that status and shows the reason, for several faces: "Multiple faces detected. Please upload a solo photo where only your face is visible." A profile photo with no face or several is still the avatar, but it is not used as a reference. Only accepted references count toward activation and the last-reference rule.
**Why.** An embedding from a group photo may be someone else's face, which would blur the wrong person and miss the subject.
**Rejected.** Rejecting with a 400 at upload, which needs face detection in Express, against root invariant 5 and the rule that the worker never serves live requests (Handbook §2). Taking the largest face, which is a guess.
**Cost.** The rejection arrives a few seconds after the upload rather than with it, so the app polls the reference until the worker has decided.

**Amended (see D-141).** A profile photo is never a reference, so it gets no check. Each reference photo belongs to one event, and the one-face rule applies to each.
### D-92: The worker runs `buffalo_l`
**Decision.** The worker uses InsightFace's `buffalo_l` model pack, with the detection and recognition modules only, the configuration D-78 benchmarked. `buffalo_s` is not a fallback.
**Why.** Blur and Find My Photos both rest on recognition accuracy, and a missed match is the costly failure (spec §4.11.4.5). `buffalo_l` is the more accurate pack, and D-78's timings were measured on it, so the latency the team knows is the latency of the model it ships.
**Rejected.** `buffalo_s`, faster with lower accuracy, which trades away the one property a missed blur costs.
**Cost.** A larger model and slower recognition on large group photos: D-78 measured about 200ms per face at two threads on the free-tier instance.
**Reopen if.** The benchmark on the Netcup server misses D-78's bar.

### D-93: The image-serving endpoint is built in two steps, S-13 then S-21
**Decision.** Changes the slice plan, not D-57. S-13 builds the one image-serving endpoint: a batch of media ids, the check that the requester may see each one (`docs/ARCHITECTURE.md` §1), the public file and public thumbnail only, and the cache key (D-86), with its negative test written first. S-21 adds the subject's own file and the own-variant flag to that same endpoint. There is still one endpoint and one check.
**Why.** The album grid in Phase 3 has to show photos, and the endpoint used to arrive in Phase 5. Whoever built S-13 would have written a second serving path, against root invariant 3, or waited two phases.
**Rejected.** A stopgap path in S-13 that S-21 replaces, which is the second path under another name. Moving S-13 after S-21, which leaves Phase 3 unable to show its own uploads.
**Cost.** The serving check, a human-read surface, moves into Phase 3 and into B's slice, so Ukasha reads S-13's PR. S-13's brief grows by about 2,800 tokens, to about 8,900, the largest in the plan (estimated).

### D-94: One set of API conventions for paths, errors and status codes
**Decision.** Handbook §5.3 holds them. Paths are plural nouns under the resource that owns them. Bodies are JSON with camelCase fields, named as the zod schemas name them. Every error has one body, `{ "error": { "code", "message" } }`, whose schema is `ErrorResponse` in `packages/shared-types`, and `code` is a snake_case string the app switches on. Status codes: 400 invalid input, 401 no session, 403 not an active member or the wrong role, 404 not found or deleted, 409 a state conflict such as a duplicate, a closed album or an unverified uploader, 422 a limit reached.
**Why.** No doc named a path, an error body or a status code beyond `GET /health`, so every slice's schema stage would have invented its own and the app would need an error parser per screen.
**Rejected.** Leaving it to each slice.
**Cost.** One schema and one handbook section, written before S-01.
**Amended (see D-109).** The handbook section came before S-01. The `ErrorResponse` schema did not, and S-01's schema PR writes it, as Handbook §5.3 says.

### D-95: Pre-flight's insert and completion run in SQL functions
**Decision.** Amends D-82. The API calls both with `rpc`, because supabase-js holds no transaction and pgmq is not on the Data API.
- `start_upload` locks the event row, counts the event's media rows that are not soft-deleted, finished or not, refuses at 2,000, and inserts the new row with its upload keys.
- Before completion the API sends R2 a HEAD for both objects. If either is missing it answers `upload_missing` and the phone uploads again. It does not check the album a second time.
- `complete_upload` checks that the caller uploaded the row, sets `uploaded_at` while it is null, stores the photo's size from the HEAD, and sends exactly one message to pgmq, all in one transaction. A repeated call changes nothing and answers `completed`. It answers `duplicate` when another finished row in the event has the same hash (D-96).
**Why.** Updating the row and enqueueing in two calls looks right, throws nothing, and loses the job on a crash between them. An unlocked count lets two pre-flights at 1,999 both insert. A completion with nothing behind it in R2 leaves a row the worker can never process, which never gets `processed_at` and fails in silence.
**Rejected.** Two supabase-js calls. The HEAD in pre-flight, which D-82 rejected for cost; completion runs once per photo.
**Cost.** Two migrations in S-12, two R2 requests per completion, and a row lock on every new-row pre-flight.
**Amended (see D-122).** Both functions lock the event row `FOR NO KEY UPDATE` and decide the hash outcome under the lock. Completion looks up the row and checks the uploader, the membership and the event before the HEAD, and a row that no longer exists answers `duplicate`.

### D-96: A duplicate is a finished photo with the same bytes, deleted or not
**Decision.** Amends D-53 and D-82. `media.content_hash` is unique per event among rows with `uploaded_at` set, soft-deleted rows included. Pre-flight treats a finished row with the hash as a duplicate even when it was deleted. The caller's own unfinished row is a resume (D-82). Another user's unfinished row is not a duplicate: both upload, the first to complete wins, and the second completion deletes its own row and objects and answers `duplicate`.
**Why.** One guest's crashed upload blocked every other guest's copy of the same photo, often the same forwarded image, until that guest reopened the app, which might be never. Treating a deleted photo as new would let a restored photo collide with its re-upload.
**Rejected.** An index that skips deleted rows, which makes Restore fail once the photo was uploaded again.
**Cost.** A photo someone deleted can never be uploaded to that event again. Two guests can both spend the upload on the same photo before one of them loses.
**Amended (see D-122).** Two completions of one hash take turns on the event lock, so the second answers `duplicate` instead of failing on the unique index.
**Amended (see D-130).** A deleted photo is no longer a duplicate. The hash is unique among finished rows that are not deleted, so the same bytes upload again as a new photo. Nothing restores the old row, so the collision this entry guarded against cannot happen. A finished photo that is not deleted still blocks its copies.

### D-97: S-11 owns the phone's upload loop and its queue states
**Decision.** S-11 builds the loop that sends pre-flight, PUTs both files, calls completion and moves each queue item to the state its answer leads to. `docs/ARCHITECTURE.md` §4 holds the table from each answer to a state. S-10 builds the queue's storage and its badges. S-11 is a human-read slice (D-68). It depends on S-12, and S-12 now depends on S-03 and S-04 for its tables instead of on S-11.
**Why.** No slice claimed the transitions, which are the upload queue's state machine, and nothing said what each pre-flight answer does to an item.
**Rejected.** Splitting the loop between S-10 and S-12.
**Cost.** S-11 grows and needs a human read.

### D-98: Pre-flight carries the capture time
**Decision.** The phone sends the photo's EXIF capture time with pre-flight. When the photo has none, the API uses the time of the pre-flight. `media.captured_at` holds it.
**Why.** `captured_at` was a column nothing wrote. The API cannot read the file (root invariant 5), and no worker job set it.
**Rejected.** The worker reading EXIF, which adds a write after publishing and leaves the order unknown until it runs.
**Cost.** One field in the pre-flight schema. The phone's clock and EXIF are trusted, which only affects sort order.

### D-99: Stage 1 rotates the pixels, and every box and region is a fraction of the stored image
**Decision.** Stage 1 applies the EXIF orientation tag to the pixels, then strips the tag with everything else but the timestamp, so the uploaded file is upright and carries no orientation. Every face box and every blur region is stored as fractions of that file's width and height, so one set of numbers fits every file and thumbnail of the photo.
**Why.** The phone kept the orientation tag. An app drawing on the rotated image and a worker reading raw pixels disagree about where a rectangle is, and the wrong area gets blurred with no error.
**Rejected.** Keeping the tag and trusting every reader to honour it, which is one missed flag away from a silent leak.
**Cost.** It replaces "keep timestamp and orientation" in spec §4.8.1. Stage 1 already re-encodes the file.

### D-100: A sub-event with photos cannot be deleted, and editing one moves nothing
**Decision.** The Admin can delete a sub-event only while it has no photos, and never the event's last one (D-88). Editing a sub-event's name, venue or times moves no photo and no `venue_verification` row. Other phones learn of an edit or a Delay when they next fetch the event, on foreground and on reconnect. `sub_event` has no Realtime.
**Why.** Nothing said what deleting or moving a sub-event does to the photos in it, and a guess either deletes photos or leaves them with no section.
**Rejected.** Moving a deleted sub-event's photos into another one, which mislabels them without telling anyone. Realtime on `sub_event`, which needs a third RLS policy (D-73).
**Cost.** A sub-event that already has photos can only be renamed or moved, not removed.
**Amended (see D-121).** Other phones learn of an edit or a Delay from `GET /events/{eventId}/sub-events`, which the app refetches on foreground and on reconnect. The photo check on delete arrives with S-12's `media` table.

### D-101: The invite link is the `momentlens://` scheme, for now
**Decision.** An invite link is `momentlens://invite/{token}`. It opens the app when the app is installed and the chat app hands the link to the system. Where it does not, the person types the 6-character shortcode (spec §4.1). https App Links and Universal Links wait.
**Why.** The scheme needs nothing on the server, and the shortcode already covers every chat app that will not open it.
**Rejected.** https links on the demo domain now, which need `.well-known` files on nginx and matching app configuration.
**Cost.** Some chat apps show the link as plain text, so a guest there joins by code.
**Reopen if.** Joining by code is where the demo stumbles.

### D-102: One Admin per event, the 150 cap counts Guests, and removal is a state
**Decision.** Amends D-33. An event has exactly one Admin, its creator. A role change moves someone between Guest and Photographer only. The 150 cap counts `active` Guest rows; the Admin and Photographers do not count. Remove from Event sets the membership to `removed`: the person sees Access Removed, their uploads stay in the album, and they may join again through a live invite. Block sets `blocked`, and a blocked person cannot rejoin.
**Why.** Spec §1 has one Admin while a flow still offered promote and demote. `docs/ARCHITECTURE.md` counted every active row toward a cap the spec calls a guest count. Remove from Event had no state to land in.
**Rejected.** Co-Admins, which the spec never designed. Deleting the row on removal, which makes a removed person look like a stranger to the app.
**Cost.** An Admin who loses their phone cannot hand the event to someone else.

### D-103: The worker reads one queue, one message at a time, and removes what it replaced
**Decision.** Every job is a message on one pgmq queue, `jobs`, carrying the job's name and the ids it needs (`docs/ARCHITECTURE.md` §5). The worker handles one message at a time, oldest first. A message that fails three times is archived and logged, and reported to Sentry once the worker has it; a failed `face_process` leaves its photo unpublished rather than out unblurred. After a regeneration commits, the worker deletes the objects the rows no longer point at, never `upload_key` or `upload_thumb_key`. A retry may rewrite a versioned key that no row points at yet.
**Why.** D-84's join path and every `variant_version` bump assumed two jobs never write one photo at once, and no doc said so. A URL presigned before a retroactive blur kept serving the unblurred file for up to an hour, because the old object was never deleted.
**Rejected.** One queue per job, which loses the order between two jobs on the same photo. Retrying forever, which hides a broken job.
**Cost.** One slow photo delays every job behind it. A viewer looking at a replaced file gets one failed load and re-resolves. A `reprocess` or `blur_region` that fails three times leaves a published photo with its previous files, which can still show a face that should now be blurred; that is an open item below.
**Amended (see D-108).** A message about a photo that fails three times now also clears that photo's `processed_at`, so a failed `reprocess` or `blur_region` never leaves it up with its previous files.
**Amended (see D-123).** A try is a read, counted by pgmq's `read_ct`, and a failed message is read again before any newer one. One worker reads `jobs` at a time, through a Postgres advisory lock. A job's writes commit with its message's delete.

### D-104: Until S-26 measures, matching fails closed
**Decision.** The worker reads its thresholds from configuration that mirrors `docs/ARCHITECTURE.md` §6. While §6 says "not measured", it blurs every detected face in every file it writes, subjects' own files included, and records no match on `face` rows. Tests set a threshold in their own fixtures, never in configuration.
**Why.** S-20 and S-21 come before S-26, which needs them in order to measure. Without a rule the stopgap is an example number, which is how the blur silently fails in a demo (Handbook §11.4).
**Rejected.** A provisional number, however low, which nobody remembers to replace.
**Cost.** Until S-26, Find My Photos returns nothing and no subject sees their own face clear, so the self-visible marker cannot be shown on real data before then.

### D-105: Smaller build rulings from the pre-feature audit
**Decision.** Each of these was a fact an agent would otherwise have guessed.
- The sub-event status function lives in `packages/shared-types` as one pure function, so the capture button and the API's scan-time check agree. Its unit tests run in `apps/api`'s Jest suite, since the package has no test runner.
- "Upload over Mobile Data" and the default Viewfinder mode live on the phone in MMKV. The push toggles stay on the server as `profile.notify_approval` and `profile.notify_album`, because the server decides whether to send.
- S-12 adds `@aws-sdk/s3-request-presigner` to `apps/api`, approved here.
- Presigned PUT URLs live 15 minutes.
- "300px" is the thumbnail's long edge. The grid crops it to a square when it draws.
- Stage 1 converts every file that is not JPEG to JPEG, HEIC included, so `upload.jpg` is always true.
- When S-21 merges, the dev project's photos are wiped and reseeded through the real pipeline, because photos processed by `thumbnail_dims` have no `face` rows for `reprocess` to match (root invariant 10).
- Demo beat 5 shows the activation screen on a second team account with no accepted reference, then switches to the prepared account.
- A subject finds a missed face by browsing the album for photos of themselves without the marker. Find My Photos lists only faces the system matched, so it cannot show a miss.
**Why.** The audit found each one unstated.
**Cost.** `packages/shared-types` holds one function besides its schemas.
**Amended (see D-109).** S-01 adds `@aws-sdk/s3-request-presigner`, with `@aws-sdk/client-s3`, for the avatar function, so S-12 finds both installed.
**Amended (see D-110).** `packages/shared-types` holds a second function, the one that sorts an event into Active, Upcoming or Past.
**Amended (see D-121).** The status function is two, `subEventStatus(subEvent, at)` and `currentSubEvent(subEvents, at)`. Both take an instant, so the API can ask at a reading's time.

### D-106: The RLS negative test runs in CI against the dev project
**Decision.** Keeps D-73's access model and changes where its test runs. A workflow runs `apps/api`'s `test:rls` against the dev project on every pull request that touches `supabase/` or `apps/api/`, with the dev project's URL, publishable key and secret key as repository secrets. The stable project's secret key never reaches GitHub.
**Why.** The only RLS negative test had run on no machine. `pnpm test` skips it without the keys, and CI had none. An RLS mistake fails silently (root invariant 14).
**Rejected.** A Definition-of-done line saying someone ran it by hand, which was the rule before and never happened.
**Cost.** GitHub holds a key that bypasses RLS on the dev project's data. A pull request from a fork gets no secrets, so the job skips there.

### D-107: Process rulings from the pre-feature audit
**Decision.** Amends D-80.
- A slice's `docs/ARCHITECTURE.md` change is written by its done stage, as its own commit on the slice branch, and Ukasha approves it there (D-75). The build stage still never edits `docs/`.
- `slice-verifier` is pinned to `claude-sonnet-5`. `slice-auditor` inherits each developer's session model.
- Both agents are read-only by instruction, not by enforcement: they keep Bash, which can write.
- The writing rules live in Handbook §18.7, so every developer's agent follows them.
- `main` takes changes only through pull requests, with one review and a passing CI run.
- The docs gate also fails on a slice row with the wrong number of cells, a Depends-on cell that holds anything but ids, a dangling citation in `AGENTS.md` or an agent file, and a spec section whose children are all unnumbered when nothing owns it. The pre-commit hook runs it on the staged snapshot.
- D-78 supersedes D-38, as D-38's heading says. "Amends" in D-78 understates it.
**Why.** The audit found each one missing, wrong, or held on one machine only.
**Rejected.** A hook enforcing read-only agents, about 40 lines of script for a risk the prompts already name.
**Cost.** A pinned model id needs a bump when models change. A docs PR waits for a teammate's review.
**Amended (see D-113).** While the other two are away, Ukasha merges after `/code-review` and CI, with no teammate's review.
**Amended (see D-116).** D-113's exception has ended. A slice's stack gets its one review after the done stage, and merges from the top down with Rebase and merge.
**Amended (see D-117).** The review is a code owner's, and a code owner's own PRs need CI and `/code-review` instead.

### D-108: A job that keeps failing on a photo unpublishes it
**Decision.** Amends D-103. When a message about a photo fails its third try, the worker archives it and clears that photo's `processed_at` if it was set. The photo leaves the album, and its uploader sees it as processing in My Media. The serving endpoint stops signing it at once, because its visibility check needs `processed_at` (`docs/ARCHITECTURE.md` §1), and other phones drop it on their next fetch of the event. To run the job again, send the archived message back to `jobs`; on success the job sets `processed_at` last, as always.
**Why.** A failed `reprocess` or `blur_region` left a published photo with its previous files, which can still show a face that was just made Do Not Publish or just blurred. This fails closed, like D-104: a missing photo is visible and fixable, and a leaked face is neither.
**Rejected.** Keeping the previous files, D-103's first answer. Letting the `media` policy pass the unpublished row so Realtime removes it live, which would also hand members rows that were never processed, against the Realtime test in Handbook §11.3.
**Cost.** The photo is gone from the album until someone re-queues the job, and only the log says so, and Sentry once the worker has it. A URL already signed stays valid for up to an hour, and a phone that already shows the photo keeps it until its next fetch.
**Amended (see D-123).** The archive and the clearing of `processed_at` commit in one transaction, and the worker reports each archived message to Sentry.

### D-109: Auth rulings from S-01's read-back
**Decision.** Amends D-35, D-94 and D-105. Ukasha ruled on each of these on 2026-09-24.
- A `security definer` trigger on `auth.users` creates the `profile` row from the `full_name` the app sends as signup metadata. It trims the name and refuses one outside 1 to 80 characters, so that signup fails and no account exists without a profile.
- Email confirmation is off in both Supabase projects, because the invite path (spec §4.1) and D-61's pre-signed phones need a session straight after signup. Passwords need at least 8 characters.
- The recovery email links to `momentlens://reset-password`, allow-listed in both projects, through supabase-js's PKCE flow. The link works on the phone that asked for it, and the reset screen says so when it fails anywhere else. If the app dies on the new-password screen, the recovery session stays signed in and the old password still works.
- Reset mail goes through Supabase's built-in sender, which delivers only to the project team's addresses, 2 messages an hour (checked 2026-09-24). A demo beat that shows a reset needs custom SMTP first.
- The API verifies a JWT with supabase-js `getClaims`. Both projects sign with an asymmetric key, so the check runs against the cached JWKS with no call to Auth.
- The app signs out with `local` scope, so the account's other device stays signed in (spec §4.1). On a 401 it refreshes the session once and retries the request once. It shows Forced Logout only when Supabase rejects the refresh token. A network error never logs anyone out.
- A Do Not Publish user's avatar is shown to the user and nobody else, the Admin included (D-35). Otherwise it reaches the same people as `profile.full_name`, so a Photographer sees no other member's (D-08).
- Reference photos, the `profile` one included, are presigned for their owner and nobody else, with or without Do Not Publish (arch §3).
- S-01 builds no profile photo upload. S-20 builds it, for signup (spec §2.1.1) and for Settings, because setting one can create the subject and the `profile` reference with its `reference_process` message (arch:face_reference).
- Signup ends at Home. S-31's consent gate blocks any account with no `consent` row for the current policy version, so it also catches the accounts made before it lands.
- `ErrorResponse` is written in S-01's schema PR, as Handbook §5.3 says. D-94 placed it before S-01.
- The app keeps the Supabase session in MMKV. S-01 adds `@supabase/supabase-js` 2.116.0 to `apps/mobile`, the version `apps/api` already runs, and `@aws-sdk/client-s3` with `@aws-sdk/s3-request-presigner` to `apps/api`.
- S-01's one endpoint is `GET /profiles/me`. It returns the caller's profile, with the avatar from the one avatar function.
- `profile` and `subject` reference `auth.users` with `ON DELETE CASCADE`. `SET NULL` would turn a deleted account's subject into a Proxy Blur subject (D-63). `subject.user_id` is unique where it is not null. `notify_approval` and `notify_album` default to true.
**Why.** S-01's read-back found each one unstated or contradicted.
**Rejected.** Creating the profile with an API call after `signUp`, which leaves an account with no profile when the app dies in between. `getUser` on every request, a round trip to Auth each time. supabase-js's default global sign-out, which logs out the other device. Hiding a Do Not Publish user's avatar and reference photos from the user too, which protects them from nobody and leaves them managing references they cannot see. `expo-secure-store` for the session, a native package and a rebuild on every machine.
**Cost.** A mistyped email can never reset its password. An access token stays valid until it expires, up to an hour after sign-out, because Supabase cannot revoke one. The session tokens sit unencrypted in the app's sandbox. Until S-20 lands nothing sets `avatar_key`, so only unit tests exercise the avatar function.
**Amended (see D-129).** The avatar is hidden from everyone but the user only where an event in which their membership has Do Not Publish on shows them.

### D-110: Event rulings from S-02's read-back
**Decision.** Amends D-105. Ukasha ruled on each of these on 2026-09-25.
- S-02 writes the `membership` migration along with `event`, `venue` and `sub_event`, and creates the creator's `admin` row with the event (D-102). S-03 adds join requests to a table that already exists.
- One SQL function, `create_event`, called with `rpc`, inserts the event, its venues, its sub-events and the Admin's membership in one transaction, as D-95 does for uploads. S-03 adds the two invite inserts to it.
- The app sends a uuid `requestId` with every create, stored in `event.create_request_id`. A repeat from the same caller returns the first event and creates nothing. Another caller's `requestId` never returns that event.
- `approval_mode` defaults to `auto`. The approval queue arrives with S-07 in Phase 2, so a `manual` event made before it could let nobody in.
- The Events tab sorts an event by its span (D-88). Upcoming is before its first sub-event starts, Active runs from then until its last sub-event ends, gaps included, and Past is after that. An archived event is Past whatever its span. The list shows events where the caller's membership is `active` and hides soft-deleted ones. One pure function in `packages/shared-types` does the sorting, beside D-105's sub-event status function.
- A sub-event's venue is the event's venue, one already added in the wizard, or a new one. Two sub-events at the same hall share one `venue` row and one QR (spec §4.3).
- One verification radius, `event.verification_radius_m`, applies to all of an event's venues.
- The cover is optional and is uploaded after the event exists, because its key carries the event's id (arch §3). The Admin gets a presigned PUT from `POST /events/{eventId}/cover-upload`, uploads, then sends the key to `PUT /events/{eventId}/cover`, which HEADs the object and sets `cover_key`. If the upload fails the event has no cover. S-07a replaces a cover through the same two endpoints.
- The cover never passes through the worker, so a Do Not Publish guest in it shows unblurred to every member. Spec §6.2 defers the fix.
- Root invariant 3's one endpoint serves media files. A cover or an avatar is presigned by the endpoint that returns its event or profile, after that endpoint's own check (arch §3), as S-01's avatar function already does.
- The Android venue map uses Google Maps through the `react-native-maps` config plugin, with a key from a Google Cloud project Ukasha owns. The key is restricted to the app's package and signing certificate and never committed. iOS uses Apple Maps and needs no key.
- Start and end times use `@quidone/react-native-wheel-picker` 1.7.1, which S-02 adds to `apps/mobile`. It is JavaScript only, so no machine rebuilds for it.
- Times are `timestamptz`, shown in the phone's time zone. The 14-day cap is 336 hours from the first start to the last end. A sub-event may start in the past.
- `event.type` is `wedding`, `engagement` or `other`. Names of events, venues and sub-events are trimmed, then 1 to 80 characters, and a description is at most 500.
- `POST /events` checks every limit in its body, so a breach answers 400 `invalid_request`. S-02 adds no error code.
- `venue.qr_secret` is 32 random bytes. No S-02 endpoint returns it.
- The wizard's draft lives in memory, so killing the app loses it. S-02 builds no `GET /events/{eventId}`, and creating an event lands on a placeholder until S-08 and S-13 build the event's Home.
**Why.** S-02's read-back found each one unstated or contradicted.
**Rejected.** S-03 writing `membership`, which leaves S-02 no way to record its Admin or list anyone's events. Four separate supabase-js inserts, which leave an event with no Admin when the API dies between them. `manual` as the default. A new `venue` row for every sub-event with a custom venue, which prints two QRs for one hall. Address search with no map on Android, which can put the venue 100 m off the hall inside a 200 m radius. `@expo/ui`'s DatePicker, which needs separate iOS and Android code.
**Cost.** A Google Cloud project with billing turned on, and one native rebuild on all three machines for the map plugin. One column, `event.create_request_id`. A Do Not Publish face in a cover shows to every member until spec §6.2's fix.
**Amended (see D-111).** The event's venue and the one radius are gone. Each sub-event carries its own radius, a sub-event's venue is one an earlier sub-event added or a new one, and the wizard sets Approval Mode. The default is still `auto`.
**Amended (see D-115).** `GET /events` also returns the caller's pending join requests. A Do Not Publish face in a cover now reaches anyone holding a live invite, not only members.
**Amended (see D-118).** S-08 builds `GET /events/{eventId}`, and creating an event lands on the Admin's Home tab.
**Amended (see D-128).** Start and end times use `@expo/ui`'s `DatePicker` on each platform, and `@quidone/react-native-wheel-picker` leaves `apps/mobile`. The map providers stand.
**Amended (see D-142).** The app sends the `uploadId` to `PUT /events/{eventId}/cover`, never a key, and the API builds the key. S-07a reads and changes the event's name, description and Approval Mode through `GET` and `PATCH /events/{eventId}/settings`.

### D-111: Each sub-event has its own radius, and the wizard has three steps
**Decision.** Amends D-110. Ukasha ruled on each of these on 2026-09-25, after S-02's API build, from the Figma draft of the wizard.
- Each sub-event has its own verification radius, `sub_event.verification_radius_m`, 50 to 2000 m, default 200. The event has none. The GPS check compares a reading against the active sub-event's radius (spec §4.5), and verification is per sub-event (D-15), so two sub-events at one venue may use different radii. The Venue QR reads no radius (D-85).
- The wizard has three steps: basic info, sub-events, review (spec §2.1.2). Each sub-event's venue and radius are set in the Add Sub-Event sheet on step 2.
- An event has no venue of its own, so `event.venue_id` is dropped. A sub-event's venue is one an earlier sub-event added in the wizard, or a new one. Every venue is used by at least one sub-event, so an event has at most 15.
- The sheet lists the venues earlier sub-events added, beside "Search or pin on map" for a new one, so two sub-events at one hall share one `venue` row and one QR (D-110).
- Step 1 carries the Approval Mode toggle, off for `auto`. `POST /events` stores `auto` when the app leaves the mode out.
- Event Settings (spec §2.5.7) loses venue and radius. S-04's sub-event edit changes both.
- Step 2's Next stays disabled until the event has a sub-event, and the draft's Skip is dropped (D-88).
- The "+" that opens the wizard floats at the bottom right of the Events tab (spec §2.5.1).
**Why.** The Figma draft sets venue and radius per sub-event in a sheet, with no venue step. One radius for the whole event gives a small nikkah hall and a large walima lawn the same 200 m.
**Rejected.** The radius on `venue`, which makes the sheet's slider change it for every sub-event at that venue. Keeping `event.venue_id` as the first sub-event's venue, which nothing reads. Approval Mode in the sub-event sheet, where the draft puts it, since the mode applies to the whole event.
**Cost.** A `manual` event created before S-07 lands leaves its joiners pending with no Approve button. That hits dev builds only. The S-02 migration had already run on the dev project, so its four tables and two functions are dropped there and the edited migration pushed again. An event has no single place to show on a map.
**Amended (see D-112).** From iOS 26 the "+" is the round button at the tab bar's trailing end. Android keeps it bottom right, as Material 3's FAB.

### D-112: Platform conventions set sizes, and Create Event joins the iOS tab bar
**Decision.** Amends D-111. Ukasha ruled on each of these on 2026-09-29, after S-02's build.
- The Figma frames set layout and direction. Sizes and placement follow Apple's Human Interface Guidelines on iOS and Material 3 on Android (hb §15).
- The type tokens in `apps/mobile/tailwind.config.js` resolve per platform. iOS takes Apple's default Dynamic Type sizes, body 17. Android takes the Material 3 type scale, body 16.
- Headers take each platform's bar: 44pt with 44pt buttons on iOS, 64dp with 48dp buttons on Android.
- The Global shell's tab bar draws SF Symbols on iOS, keeping Liquid Glass from iOS 26, and Material Symbols on Android, in the token colors.
- From iOS 26, Create Event is the round button iOS sets apart at the trailing end of the tab bar. It is a search-role item that opens the wizard instead of selecting a tab, and it shows on every Global shell tab. On Android it is Material 3's FAB on the Events tab, a 56dp square with 16dp corners, 16dp in from the edge. iOS before 26 keeps a floating circle.
- The Event shell's camera button stays a floating button on My Media on both platforms (spec §2.5.4). It belongs to that one screen, and iOS 26's tab bar slot is Apple's Search slot, borrowed once already for Create Event.
**Why.** The team copied the Figma frames closely and the result looked small and flat on both phones: an 11-point wordmark, a flat round "+", and 15-point body text on both platforms. None of the three is a designer, so each platform's own guidelines decide size.
**Rejected.** One set of sizes for both platforms, which reads as foreign on at least one of them. A custom floating "+" on iOS 26, beside a tab bar that has a native slot for it.
**Cost.** The iOS slot is the one Apple's own apps use for Search, so the "+" borrows it. Every existing screen changed size, so each needs a look on both platforms.
**Amended (see D-125).** A tab's first screen opens with a large title that collapses into the bar on scroll, 34pt Fraunces into the 44pt bar on iOS and Material 3's large top app bar into the 64dp bar on Android.

### D-113: Ukasha merges alone while the other two are away
**Decision.** Amends D-107. Ukasha ruled on 2026-09-29. While the other two developers are unavailable, Ukasha merges a pull request without a teammate's review once `/code-review` has run on it and CI passes. The four human-read surfaces still get Ukasha's own read (D-68). The exception ends when either teammate is available again.
**Why.** Nobody else can review for now, and waiting would stall every slice. S-02's five pull requests, #39 to #43, had already merged with no review.
**Rejected.** Holding every pull request until a teammate is free.
**Cost.** A mistake that only a second person would catch can reach `main`. `/code-review` knows the code but not the team's intent. The branch protection on `main` requires no approvals and no status checks, so both halves of this rule, the review and the green CI run, are kept by habit, not by GitHub.
**Amended (see D-116).** The exception ended on 2026-09-30, when B and C came back. D-116's own change was the last one Ukasha merged alone.

### D-114: S-02's build rulings, and deleting an Admin's account
**Decision.** Ukasha ruled on the first seven on 2026-09-25, during S-02's API build, and they sat on S-02's slice card in #37 until now. The last is from 2026-09-29.
- An `event.create_request_id` belongs to the account that made the event. Another account sending the same `requestId` gets 409 `duplicate`, and nothing about that event.
- A repeated create whose event was soft-deleted since answers 404.
- A valid token for an account deleted since it was issued answers 401 `no_session` on `POST /events`, as `GET /profiles/me` does, so the app shows Forced Logout.
- An empty event or sub-event description is stored as null.
- `PUT /events/{eventId}/cover` replaces `cover_key` and deletes nothing. The old cover's object stays in R2 until a slice decides to clean it up.
- A cover has no size limit.
- The database does not yet stop an update that changes the Admin's role. The slice that builds role changes adds that guard.
- Deleting an account deletes its memberships, the Admin's row included, so every event it ran is left with no Admin (D-102). Accounts are deleted by the team on request (spec §4.19). Until a slice builds a handover, the team first deletes each event the account runs, or hands it to another member by hand, and only then deletes the account.
**Why.** S-02's build found each one unstated, and `docs/ARCHITECTURE.md` recorded the first seven against an issue number that `doc why` cannot follow.
**Rejected.** Leaving them on the slice card, where only S-02's issue records them. A database rule that refuses to delete an account that is still an event's Admin, which costs a trigger to guard a step the team takes by hand a few times before the demo.
**Cost.** A replaced cover leaves an orphaned object in R2, and a large cover costs upload time and storage. An account deleted without the manual step leaves Admin-less events that only a hand-written query can repair.
**Amended (see D-143).** S-06's `guard_membership_admin` trigger now refuses an update that changes the Admin row's identity, role or status, or that makes another member the Admin.

### D-115: Join rulings from S-03's read-back
**Decision.** Amends D-110. Ukasha ruled on the first six on 2026-09-29 and let the routine calls stand.
- An invite lookup answers with or without a session and shows everyone the same preview: the role, the event's name, its span, its venue names in sub-event order, and its cover, presigned. It carries no member, no venue position and no `qr_secret`. A signed-in caller also gets their own membership in that event, and the app routes on it: `active` to Event Home, `pending` to Pending Approval, `blocked` to Join Blocked, none or `removed` to Join Confirmation.
- The cover shows on the preview because the Admin picks it for the people they invite, and would leave out anyone who should not be in it. D-110's unblurred Do Not Publish face in a cover now reaches anyone holding a live invite, until spec §6.2's fix.
- Invite lookups have no rate limit. Only the team calls the API while it is built, so a limit protects nothing yet, and shipping the MVP comes first.
- `GET /events` also returns the caller's `pending` join requests, with the event's name and the role. The Events tab shows each as a card that opens Pending Approval. Pending Approval refetches on foreground and every 30 seconds, opens Event Home once the row is `active`, and returns to the Events list once the row is gone. The Approval Alerts push arrives in Phase 6 (hb §14.6).
- S-03 joins through either link, with the role the invite row carries (spec §2.2, §4.4).
- A blocked person is told. A lookup routes them to a Join Blocked screen, and a join answers 403 `blocked`, which the app shows as Join Blocked, never as Join Error or Access Removed. S-03's schema PR adds the code to hb §5.3.
- Until S-05 builds the share screen, testers read tokens and codes from the dev project's table editor and open a link with `adb shell am start -d` or `xcrun simctl openurl`.
- Routine calls:
  - A join into a full event answers 422 `event_full`, and Join Confirmation says so inline.
  - arch:invite holds the token and shortcode formats, their uniqueness and one live invite per role. arch:membership holds `join_event`, rejoins, `requested_at` and Cancel Request.
  - The app sends a token or code in the request body.
  - The app keeps an opened invite in MMKV until the join, a dismissal or a logout, so killing it during signup loses nothing.
  - Join Confirmation names the signed-in account, because the demo hands phones around (spec §9).
  - A "Join with code" action on the Events tab opens Manual Join Entry for a user who already has events.
  - S-03's migration replaces `create_event` to add both invite inserts on its create path only, after the repeat check, and backfills both invites for every existing event.
**Why.** S-03's read-back found each one unstated or contradicted. The signup banner and Manual Join Entry need the event before a session exists (spec §2.3.1, §2.4), while arch §1 showed an `event` to active members only. Spec §5.1 sent a blocked person to a screen reserved for dead tokens, and hb §5.3 turns a plain 403 into Access Removed. D-110 listed no pending membership, so a pending user who closed the app had no way back to Cancel Request. An event has no venue of its own (D-111). Nothing named the transaction that holds the 150 cap when two people join at once.
**Rejected.** A signed-out preview with only the name and role. Answering a blocked person 404 with Join Error's "expired or revoked" copy, which tells them something false. nginx `limit_req` on lookups. Keeping the pending request on the phone only, which a second device or a reinstall loses.
**Cost.** Anyone holding or guessing a live code learns an event's name, dates, venue names and cover without an account, and nothing slows a guesser. A blocked person learns they were blocked. One error code, one screen, one column and a field on `ListEventsResponse`.
**Reopen if.** The API's logs show invite lookups the team did not make. Then add the rate limit.
**Amended (see D-118).** `active` routes to the role's landing tab, which is My Media for a Photographer and Home for everyone else.
**Amended (see D-126).** A pending request shows as a row at the top of the Events list, and Join with code is an action in the Events bar.

### D-116: One AGENTS.md, a stack of PRs per slice, and shared infrastructure for all three
**Decision.** Amends D-107 and D-113. Ukasha ruled on 2026-09-30, when B and C came back.
- `AGENTS.md` is the only instruction file for every agent tool, at the root and in `apps/mobile/`, `apps/api/` and `worker/`. Every `CLAUDE.md` is deleted. Claude Code reads `AGENTS.md` from 2.1.277 on, and only where no `CLAUDE.md` or `CLAUDE.local.md` sits in the project or a folder above it, so the docs gate fails on either file and `pnpm check:machine` fails on either file or an older Claude Code. `.agents/skills/slice/SKILL.md` is a copy of the Claude skill, and the gate keeps the two identical.
- A slice ships as a stack of PRs: read-back doc fixes if there are any, then the schema, then one PR per package, each branch cut from the one below. No stage waits for a merge. The done stage asks for one teammate's review of the whole stack, and Ukasha reads the human-read surfaces and any `docs/ARCHITECTURE.md` change.
- A reviewed stack merges from the top down with Rebase and merge, never Squash, so `main` keeps every commit.
- Every stage keeps a discussion log and posts it to the slice's issue, and the done stage copies all of them into the top PR.
- A sixth stage, `/slice <id> cleanup`, merges an approved stack on the developer's yes, closes the issue, removes the slice's worktrees and local branches, and brings `main` and the dev server up to date.
- The mobile build asks once for screen designs, never insists, and builds any screen without one in the style of the existing screens.
- The slice owner pushes the slice's migration to the dev project during the api build. A migration that has reached the dev project is never edited; a change is a new migration.
- Every developer gets SSH to the dev server through the `momentlens` alias (hb §13.4). Whoever merges a stack that touched the API, the worker or a migration deploys `main`. A developer may deploy an unmerged branch to try it on a phone, telling the team first, and puts `main` back after.
- D-113's exception ends with this change, the last one Ukasha merges alone. From here every PR gets one teammate's review and a green CI run before it merges (D-107).
**Why.** B and C are starting with little context on the project, and their agents with none. The rules sat in `CLAUDE.md` files that other agent tools skip, and Ukasha wants smaller agents from other tools able to find and explain things from the same file. The migration and deploy steps lived only in Ukasha's agent memory. Each slice stopped halfway for its schema PR to merge, and nothing recorded how a slice was decided, so Ukasha could not see what a teammate's agent had been told. Ukasha wants every commit kept on `main`.
**Rejected.** A one-line `CLAUDE.md` in each folder importing `AGENTS.md`, which also works on Claude Code before 2.1.277. Squash merges. Merging the stack from the bottom up, which needs a rebase and a force push before each PR. Only Ukasha pushing migrations. No SSH for B and C, with unmerged API changes tried against an API on their own machine.
**Cost.** A Claude Code older than 2.1.277, or one stray `CLAUDE.md`, leaves an agent with no project rules and no error, and the checks catch it only when someone runs them. The dev server runs one branch at a time for all three phones. A migration pushed from an unmerged branch is on the shared database before anyone has reviewed it. Top-down merging reruns CI once per PR in the stack.
**Reopen if.** An agent is found working without the rules, or two developers need the dev server on different branches in the same week.
**Amended (see D-117).** The done stage no longer asks for a teammate's review. GitHub requests the code owners', and a code owner's own slice keeps no discussion log.

### D-117: Code owners review every PR into main
**Decision.** Amends D-107 and D-116. Ukasha ruled on 2026-10-01.
- `.github/CODEOWNERS` names the `maintainers` team for every path, so GitHub requests its review on every PR. A PR reaches `main` only with a code-owner approval and a green CI run. Another developer's review is welcome and never required.
- A code owner's own PRs reach `main` after a green CI run and `/code-review`, with no other approval, and merge with `gh pr merge --rebase --admin`. Where one touches a human-read surface, the code owner is the person D-68 asks for, with `/code-review` and the negative test as the second check.
- Two rulesets on `main` enforce this. "main: CI" requires the CI job and has no bypass. "main: review" requires a code-owner approval, allows Rebase and merge only, and drops an approval when new commits arrive; repository admins can bypass it. Squash merging is off for the whole repository (D-116).
- Folding a stack down into its bottom PR drops that PR's approval, so it needs approving once more before it merges.
- Each developer answers the decision questions in their own slice's read-back. The code owners see the answers in review.
- A code owner's own slice keeps no discussion log.
**Why.** The maintainers hold the most context on the design, so their review is where a slice gets checked against it.
**Rejected.** Another developer's review on a code owner's PRs. Keeping an approval after new commits arrive. Code owners answering every read-back question. Keeping the rule by habit, with no ruleset.
**Cost.** Every PR from outside the maintainers waits on their review. Nobody outside the maintainers reads the maintainers' code in review, and their slices leave no discussion log, so the others learn that code from the docs alone. A stack's bottom PR needs a second approval. A read-back answer that the code owners would have ruled differently is found only in review, after the code exists.
**Reopen if.** PRs regularly sit waiting for a code-owner review, or read-back answers keep being rebuilt in review.
**Amended (see D-120).** A code owner's own slice keeps a discussion log like everyone else's.

### D-118: Navigation rulings from S-08's read-back
**Decision.** Amends D-110 and D-115. Ukasha ruled on each of these on 2026-10-01 and let the routine calls stand.
- S-08 builds `GET /events/{eventId}`. It returns the event as `GET /events` lists it, with the caller's role, the span and the cover, presigned after the membership check (arch §3). A caller whose membership is not `active` gets 403 `not_member`, and a soft-deleted or unknown event gets 404 `not_found`. S-15 adds the verification state that spec §4.5 calls the event response.
- The Event shell reads the role from that endpoint through one TanStack Query that every tab shares. One function maps a role to its tabs and its landing tab, so spec §4.10's tab restriction lives in one place.
- The event query survives a restart. TanStack Query's persister keeps the queries marked to persist in MMKV, and a logout or an ended session clears them, so a guest who reopens the app with no signal still reaches My Media and the camera (spec §4.14). S-04 marks the schedule the same way. S-08 adds `@tanstack/react-query-persist-client` and `@tanstack/query-sync-storage-persister` to `apps/mobile`, both JavaScript only.
- A role change or a removal reaches the phone when the app returns to the foreground, or when an event call answers 403 `not_member` or `wrong_role`, which refetches the event. Membership gets no Realtime, because that needs an RLS policy D-73 rules out. The API checks the role on every request, so nothing leaks in between.
- Root invariant 2's cache-key rule covers media files. A cover or an avatar has no `variant_version`, and its key carries its upload's id instead (arch §3).
- Routine calls:
  - A Guest and the Admin land on Home, a Photographer on My Media. D-115's "`active` to Event Home" means the role's landing tab.
  - The Event shell uses Expo Router's native tabs, as the Global shell does (D-112). Native tabs cannot add or remove a tab once mounted, so the bar is keyed on the role and remounts when it changes.
  - A route the role lacks, reached through a link, redirects to the role's landing tab.
  - The header holds the cover, the name and "‹ Events", with a slot S-29 fills with the avatar (spec §2.5.9).
  - Until S-31 builds Access Removed, a `not_member` in the Event shell shows a "no longer have access" state with a way back to Events. A caller whose join request is still pending goes to Pending Approval instead.
  - S-27 writes `membership.last_viewed_at`. Nothing writes it before S-27.
**Why.** S-08's read-back found that hb §16.5 named a membership query no slice built (D-110). The cached `GET /events` list cannot tell a removed member from a pending one or a stranger, and it is empty when a push opens an event before the list loads. Spec §4.14 left the event out of the offline cache, so a cold start with no signal locked a guest out of the camera. Hb §5.3 turned every 403 into Access Removed, including the `wrong_role` a Guest gets after becoming a Photographer. Spec §2.3.1, §2.4 and D-115 sent a Photographer to a Home they never see.
**Rejected.** Reading the role out of the `GET /events` cache. Realtime on `membership`. Leaving the offline cold start to S-04. A hand-written MMKV cache for the one event, which S-04 would then write again for the schedule. JS tabs for the Event shell, which would look different from the Global shell's on both platforms.
**Cost.** One endpoint, one read-only SQL function and their tests. Two JavaScript packages. A persisted cover URL expires an hour after it was signed, so offline the header shows the cover only if `expo-image` cached it. A role change shows on the next foreground or the next 403, not at once.
**Reopen if.** A tester reports stale tabs after a role change.
**Amended (see D-119).** The Event header shows no cover. The persister is `@tanstack/query-async-storage-persister`, and the `GET /events` list survives a restart along with the event.
**Amended (see D-132).** The avatar S-29 adds opens that event's Event Preferences, not Account Settings.

### D-119: S-08's mobile build rulings
**Decision.** Amends D-118. Ukasha ruled on these on 2026-10-01, during S-08's mobile build.
- The Event header holds "‹ Events", the event's name and the slot S-29 fills with the avatar (spec §2.5.9). It shows no cover.
- The persister is `@tanstack/query-async-storage-persister`, writing to MMKV. D-118 named `@tanstack/query-sync-storage-persister`, which TanStack Query has deprecated.
- The `GET /events` list survives a restart, as the event does, and a logout or an ended session clears it with the event.
**Why.** The name already says which event is open, and the Figma frames leave the cover out. A cold start with no signal reaches an event only through the Events list, so persisting the event alone left a guest unable to open it.
**Rejected.** The cover in the header. The deprecated sync persister. Persisting the event and not the list.
**Cost.** One more persisted query. Every event the user belongs to stays on the phone for up to 14 days with the app closed, or until a logout. A persisted cover URL on an Events card expires an hour after it was signed, so offline a card shows its cover only if `expo-image` cached it.
**Amended (see D-125).** Back is the platform's own button instead of "‹ Events", and the header is the native stack header on iOS and a Material 3 top app bar on Android. It still shows no cover.
**Amended (see D-132).** The avatar slot opens Event Preferences for the event.

### D-120: Code owners keep a discussion log too
**Decision.** Amends D-117. Ukasha ruled on 2026-10-01. A code owner's own slice keeps a discussion log in every stage, as every other slice does. Each stage posts its log to the slice's issue, and the done stage copies every log into the top PR (D-116). The rest of D-117 stands, and a code owner's stack still merges on a green CI run and `/code-review`. A slice already under way when this landed keeps a log from its next stage on.
**Why.** Ukasha wants the decisions behind a code owner's slice on record in its PRs. Without a log, the questions asked and answered in a code owner's sessions were gone after `/clear`, and B and C learned that code from the docs alone, the cost D-117 accepted.
**Rejected.** Each stage's log in that stage's own PR instead of the issue, for every developer, which leaves no single record in the top PR and rewrites the done stage. Each log in its own PR and the top PR both, which puts every log in two places.
**Cost.** A code owner's session spends a few hundred tokens a stage writing the log, and the code owner's top PR gets longer.
**Reopen if.** Code owners' logs go unread in review, or a top PR's logs pass GitHub's 65,536-character cap on a description.

### D-121: Sub-event writes, Delay and the schedule read, from S-04's read-back
**Decision.** Amends D-100 and D-105. Ukasha ruled on each of these on 2026-10-02.
- A Delay is a positive amount. Before a sub-event starts it moves the start and the end together. Once the sub-event has started it moves the end only. The app sends the new times through the edit endpoint, so a retried Delay changes nothing.
- When an edit or a delete leaves a venue with no sub-event, the same transaction deletes the venue, so every venue stays in use (D-111). A venue's name and pin are never edited in place. The Admin moves its sub-events to another venue or a new one.
- The Schedule reads `GET /events/{eventId}/sub-events`, a query of its own that the app persists as it does the event (D-118). It returns each sub-event's radius and its venue's id, name, lat and lng, never `qr_secret`.
- Three SQL functions write sub-events, `add_sub_event`, `update_sub_event` and `delete_sub_event`. Each locks the event row `FOR NO KEY UPDATE` before it counts sub-events or computes the span (D-95). An add carries a `requestId`, as `POST /events` does.
- Four error codes, in hb §5.3: 422 `too_many_sub_events`, 422 `event_too_long`, 409 `last_sub_event`, and 409 `sub_event_has_media`, which the API sends from S-12 on.
- `packages/shared-types` exports `subEventStatus(subEvent, at)` and `currentSubEvent(subEvents, at)`. `currentSubEvent` picks the most recently started of the sub-events In Progress at `at`, and on a tie the one that ends first, then the lower id. The API passes one venue's sub-events for a QR scan (D-85).
- `media` arrives with S-12, after S-04. S-12 gives `media.sub_event_id` no `ON DELETE` action and replaces `delete_sub_event` with one that refuses a sub-event with any `media` row. S-15 gives `venue_verification.sub_event_id` `ON DELETE CASCADE`.
- Routine calls:
  - The Admin's writes need a connection and are never queued.
  - An add or an edit may set a start in the past, as a create may (D-110).
  - Edits are allowed on an archived event.
  - Two of the Admin's phones editing one sub-event resolve as last write wins.
  - The Schedule header holds Add, each row holds Delay, Sub-event Detail holds Edit, and the Edit sheet holds Delete at its foot, as the Edit design draws it. Ukasha moved Delete there from Detail at the mobile build. Delete is disabled while only one sub-event is left.
  - "View photos from this session" passes the sub-event's id to Home, and S-13 reads it.
**Why.** S-04's read-back found no endpoint that returns sub-events, no writer documented besides `create_event`, no error codes for refusals that depend on rows, and a Delay that sent a running sub-event back to Upcoming. Without the lock, two phones deleting an event's last two sub-events leave it with none, and `list_my_events` then returns a null span that breaks `GET /events` for every member.
**Rejected.** A Delay that always moves both times, which hides the capture FAB in the middle of a sub-event and leaves offline readings from its first part matching nothing (D-85). Keeping a venue no sub-event uses, which breaks the cap of 15 venues and leaves S-16 printing a QR for nothing. Sub-events inside `GET /events/{eventId}`, which replaces `get_my_event`. 400 `invalid_request` for the new refusals, which hides a state conflict behind a validation error.
**Cost.** One Delay button does two things, so its confirm shows the new times. Moving a venue's sub-events away and back makes a new QR. Fixing a pin that three sub-events share takes three edits. A write invalidates two queries, and the span and the schedule can disagree for one fetch. A Guest verified for a deleted sub-event loses that row, which unlocked no photo. A photo queued offline for a sub-event deleted since is S-11's and S-12's to handle, and no doc says how yet.
**Reopen if.** An Admin needs to move a running sub-event's start, or a tester reports a printed QR that stopped working.
**Amended (see D-122).** A photo queued for a sub-event deleted since answers 409 `sub_event_missing` at pre-flight and stays stopped in My Media.
**Amended (see D-127).** Add sits in the iOS bar and in a FAB on Android. Delay shows as a button on the sub-event In Progress and the next one, and every row reaches it from its long-press menu and Detail. Edit sits in Detail's toolbar, and Delete stays at the foot of the Edit sheet.

### D-122: Upload pre-flight and completion, from S-12's read-back
**Decision.** Amends D-82, D-95, D-96 and D-121. Ukasha ruled on each of these on 2026-10-02.
- Pre-flight checks, in order: the caller is an active member, the event is not deleted and the album is open; the sub-event; the hash; then, for a new row, verification and the cap, which `start_upload` counts. An archived event takes uploads like any other, and the album check decides.
- The sub-event must belong to the event in the path. One that does not, or that was deleted after the photo was queued, answers 409 `sub_event_missing`, and the phone keeps the photo stopped in My Media, where the person can delete it.
- Pre-flight answers 201 for a new row and 200 for a resume, each with two PUT URLs.
- When the caller's own unfinished row and another user's finished row share the hash, pre-flight resumes the caller's row. Completion then answers `duplicate` and deletes it.
- `start_upload` and `complete_upload` each lock the event row `FOR NO KEY UPDATE`, as D-121's functions do, and decide the hash outcome under the lock. `start_upload` returns the caller's own unfinished row rather than inserting a second, so two devices on one account sending the same photo at once end with one row. Two completions of one hash end as one `completed` and one `duplicate`.
- Completion looks up the row before anything else. A row that no longer exists answers 409 `duplicate`, because a duplicate completion is the only thing that deletes one. Then completion answers 403 `not_uploader` to anyone but the uploader, then 404 `not_found` when the event was deleted, then 403 `not_member` to an uploader who is no longer an active member, all before the HEAD.
- S-12 writes the album check behind one constant, switched off, with a test for each setting, and S-31 switches it on. S-12 writes no verification query. S-15 adds the check along with `venue_verification`.
- S-12's migration enables `pgmq` and creates the `jobs` queue.
- Ruled at S-12's api build:
  - `start_upload` alone decides the sub-event, the resume, the duplicate and the cap, under the event lock. The API checks the membership and the album before the call and makes no other lookup.
  - `media.uploader_user_id` references `auth.users` with no `ON DELETE` action, so an account with photos cannot be deleted until support removes them (spec §4.19).
- Ruled at S-12's done stage:
  - A `jobs` message whose media row no longer exists is deleted as done, with no retry, no archive and no Sentry report. S-18a builds it.
  - One person holds at most 50 unfinished rows in an event that are not soft-deleted. Past that, pre-flight answers 422 `too_many_unfinished`. A resume skips the check. Without it, one member could fill the event's 2,000 places with pre-flights that never upload.
  - A soft-deleted unfinished row never resumes, and completion answers it `duplicate`, so a retry never publishes a photo its uploader deleted.
  - The PUT URLs stay bound to the content type alone, and the risk in Cost stays accepted. The fix, when one is needed, is to sign `ChecksumSHA256` from `content_hash` into the photo's PUT, so R2 refuses any other bytes. That also checks root invariant 7 on the server, and needs the app to send the header and a hash for the thumbnail.
  - arch §4's queue table gains rows for 401, 400 and completion's `not_uploader`. A lost completion answer retries completion, never pre-flight, which would send both files again.
  - Routine call: arch §3 no longer says the worker writes a missing client thumbnail, since completion refuses a photo without one.
- Routine calls:
  - `capturedAt` is optional or null, UTC with milliseconds, and any value is accepted (D-98). The phone converts an EXIF time that carries no zone.
  - A resume keeps the row's own sub-event, capture time and role, whatever the request sends.
  - Pre-flight accepts any sub-event of the event, an Upcoming one included.
  - `size_bytes` is the photo's size and leaves out the thumbnail. `variant_version` is 0 at insert, so the worker's first write makes it 1.
  - On a `duplicate` completion the API deletes the two objects after the row. A failed delete is logged and the answer is still `duplicate`.
**Why.** S-12's read-back found five ways the documented pipeline went wrong without an error. A member of one event could insert a photo into another through the path. A photo queued for a deleted sub-event had nowhere to go. A removed user's in-flight photo published. A retried completion after a lost `duplicate` answer sent the phone to upload to a deleted row's keys. Two completions of one hash ended in a 500 from the unique index. D-82 and Handbook §7 also put the cap before verification, where the spec and `docs/ARCHITECTURE.md` §4 put it after.
**Rejected.** 404 `not_found` for a missing sub-event, which lands on the queue row that waits for the membership and never clears. Answering `duplicate` at pre-flight when the caller also has an unfinished row with the hash, which leaves that row behind for good.
**Cost.** Accepted for the demo:
- An abandoned unfinished row, from an app never relaunched after a crash or a cancel in My Media after pre-flight, holds a cap slot, blocks deleting its sub-event and keeps its R2 objects. Cleaning them up needs a scheduled job, and no slice owns one (`docs/ARCHITECTURE.md` §5).
- A PUT URL keeps working for up to 15 minutes after completion, so a modified app can replace `upload_key` or `upload_thumb_key` after the worker has processed the photo. That breaks D-60 for that photo and can put an unblurred face behind its public keys.
- No size limit applies to an upload. The presigned PUT binds the content type and not the length.
- A resume that loses to another user's finished copy spends one upload for nothing.
- An account with photos cannot be deleted until support removes its photos by hand.
**Reopen if.** A tester's event fills with unfinished rows, or the build moves to a public deployment, where the PUT window and the missing size limit stop being acceptable.

### D-123: Worker skeleton, from S-18a's read-back
**Decision.** Amends D-72, D-103 and D-108. Ukasha ruled on each of these on 2026-10-02.
- The worker's libraries are `psycopg[binary]` 3, used synchronously, `boto3`, `opencv-python-headless` 4 and `pydantic`, exactly pinned in `worker/requirements.txt`, plus `numpy`, which OpenCV installs and the worker imports to hand it bytes, so it is pinned too. OpenCV stays on 4.x until S-18 has checked InsightFace against 5.0. Ruff and pytest go in `worker/requirements-dev.txt`, which installs `requirements.txt` too. `thumbnail_dims` reads width and height by decoding the upload with OpenCV, so a JPEG that does not decode fails and never publishes.
- A try is a read. pgmq's `read_ct` counts it, so a crash counts as one. After a failed try the worker waits and reads the same message again before any newer one, so a newer job on the same photo never runs first. The third failure archives it. Each time the worker takes the lock, at startup and after a reconnect, it makes every message a stopped worker left hidden visible again.
- One worker reads `jobs` at a time. It holds a Postgres advisory lock while it reads, and a second worker, such as a laptop pointed at the dev project, logs that the queue is taken and waits. To run a worker locally against the dev project, stop the server's first (Handbook §13.4). `DATABASE_URL` is the Supabase session pooler's connection string on port 5432, because the lock needs a session and the direct host is IPv6 only.
- A job's row writes and its message's delete commit in one transaction. So do a final failure's archive and its clearing of `processed_at`. The worker holds its own transactions, so it needs no SQL function for either (D-95 is about supabase-js).
- `thumbnail_dims` acts only on a row whose `variant_version` is 0, one no job has written, and deletes any other row's message as done.
- Three kinds of message are archived on their first try, because a retry cannot help: one whose upload object is missing from R2, one that does not parse, and one naming a job the worker does not have. If it names a photo, `processed_at` is cleared as for any final failure.
- R2 answering 401 or 403, or with `NoSuchBucket`, counts as an outage, as a 5xx or a lost connection does. The worker reads nothing more until R2 answers, so a wrong `R2_*` value costs only the try in flight.
- The worker processes a soft-deleted row like any other, because the Admin can restore it for 30 days (spec §4.21).
- S-18a adds Sentry to the worker, in the project `momentlens-worker`. It reports archived messages only, and stays off while `WORKER_SENTRY_DSN` is unset. The worker reads its own variable because both systemd units read `/srv/momentlens/.env`, and both read the root `.env` locally, where `SENTRY_DSN` is the API's. It shares `SENTRY_ENVIRONMENT` with the API.
- The worker's CI job runs Ruff and pytest with Postgres and R2 faked. A second test module runs the worker's SQL against the dev project inside a transaction it rolls back. It skips when `DATABASE_URL` is unset, and CI runs it from the `SUPABASE_DEV_DATABASE_URL` secret on pull requests that touch `worker/` or `supabase/`, as `rls.yml` does (D-106).
- Routine calls:
  - The loop runs on the main thread and `/health` on a side thread. The process exits when the loop dies, so `Restart=always` brings it back, and `/health` answers 503 until the loop starts and once it has stopped.
  - The worker retries a lost Postgres or R2 connection itself, with a wait, rather than exiting, because every exit costs the unit's 10-second `RestartSec` and a fresh start, which from S-18 includes loading the model.
  - SIGTERM lets the current job finish before the process exits.
  - A decode is capped at 4096×4096 pixels, from root invariant 9's longest edge, so an image too large to decode fails instead of exhausting the server's memory. The cap limits pixels, not the bytes read (see Cost).
  - Width and height are read as stored, with no EXIF orientation applied (D-99).
  - The worker polls an empty queue once a second, with a 120-second visibility timeout.
**Why.** S-18a's read-back found the docs silent on what counts as a try, where a retried message goes in line, and how many workers may read the queue. A wrong answer to any of them breaks D-103's order without an error, and three developers share the dev project, so a second worker was one command away. S-19a's `blur_region` ships before S-21 retires `thumbnail_dims`. If `blur_region` failed three times and D-108 cleared `processed_at`, a `thumbnail_dims` message re-sent from the archive would point the public keys back at the unblurred upload and publish it. A crash between an archive and its clear left a photo up with no message to retry it. Every doc promised Sentry "once the worker has it", and no slice added it.
**Rejected.** Retrying through pgmq's visibility timeout, which lets a newer job on the same photo run first. Pillow for the dimensions, which reads only the header and is not in Handbook §17. A written rule alone against a second worker, which nothing enforces. Guarding `thumbnail_dims` on `processed_at`, which D-108 clears.
**Cost.** One failing message holds the queue for the length of its retries. The real-SQL test needs a secret in GitHub and runs against the shared dev project. The API's RLS suite completes uploads with no file in R2, so each run leaves a few messages that the dev server's worker archives with an error line and a Sentry report. OpenCV decodes the whole photo to read two numbers, about 150 ms each. A lost database connection or an R2 outage during a job costs that message a try, as a crash does, so a message whose third try meets one is archived and its `processed_at` cleared. Ukasha kept this at S-18a's done stage rather than count those tries apart. The worker reads an upload whole before it decodes it, and D-122 sets no size limit, so one very large file can stop the worker three times before its message is archived. Ukasha deferred a byte cap at the same stage to a client-side guard, which limits the app and not a direct PUT to a presigned URL.
**Reopen if.** The worker needs to run jobs in parallel, which the lock and the order both forbid.
**Amended (see D-130).** The worker no longer processes a soft-deleted photo. A message naming one is deleted as done, and `media_delete` removes its files.

### D-124: Each platform draws the controls, and the brand stays in the content
**Decision.** Changes hb §15's typography. Ukasha ruled on these on 2026-10-03, after a design critique of the build at `ccfa45c` on the iPhone 17 Pro simulator (iOS 26.5) and the Pixel 7 Pro (Android 16).
- Bars, lists, fields, pickers, switches, menus, sheets and dialogs are each platform's own, iOS 26's on iOS and Material 3's on Android. Where the app draws a control itself, it copies that platform's control, never one look for both.
- The brand lives in the content. Fraunces sets event names, sub-event names and large screen titles. The cream and warm near-black grounds, the gold accent, and covers and photos at the width of the screen carry the rest.
- All other text uses the system font, SF Pro on iOS and Roboto on Android, at the per-platform sizes D-112 set. Manrope goes, and `@expo-google-fonts/manrope` leaves `apps/mobile`.
- Uppercase is kept for one label, "Live now". Otherwise capitalization follows each platform's guidelines, title case for titles, buttons, menu items and row labels on iOS and sentence case on Android, and the app never changes the case of a name a user typed.
- Lists are inset grouped on iOS, with 26pt corners and hairline separators, and Material 3's grouped list on Android, with 20dp outer corners, 4dp inner corners and 2dp gaps. No list draws white cards with a 1px border on cream.
- On iOS a form puts each field in a row of an inset grouped section. On Android it uses outlined text fields with a floating label and a 2dp focus outline. A field never repeats its label as its placeholder. A switch is `@expo/ui`'s `Switch`, which draws SwiftUI's toggle and Material 3's switch.
- Gold marks the brand, the primary action and the selected tab. A role shows as a neutral badge, an error takes `danger`, and a selection uses the platform's own control.
- Token changes, each measured against WCAG AA:
  - `accentText` becomes `#7E5B1E` in light mode, 5.7:1 on `background`, 6.2:1 on `surface` and 4.9:1 on `accentTint`. Dark mode keeps `#D6AC52`.
  - `textMuted` becomes `#6F685C` in light mode, 5.1:1 on `background` and 4.6:1 on `surfaceMuted`, and `#9A917F` in dark mode, 5.9:1 and 4.8:1. Muted text never sits on `accentTint`, where it measures 4.4:1 and 4.2:1.
  - A gold icon takes `accentText`, because `accent` measures 2.4:1 on the light `background`.
  - `surfaceContainer`, `#F1EBE0` in light mode and `#221E17` in dark, colors the Android navigation bar one tone off the page.
  - `hero` and `onHero` color the Live card, `#1E1B17` and `#FAF6EF` in light mode (15.9:1) and `#3A3122` and `#F4EFE5` in dark mode (11.2:1). Swapping `textPrimary` and `background` instead turns the card into a cream slab in dark mode.
- The MomentLens wordmark appears on the launch screen and on Login, and nowhere else.
- The Expo template's brand goes. The app icon is the gold aperture mark on cream, with iOS default, dark and tinted variants and an Android adaptive icon with a monochrome layer. The splash is the mark on `#FAF6EF`, or `#17140F` in dark mode, and the blue overlay in `components/animated-icon.tsx` goes. Android's app theme takes the gold as its accent and drops all-caps dialog buttons, so `Alert` stops showing teal capitals.
**Why.** The critique found that what each platform draws already looked right: the native tabs, iOS sheets and alerts, the Material slider and iOS's Paste button. What the app drew itself looked like a web form kit beside them, with uppercase labels over bordered boxes, a pill segmented control, bordered cards and Manrope next to SF Pro and Roboto in the bars. The seams showed most on Android, the platform the judges hold (D-61). Every small gold label failed AA at 3.9:1 on `background`, muted text measured 3.3:1, and the icon and splash were still Expo's.
**Rejected.** Manrope for UI text, which sat beside the system font in every native bar and sheet. iOS controls drawn on Android, which read as foreign there. Darkening `accent` itself, which dulls the buttons and the tab tint, and both already pass.
**Cost.** Every screen built so far changes: the auth screens, Events, Profile, the wizard, the Schedule and its sheets. A form control with no universal `@expo/ui` component needs one component per platform. The icon, the splash and the Android theme take one native rebuild on all three machines.
**Reopen if.** Testers describe the app as plain or generic. Then the content side carries more of the brand, not the controls.

### D-125: Native headers, and the Event header collapses
**Decision.** Amends D-112 and D-119, and replaces hb §16.5's custom Event header. Ukasha ruled on these on 2026-10-03, from the critique in D-124.
- Every screen has a title in its bar. A tab's first screen opens with a large title that collapses into the bar on scroll. On iOS the large title is 34pt Fraunces and collapses to a 17pt inline title in the system font. On Android it is Material 3's large top app bar with its title in Fraunces, collapsing to the 64dp bar. A pushed screen opens with the small bar.
- iOS uses the native stack header with `headerLargeTitleEnabled`, in a Stack inside each tab, so UIKit draws the bar, its glass and the collapse. A large title collapses only when the screen's content is a scroll view with `contentInsetAdjustmentBehavior="automatic"`. Android's native header has no large title, so the app draws a Material 3 top app bar that collapses on a Reanimated scroll handler.
- On iOS 26, back is a round 44pt glass button with a chevron and no label. On Android it is `arrow_back` in a 48dp icon button. The "‹ Events" text button goes.
- The Event header keeps what D-119 put in it, a way back to Events, the event's name and the avatar slot S-29 fills, with no cover. The name is the large title and stays in the bar once collapsed, so the header never leaves the screen (spec §2.5.1). On iOS the Admin's Add (D-127) and the avatar share one glass group at the trailing end.
- In the Global shell, Events and Profile open with large titles. The bell goes, because spec §2.5.10 gives it no screen to open. The avatar on Events goes, because the Profile tab sits one tap away and spec §2.5.9 puts the avatar in the Event header.
- An iOS sheet takes the iOS 26 toolbar, with a glass close button at the leading end, the title in the middle, and a glass checkmark in the accent or a text action such as "Edit" at the trailing end. An Android sheet takes a close icon, the title and a Save button.
- Sub-event Detail and Delay stay `formSheet` routes and move to the `(app)` Stack. On Android a `formSheet` draws inside the navigator that presents it, so from the Schedule tab's Stack its scrim stopped at the Event header and left the tab bar lit. Android sets `sheetCornerRadius` to 28 and draws Material 3's 32×4dp handle in the sheet's content, because `sheetGrabberVisible` draws nothing on Android in react-native-screens 4.26.
- Android's navigation bar sits on `surfaceContainer` (D-124), and the selected tab shows its filled Material Symbol.
**Why.** The critique found the headers furthest from either platform. The wordmark stood where the title belongs, the bell did nothing, iOS showed the iOS 18 text back button under an iOS 26 glass tab bar, and Android showed a chevron with no app bar around it. On the Schedule, two stacked titles took 200pt above the first sub-event. hb §16.5 chose a custom header to keep it above the tabs, and a native header in each tab stays on screen too.
**Rejected.** Restyling the custom header, which still misses the collapse and the glass that UIKit draws. One header component for both platforms. The cover in the header (D-119). `@expo/ui`'s `BottomSheet` for Detail and Delay on Android, which adds a second sheet component when moving the route already fixes the scrim.
**Cost.** Each Event shell tab gets a Stack layout of its own, and the header is two components, one per platform. A screen whose content does not scroll keeps its large title. Detail and Delay change routes, and every link to them changes too.
**Reopen if.** A sheet presented from `(app)` still leaves the Event header or the tab bar uncovered on the Pixel. Then Android takes `@expo/ui`'s `BottomSheet` for both.
**Amended (see D-132).** The avatar in the Event header opens Event Preferences, a sheet over the event.

### D-126: The Events tab is one list in three sections
**Decision.** Amends D-115 and spec §2.5.1. Ukasha ruled on these on 2026-10-03, from the critique in D-124.
- The Active, Upcoming and Past segmented control goes. Events is one list in three sections, "Happening now", "Upcoming" and "Past", and a section shows only when it holds an event. D-110's sorting function still decides the section, and its Active is labeled "Happening now".
- An event in Happening now or Upcoming shows as a cover card the width of the list, with its name in Fraunces over the cover, its dates and its role as a neutral badge. An Upcoming card adds how far off the event is ("in 4 weeks"). Spec §2.5.10's "new since last visit" dot sits on the card once S-27 writes `last_viewed_at`. Past shows compact rows with a small cover.
- A pending join request shows as one row at the top of the list, with the event's name, "Waiting for approval" and the role, and opens Pending Approval. It replaces D-115's card.
- "Join with code" moves into the bar, as a "Join" glass button on iOS and an icon button on Android, and opens Manual Join Entry.
- With no events and no pending request, the list shows the aperture mark, "No events yet", one line on joining or hosting, and a "Join with code" button.
- The "+" stays where D-112 put it.
**Why.** People belong to a handful of events, so three tabs hid most of them, and after a relaunch the control opened on an empty Active tab while an upcoming event sat one tap away. Covers showed at 56pt on the home screen of a photo app. The pending card and the "Join with invite code" button floated mid-screen under a short list.
**Rejected.** Keeping the control and opening it on the first tab that holds an event, which still hides the other two. Rows for every section, which shrink the covers back to thumbnails.
**Cost.** The segmented control and its store go. Every card loads a presigned cover, which `GET /events` already returns (D-118), so a list of many events loads many covers.
**Reopen if.** A tester's account holds enough events that the list needs a filter.

### D-127: Where the Schedule's Add, Delay, Edit and Delete live
**Decision.** Amends D-121 and spec §2.5.5. Ukasha ruled on these on 2026-10-03, from the critique in D-124. D-121's server rules stand. A Delay moves the start and the end before a sub-event starts and only the end after, and Delete is refused for the last sub-event and for one with photos.
- Add is the Admin's "+" in the iOS navigation bar, beside the avatar, and a Material 3 FAB on the Android Schedule tab.
- Delay shows as a button on two sub-events only, the one In Progress, on the Live card, and the next one to start. Every row reaches Delay from its long-press menu on both platforms, from a swipe action on iOS, and from Sub-event Detail.
- The Admin's long-press menu holds Delay, Edit, Get Directions and View Photos. Delete is not in it.
- Sub-event Detail puts Edit in its toolbar for the Admin, as "Edit" on iOS and a pencil icon button on Android. Directions and Photos sit side by side as one button pair, and a Photographer, who has no Home, sees Directions alone. The Admin's Delay and the venue's check-in QR sit below as grouped rows, the QR marked "Coming soon" until S-16.
- Delete stays at the foot of the Edit sheet, as a red row on iOS and a red text button on Android, disabled while the sub-event is the event's only one, with a footer that says why.
- A row reads as a timeline: the start over the end time in a column, the Roman numeral in Fraunces before the name, the venue in sentence case under it, and the status at the trailing end.
- The Live card shows the sub-event In Progress above the list, with "Live now", its times and venue, View Photos and Delay, in `hero` and `onHero` (D-124).
- The Delay sheet offers 15 minutes, 30 minutes, 1 hour and 2 hours in the platform's segmented control, with Custom as the last segment. Custom shows hour and minute wheels on iOS and Material's time input in 24-hour form on Android. The preview strikes through the old times beside the new ones, with D-121's line on whether the start moves, and the button names the amount, "Delay 30 Minutes" on iOS.
**Why.** D-121 put Delay on every row, so each row held a Delay pill and a chevron, two targets in one row, and a sub-event days away looked as urgent as the one running late. Both platforms put a screen's add action in the bar or a FAB, and the Schedule's "+" was a grey circle that read as disabled.
**Rejected.** Delay on every row (D-121). Delay only in Detail, two taps away while a sub-event runs late. Delete in the long-press menu, which puts a destructive action one slip from Edit.
**Cost.** A swipe action and a context menu on iOS, a long-press menu and one more FAB on Android. Delaying a sub-event past the next one takes two steps.
**Reopen if.** Testers miss Delay on a row past the next one.

### D-128: Each platform's own date and time pickers replace the wheel
**Decision.** Amends D-110. Ukasha ruled on these on 2026-10-03, from the critique in D-124.
- Start and end dates and times use `@expo/ui`'s `DatePicker`. On iOS it is SwiftUI's compact style, a date button and a time button that open Apple's calendar and time wheel. On Android, read-only outlined fields open Compose's date and time pickers in a dialog.
- `@quidone/react-native-wheel-picker` leaves `apps/mobile` once nothing imports it.
- D-110's map providers stand, Apple Maps on iOS and Google Maps on Android once its key is in the build. The venue picker's layout changes:
  - The map fills the sheet, with the search field over it and results in a panel under the field.
  - Current location is a button on the map.
  - Once a pin drops, a card at the bottom holds the venue's name field and "Use This Venue".
  - A search with no match shows "No results" in the results panel, not a red error banner.
  - On Android, until the Maps key is in the build, the picker shows search results and "Use my current location" with no map, and never the dashed placeholder box.
**Why.** The wheel looked foreign on both platforms. D-110 chose it to avoid per-platform code, but `@expo/ui` already ships both platforms' pickers in the build, and the Compose pickers are what every Android date field opens. Android users saw a dashed "not in this build yet" box where the map goes.
**Rejected.** The wheel (D-110). `@react-native-community/datetimepicker`, which duplicates `@expo/ui` and costs a rebuild (`apps/mobile/AGENTS.md`).
**Cost.** The date and time field is two components, one per platform. Removing the wheel is JavaScript only, so no machine rebuilds.
**Reopen if.** Compose's picker cannot open from a field inside the Add Sub-Event sheet on the Pixel.

---

# Q. Round 2 of the design critique (2026-10-03)

Ukasha ruled on each entry in this section on 2026-10-03, after the critique of the Figma frames for the album, privacy and Manage screens. The prototypes that draw them are in the critique artifact, and every one keeps these rulings.

### D-129: Do Not Publish is set per event
**Decision.** Amends D-31, D-35, D-56, D-84, D-87 and D-109, and replaces the account-wide scope in spec §2.5.9, §4.2 and §4.19.
- A person turns Do Not Publish on for one event at a time. Hiding their face at one event changes nothing at another, where everyone keeps seeing it.
- It lives in that event's Event Preferences (D-132) and nowhere else. Account Settings has no Do Not Publish row.
- Within its event it stays permanent (D-31). Nobody turns it off there, the Admin included, and spec §6.1 keeps reverting it out of scope.
- The flag moves from `subject.dnp_activated_at` to `membership.dnp_activated_at`, set once and never cleared. A new membership starts with it off. Remove from Event keeps the row, so a removed member who rejoins keeps it (D-102).
- Reference photos are per event too (D-141). Turning Do Not Publish on in an event needs an accepted reference in that event (D-56, D-87), and the last one there cannot be deleted while it is on there.
- The worker blurs a matched face when the subject's membership in the photo's event has Do Not Publish on. Turning it on enqueues `reprocess` for that subject in that event only.
- The avatar shows as initials to everyone else wherever that event shows the person: Attendees, Pending Approvals, the uploader line and the people sheet. In an event where they left it off, the avatar shows.
- The self-visible marker, the viewer-scoped filter and the N+1 files work as before, inside each event (D-26, D-46, D-57).
**Why.** People want different rules at different events. A guest may hide at a colleague's wedding and show at a sibling's. Account-wide meant one permanent switch over every event to come, which pushes a cautious person never to turn it on. The Figma frames designed it per event, with copy that says so.
**Rejected.** Account-wide, spec v11's scope. A per-event setting that can be turned off, which D-31 rejects inside one event for the same reasons. Copying the setting into each new event by default, which brings the account-wide switch back.
**Cost.** A migration adds the column to `membership` and drops it from `subject`; S-29 writes it. The avatar rule reads memberships instead of the subject. Someone who wants privacy everywhere turns it on in each event, and photos uploaded between their join and that tap show their face until `reprocess` finishes. The demo account turns it on in the demo event beforehand.
**Reopen if.** Testers turn it on in every event they join, which says they wanted one switch.
**Amended (see D-143).** Until S-29 supplies event-scoped avatar privacy, S-06 returns no attendee avatar. S-29 replaces that staging rule with this event-scoped rule through the shared presigner.
**Amended (see D-144).** Reject keeps the row as `removed`, so it keeps the flag too. S-29 makes Cancel Request retain the row with status set to `removed` instead of deleting it.

### D-130: Only the uploader or the Admin deletes a photo, and nobody restores it
**Decision.** Amends D-42, D-96 and D-123, and spec §2.5.6, §2.5.7 and §4.21.
- A photo is deleted by the person who uploaded it or by the event's Admin, and by nobody else. The API answers anyone else 403.
- Deletion is permanent. Neither the uploader nor the Admin can restore the photo, and the 30-day window for photos goes. The Review Queue loses its Removed Photos section and every Restore button.
- The Admin's action is called Delete too. "Remove" stays the word for a blur region and for a person.
- Delete asks first, in a destructive alert: "Delete this photo? It's removed from the album for everyone and can't be restored." A multi-select delete in My Media asks once for the batch. No Undo snackbar follows.
- `DELETE /media/{mediaId}` calls one SQL function, `delete_media`, which sets `deleted_at` and sends a `media_delete` message in one transaction. The row stays, so Realtime tells every phone, and the 2,000 cap stops counting it.
- A deleted photo can be uploaded again. Its hash no longer counts as a duplicate, so the same bytes, from its uploader or anyone else, come back as a new photo with a new id, new files and a fresh face pass. This amends D-96. The merged `media_event_id_content_hash_key` index, `start_upload` and `complete_upload` still count deleted rows, so S-22 writes a migration that leaves them out of all three.
- The worker's `media_delete` deletes every object under the photo's `{media_id}/` prefix and the photo's `face`, `dnp_subject` and `manual_blur_region` rows. Every other job skips a deleted photo (arch §5).
- A photo still in the phone's queue is deleted on the phone. A deleted event keeps its 14-day soft delete; this entry covers photos only.
**Why.** Deleting a photo is how a guest takes back one they regret, and how the Admin takes down one that should not be there. A 30-day restore kept the bytes on the server and let the Admin bring back a photo its uploader had deleted.
**Rejected.** D-42's 30-day soft delete with Restore. An Undo snackbar, which is a restore under another name. Refusing a deleted photo's bytes forever (D-96), which stops someone who deleted a photo by mistake from adding it back from their gallery.
**Cost.** A tap past the confirm loses the photo, its blur regions and its flags, and uploading it again starts it from nothing. A photo the Admin deleted can come back the same way, so the Admin deletes it again or blocks the person. A sixth worker job, built in S-22a, and a migration in S-22.
**Reopen if.** Testers delete photos by mistake often enough to ask for them back.

### D-131: Scan leaves the tab bar and opens from My Media
**Decision.** Amends spec §2.5.1, §2.5.3 and §4.5, and S-16's scope.
- The Global shell has two tabs, Events and Profile. There is no Scan tab.
- Scan Venue QR opens full screen from a button in My Media's check-in banner. The banner shows only while a sub-event is In Progress and the person is not checked in for it, whether or not photos are waiting, so a guest can check in before the first photo. A Photographer, exempt from the gate (spec §4.5), never sees it.
- A result closes the scanner back to My Media. A code for a venue that is not one of this event's says so and records nothing; the app checks the payload's venue against the cached schedule. An offline scan is recorded and travels with the next pre-flight, as before (D-85).
- Photos waiting on a sub-event that has ended get "Ask the organizer to check you in." with no scan button, because a scan verifies only the sub-event In Progress at the venue (D-85).
**Why.** A tab is a place people go back to. Scanning happens once per sub-event, only for someone GPS could not check in, and only while photos wait, which My Media shows. Everyone checked in by GPS, by Force Verify or as a Photographer had a tab that did nothing for them.
**Rejected.** The Scan tab, spec v11's layout. A scan button in the Viewfinder, which is for taking photos. Keeping the button after the sub-event ends, when a scan can verify nothing.
**Cost.** S-16 builds a full-screen route instead of a tab. Someone who never opens My Media never sees the button.
**Reopen if.** Guests at the rehearsal look for a way to scan outside My Media.

### D-132: The avatar opens Event Preferences inside an event
**Decision.** Amends D-118, D-119 and D-125, and spec §2.5.1 and §2.5.9. It replaces round 2's proposal to fold the Figma's Event Preferences into Account Settings.
- Inside an event, the avatar in the header opens that event's Event Preferences, a page sheet with its own stack on iOS and a full-screen dialog on Android (spec §2.5.11).
- Event Preferences holds an account row, photo, name and email, that opens Account Settings inside the same sheet, and a "This Event" section with Reference Photos (D-141) and Do Not Publish (D-129), whose footer names the event.
- Account-wide settings stay in Account Settings, reached from the Profile tab and from that row. Event Preferences repeats none of them.
**Why.** Do Not Publish now belongs to one event, so it needs a screen that belongs to one event. The avatar is on every Event shell tab for every role, so every member reaches it in one tap. The Figma frames' notification and upload switches were account-wide settings drawn on an event's screen, where a switch reads as that event's.
**Rejected.** Folding Do Not Publish into Account Settings, round 2's proposal, which puts a per-event control in a global place. A gear on Home only, which a Photographer never sees. Copying the notification and upload switches in.
**Cost.** One screen with two per-event rows today. S-29 builds it, and S-20's reference photos screen opens from it.
**Reopen if.** Another per-event setting arrives. It goes in the same section.

### D-133: The app says "checked in", never "verified"
**Decision.** Amends the user-facing copy in spec §2.5.3, §2.5.7, §4.5 and §5.2.
- Every string a user reads says "checked in" for a verification. Force Verify reads "Check In Manually" on the Attendees sheet. The queue banner says "X waiting to check in" and "Ask the organizer to check you in." The Attendees filter offers "Checked In" and "Not Checked In".
- Code, tables and these docs keep "verification": `venue_verification`, `admin_verified_at`, the `unverified` answer and Force Verify as the action's name.
**Why.** Guests read "verified" as an identity check, like a blue tick. "Checked in" is what a guest does at a venue, and it is what the QR and the GPS check do.
**Rejected.** Renaming the tables and columns, a migration that changes no behavior.
**Cost.** The docs and the app use two words for one thing, and this entry is the bridge between them.
**Reopen if.** Testers read "checked in" as attendance tracking.

### D-134: Public and Local Only switch under the shutter, as each platform's camera does
**Decision.** Amends spec §2.5.4 and §4.7.
- The Viewfinder's Public / Local Only switch sits below the shutter, where the system cameras put Photo and Video. On iOS it is two text labels, the selected one in the accent, switched by a tap or a horizontal swipe on the preview, as in the Camera app since iOS 26. On Android it is a two-segment pill with an icon and a label in each, as Pixel Camera's photo and video switch.
- While Local Only is on, a pill with a lock reading "Local Only" stays at the top of the preview, where the eye is while framing.
- The rest of the screen follows each platform's camera. On iOS: close in a glass circle and the live sub-event's name in a glass capsule at the top, the session stack at the leading end of the shutter row, flip in a glass circle at the trailing end. On Android: close and the sub-event's name at the top, flip at the leading end and the session stack at the trailing end, both rounded squares, and Material 3 Expressive's shutter, a filled circle inside a ring.
- No flash, zoom or settings button (spec §2.5.4, §7).
**Why.** Spec §2.5.4 put the switch at the top, out of the thumb's reach and where neither platform's camera puts a mode. iOS 26 moved Photo and Video under the shutter, and Pixel Camera puts its photo and video switch there, so people already look there for the mode.
**Rejected.** The switch at the top. A segmented control above the shutter, round 2's first draft, which matches neither camera.
**Cost.** The two platforms' Viewfinders differ in layout, so the screen is two components.
**Reopen if.** Testers take Local Only photos by mistake.

### D-135: The session's photos stack in the gallery button's place
**Decision.** Amends spec §2.5.4 and §4.7.
- The running strip of the session's captures becomes a stack of the last three, newest on top, with the count on it, in the slot each system camera gives its gallery button. It is round on iOS and a rounded square on Android. It replaces the separate capture counter.
- Tapping it closes the Viewfinder to My Media at the live sub-event's section, where the new photos are (spec §4.7). It never opens a picker.
- Before the first capture the slot is empty.
**Why.** A strip across the preview covers what is being framed, and the counter was a second element saying the same thing. People already look at that corner for the last photo they took.
**Rejected.** The strip over the preview. A separate counter.
**Cost.** The session's earlier photos show only in My Media.
**Reopen if.** Testers want to check each shot without leaving the camera.

### D-136: My Media says when the camera opens
**Decision.** Amends spec §2.5.3 and §2.5.4.
- Between sub-events the camera button stays hidden (spec §2.5.4). A line in its place says when it comes back: "The camera opens at 7:00 PM, for the Nikah." After the last sub-event it says the event has ended and points to "+ Add Media".
- The line comes from the cached schedule, `currentSubEvent` and the next start, so it works offline.
**Why.** A button that disappears with no word reads as a bug, most of all to a guest who used it an hour earlier.
**Rejected.** A disabled camera button, which invites a tap that does nothing.
**Cost.** One line of state on My Media.
**Reopen if.** Never likely; copy only.

### D-137: My Media puts the newest sub-event first
**Decision.** Amends spec §2.5.3.
- My Media's sections run newest sub-event first, so the live one is on top. Home's album keeps the schedule's order, oldest first, because it reads as the story of the event.
**Why.** My Media is where people check what they just took and what is still waiting. By the third day the live section sat under every earlier one.
**Rejected.** The schedule's order in My Media.
**Cost.** The two tabs share the section pattern but sort it in opposite orders.
**Reopen if.** Testers expect both tabs in the same order.

### D-138: Home shows the cover before the event starts
**Decision.** Amends spec §2.5.2 and keeps D-119's header without a cover.
- Before the first sub-event starts, Home shows the cover the width of the screen as content, with the event's name, dates and a countdown, above the itinerary that stands in for the grid.
- Once photos arrive, Home is the grid with no cover. The cover never goes back in the header (D-119, D-125).
**Why.** Before the day Home has no photos, and the cover is the one picture the event has. It belongs in the content, which scrolls, and not in the bar.
**Rejected.** The cover in the header (D-119). An empty state alone.
**Cost.** One more state on Home.
**Reopen if.** The Admin skips the cover often enough that the state is mostly a placeholder.

### D-139: Approve All asks first only when it admits a Photographer
**Decision.** Amends spec §2.5.7.
- On Pending Approvals, Approve All approves at once when every selected request is for Guest.
- When the batch holds a Photographer request, it asks first and names the Photographers, because a Photographer uploads from anywhere with no check-in (spec §4.10).
**Why.** Most batches are guests, and a confirm on every batch teaches the Admin to tap through it. The Photographer link is the sensitive one (spec §2.1.3).
**Rejected.** A confirm on every bulk action. No confirm at all.
**Cost.** The confirm reads the roles in the selection.
**Reopen if.** An Admin approves a stranger as a Guest by bulk action and asks for a confirm there too.
**Amended (see D-144).** "Approve All" means the selection. Any approve whose batch holds a Photographer asks first, a single row included.

### D-140: Account Settings groups what stays on the phone
**Decision.** Amends spec §4.19's grouping and D-105.
- Account Settings, from the Profile tab and from Event Preferences' account row, has these sections, in order: the account row; Notifications, with Approval Alerts and Album Opens and Closes; "On This Phone", with Upload over Mobile Data, Camera Starts In, Appearance and Storage; Account, with Change Password, About and Legal and Delete My Account; and Log Out.
- "On This Phone" has a footer saying these settings stay on this phone and don't follow the account (D-105).
- Nothing about faces is here. Reference photos and Do Not Publish are both per event, in Event Preferences (D-129, D-141).
**Why.** D-105 keeps mobile data and the camera default on the phone, and the theme and the cache live there too. Grouping them tells the person that a second phone needs them set again.
**Rejected.** Spec §4.19's Upload, Appearance and Storage groups, which mix device settings in among account ones by name only.
**Cost.** None beyond the layout.
**Reopen if.** A setting that follows the account joins "On This Phone".

### D-141: Reference photos belong to one event, and Find My Photos searches one event
**Decision.** Amends D-56, D-84, D-87, D-91, D-109 and D-129, and spec §4.2, §4.11.2, §4.11.3, §4.17 and §4.19.
- A person adds reference photos to one event at a time, in that event's Event Preferences, up to 5 per event, each with exactly one face (D-91). Nothing carries from one event to another, and Account Settings has no reference photos.
- The profile photo is never a reference. It is the avatar and nothing more, so setting one queues no job.
- `face_reference` gets `event_id` and loses `source`. Matching in an event, for Find My Photos, the Recognized Faces strip and Do Not Publish, uses only the references people added to that event.
- Find My Photos works inside one event, from Home's filter sheet, against that event's references. With none there it asks the person to add some for this event. No screen searches across events.
- Do Not Publish in an event needs an accepted reference in that event, and the last one there cannot be deleted while Do Not Publish is on there (D-87).
- Adding or removing a reference enqueues `reprocess` for that subject in that event only, so every `reprocess` message names its event.
- Remove from Event keeps the person's references with the membership, and a rejoin matches them again (D-84). Deleting the account deletes them.
- A reference photo's key carries its event, `users/{user_id}/events/{event_id}/reference_{upload_id}.jpg`, and only its owner gets it presigned (D-109).
**Why.** People look different at each event. Bridal makeup, a dupatta over the hair or a new beard at one event matches badly against a plain selfie from another, and a weak match fails both ways: Find My Photos misses the person, and Do Not Publish leaves their face unblurred. References taken for the event match the face the camera sees there. Keeping them in one event also means no event's photos are searched with a face someone gave to another.
**Rejected.** One reference set for the account, spec v11's design. An account set with extra photos per event, which brings back the stale look. The profile photo as a reference.
**Cost.** People add references in each event, and Find My Photos and Do Not Publish do nothing for them in an event until they do. More reference photos stored per person. The `face_reference` migration, still unwritten, takes the new columns; S-20 writes it.
**Reopen if.** S-26's measurements show one set of references matching as well across events as per-event ones.

### D-142: Event Settings has its own endpoints, and switching to auto admits the pending requests
**Decision.** Amends D-110 and spec §2.5.7. Ukasha ruled on 2026-10-04, at S-07a's read-back.
- `GET` and `PATCH /events/{eventId}/settings` read and change the event's name, description and Approval Mode, for the event's Admin only. `GET /events/{eventId}` carries neither the description nor Approval Mode, for any role. The type is set at create and never changes.
- The cover keeps S-02's two endpoints. The app sends the `uploadId` to `PUT /events/{eventId}/cover`, and the API builds the key in its one key function (root invariant 12). A cover is replaced, never removed, and the old object stays in R2 (D-114).
- Switching Approval Mode from manual to auto admits pending requests in the same transaction: every pending Photographer, then pending Guests oldest `requested_at` first until the event holds 150 active Guests (spec §4.17). The rest stay pending for Pending Approvals. One SQL function, `update_event_settings`, called with `rpc`, makes the whole change and takes the event row's lock before it counts, as `join_event` does (D-95, arch:membership).
- When anyone is pending, the switch asks first. The confirm gives the number pending and names each pending Photographer, as Approve All does (D-139), and the settings GET returns both. Switching from auto to manual changes no membership.
- The Admin's settings writes follow D-121 and D-100. They need a connection and are never queued, two of the Admin's phones resolve as last write wins, an archived event can be edited, and other phones see an edit the next time they fetch the event. A switch to auto on an archived event admits its pending requests as on any other event. No invite opens an archived event, but these people asked before the archive, and the switch is the Admin's own choice to let them in.
- Until S-05, S-06, S-07 and S-24 ship, the Manage hub shows their rows disabled, and each of those slices enables its own row. The live status card has no placeholder and arrives with S-31.
**Why.** Only the settings form shows the description and Approval Mode, so a Guest's or a Photographer's event response has no use for them. Once the mode is auto, a request left pending waits behind a setting that no longer asks for approval, and before S-07 ships nothing could let it in. The guest cap still applies at approval, as arch:membership already says for a manual event. A Photographer uploads with no check-in (spec §4.10), so the switch names each one before admitting them, as Pending Approvals does.
**Rejected.** Adding the description and Approval Mode to `GET /events/{eventId}` for every role. Leaving pending requests pending on the switch. Refusing the switch when the pending Guests do not fit. Admitting pending Guests only. A version check on the PATCH. A placeholder status card.
**Cost.** A migration in S-07a for `update_event_settings`. The switch is a third way a person becomes active, beside `join_event` and Pending Approvals' approve, so S-25 enqueues `reprocess` from it too (D-84), and S-27 sends Approval Alerts for each request it admits (spec §4.16). A request that arrives between the settings GET and the PATCH is admitted without being named in the confirm. The hub shows disabled rows until Phase 2 ends.
**Reopen if.** An Admin switches to auto and is surprised by who got in.

### D-143: Attendee management rulings from S-06's read-back
**Decision.** Amends D-35's avatar staging and D-129's implementation order for Attendees, and specifies spec §2.5.7, §4.4 and §4.17. Ukasha approved these rulings on 2026-10-04, at S-06's read-back, and the search trim and the 401 resend at its done-stage review the same day.
- Attendees lists only `active` memberships, the creator Admin included. The Admin searches by literal case-insensitive name text, trimmed as a name is and at most 80 code points, and filters by role. The API orders by `profile.full_name`, then `membership.user_id`, and returns pages of 50 with an opaque cursor. Pending requests belong to S-07. Removed and blocked people leave this list. S-06 builds no unblock or membership-history screen. S-17 adds check-in filtering and Check In Manually.
- Four endpoints, for the event's active Admin only: `GET /events/{eventId}/attendees`, `PATCH /events/{eventId}/attendees/{userId}/role`, `POST /events/{eventId}/attendees/{userId}/remove`, and `POST /events/{eventId}/attendees/{userId}/block`. The GET takes optional `search`, `role` and `cursor` query fields. Only the path identifies the event and the target user (hb §5.3).
- Each list row carries `userId`, `fullName`, `role`, `requestedAt`, `accessVersion` and `avatar`. The response carries `attendees` and nullable `nextCursor`. Reuse `FullName`, `MembershipRole`, `Timestamp` and `PresignedImage` from `packages/shared-types`. No verification state, avatar key, face identity or embedding is returned. `requestedAt` reads the current membership's `requested_at`, including a rejoin (arch:membership).
- S-06 changes an active non-Admin target from Guest to Photographer or Photographer to Guest, sets its status to `removed`, or sets it to `blocked`. Actions write only `role` or `status`; the version trigger advances the counter too. They never delete the membership. Uploads stay, and removal permits rejoining while blocking refuses it (D-102). The API and a database update guard protect the creator's Admin role and identity (D-114). The guard also refuses promotion of another membership to Admin. D-114's manual handling of account deletion still applies.
- S-06's API migration adds `membership.access_version`, a positive counter initially 1, and a trigger that advances it when `role`, `status` or `requested_at` changes. Unrelated fields do not advance it. The returned `accessVersion` is an opaque token combining the membership row's `id` and this counter. Including the row identity stops a deleted and recreated membership from matching an old token. Every mutation carries `expectedVersion`; the role PATCH also carries `role`, restricted to `InviteRole`.
- The service checks the actor's Admin permission and event scope. Each mutation calls one SQL function with `rpc`, takes `join_event`'s `FOR NO KEY UPDATE` lock on the event, rechecks the event and actor, then checks the target and version before writing. Role conversion to Guest counts active Guests under that lock and refuses the 151st with 422 `event_full`. The role stays unchanged on refusal. Joins, automatic admission and S-07 approvals share this lock (arch:membership, D-95).
- A deleted or unknown event, or a target with no membership in the path's event, answers 404 `not_found`. A non-active actor answers 403 `not_member`, and an active Guest or Photographer actor answers 403 `wrong_role`. A protected Admin target answers 400 `invalid_request`. A non-active target or a stale token answers 409 `membership_changed`. None of these writes anything. A matching-version same-role request answers 200 without changing the version. Every successful mutation answers 200 with the target's `membership`, carrying `userId`, `role`, `status` and its current `accessVersion`; it returns no target profile. A completed change makes its old token stale, so a repeat answers `membership_changed` and the app refetches.
- Attendees is not persisted across app restarts. Its writes need a connection, are never queued, and are never retried when their result is uncertain. A 401 is not uncertain, because the API refuses it before the handler runs, so the client's one resend after an Auth refresh applies. An uncertain response or `membership_changed` refetches the list before another action. If a detail sheet no longer has a loaded target, it returns to Attendees instead of acting from a stale record. Role/removal refusals recheck the Event shell as hb §5.3 requires. Membership has no Realtime (D-118).
- An archived event permits these reads and writes. A deleted event refuses them. Sub-event timing, overlap and album state do not gate attendee management. All actions preserve verification fields and the membership's future event-scoped Do Not Publish flag (D-129).
- Until S-29 adds `membership.dnp_activated_at` and upgrades the shared avatar presigner, Attendees returns `avatar: null` for everyone and the app draws initials. It reads no avatar key and presigns no attendee avatar. S-29 changes that mapper to use event-scoped privacy through the shared presigner, so the owner sees their photo and other viewers follow D-35, D-109 and D-129. S-06 does not use the account-wide `subject` flag as a substitute.
**Why.** S-06's brief omitted the cap check on role conversion and D-114's Admin guard. A delayed removal could otherwise affect a person who rejoined after the original request. The current avatar helper reads an account-wide flag, while S-29 owns the event-scoped replacement. These rules let S-06 ship without moving that migration or disclosing the wrong avatar.
**Rejected.** Listing inactive people without rules for their actions or profile visibility. Queueing access changes offline. Blind retries and last-write-wins attendee actions. A counter without the membership row identity. Moving S-29's Do Not Publish migration into S-06. Reading the old account-wide flag for attendee avatars. Loading every Photographer in one unbounded list.
**Cost.** S-06 adds a version column, two update guards, SQL functions and a conflict code. Admins need connectivity and must refetch after a stale or uncertain result. Attendee avatars stay hidden until S-29. S-07 uses the same access-version machinery for pending actions, and S-29 upgrades attendee avatars.
**Reopen if.** The Admin needs to review removed or blocked people, or testers need attendee management offline.
**Amended (see D-144).** S-07's batch actions name their targets in the body, each with its `accessVersion`. Pending Approvals returns `avatar: null` under the same staging until S-29.

### D-144: Pending Approvals rulings from S-07's read-back
**Decision.** Amends D-129, D-139 and D-143, and specifies spec §2.1.3, §2.5.7 and §4.4. Ukasha ruled on the first three on 2026-10-04, at S-07's read-back, and let the routine calls stand.
- Reject sets the membership to `removed` and keeps the row. The person may ask again through a live invite, as a removed member may (D-102), and the app already routes a `removed` row as it routes no row (D-115). The row keeps the `dnp_activated_at` that S-29 adds, which D-129 says is never cleared. Cancel Request still deletes the caller's own pending row until S-29, which makes a cancel retain the row with status set to `removed` instead.
- The Admin blocks a pending request one row at a time, after a confirm. Block sets `blocked`, and the person sees Join Blocked the next time they open an invite (D-115). There is no bulk block.
- Approve and reject take a batch of 1 to 50 distinct people, and a tap on one row sends a batch of one. The body names each target by `userId` with the `accessVersion` the list returned, so a request cancelled and made again through the other link never matches (D-143). A batch is all or nothing. A target with no row in the event, one that is not `pending`, the Admin's included, or a stale token answers 409 `membership_changed`. Guests that would take the event past 150 active Guests answer 422 `event_full`, and Photographers do not count (D-102). Either refusal writes nothing.
- Four endpoints, for the event's active Admin only: `GET /events/{eventId}/join-requests`, `POST /events/{eventId}/join-requests/approve`, `POST /events/{eventId}/join-requests/reject` and `POST /events/{eventId}/join-requests/{userId}/block`. Each write is one SQL function called with `rpc`. It takes `join_event`'s `FOR NO KEY UPDATE` lock on the event, rechecks the event and the actor, then locks the target rows in `user_id` order before it checks them, so two overlapping batches cannot deadlock (arch:membership, D-95). The event and actor refusals are D-143's.
- Routine calls:
  - The list holds `pending` rows, oldest `requested_at` first, then `user_id`, in pages of 50 with an opaque cursor. Each row carries `userId`, `fullName`, `role`, `requestedAt`, `accessVersion` and `avatar`. The response also carries `guestPlacesLeft`, the active Guest places the cap leaves, because the error body has no room for it and the app says how many fit after a 422.
  - `avatar` is null for everyone until S-29, as D-143 rules for Attendees.
  - Any approve whose batch holds a Photographer asks first and names them, a single row included. Reject asks nothing, since the person can ask again.
  - An archived event permits all three actions, a deleted one answers 404 `not_found`, and sub-event timing gates none of them, as D-142 and D-143 rule.
  - The writes need a connection, are never queued, and are never retried when their result is uncertain. A 409 or an uncertain result refetches the list before another action (D-143).
  - The list refetches on focus, on foreground, on pull, after every action, and every 30 seconds while open, as the requester's screen does (D-115). Membership has no Realtime (D-118).
  - The Manage hub's row has no count badge, and stays enabled on an `auto` event, where the cap can leave requests waiting (D-142).
**Why.** S-07's read-back found four gaps. Reject deleted the row a rejoined member's Do Not Publish flag will live on. Spec §2.1.3 and §4.4 listed Block on a request and §2.5.7 did not, and no function could block a pending row. "Approve All" had no meaning once the list is paged. Nothing said what a batch that crosses the cap or holds a stale row does.
**Rejected.** Deleting the row on reject. Bulk block. A partial batch that admits the oldest Guests that fit, as D-142's switch does, because the Admin picked these people by hand. An endpoint that approves every pending request, which admits rows the Admin never loaded. A confirm on reject.
**Cost.** One migration with four SQL functions. A `removed` row now also means "rejected", so the table cannot tell a rejected requester from a removed member, and nothing reads the difference yet. An Admin whose batch is refused deselects and taps again. S-29 changes Cancel Request.
**Reopen if.** An Admin needs to see who was rejected, or testers find a batch refused at the cap confusing.

## Open items that are not decisions yet

These are not settled and should not be treated as though they are.

- **Similarity thresholds.** Not measured; the plan and the table are `docs/ARCHITECTURE.md` §6. Shipping an example number is how the blur silently fails in a demo.
- **Whether the standby actually works.** D-79 defines it. It is not real until `scripts/provision.sh` has run against a real VM on one of the three credits. Half a day in Phase 7.
- **The feature-complete date.** The buffer is imaginary until a date is attached to "feature complete." March 2027 has been proposed and not agreed. Handbook §14.7 has the two things the build-fast-harden-later plan gets wrong.
- **The judge-device plan in D-61.** Written down as a decision, not yet rehearsed. It is not real until the build is installed on the actual devices and someone has joined an event on them.
- **How the stable stack sits beside development on one server.** D-78's open item and `docs/ARCHITECTURE.md` §7. Settle it before Phase 7.
- **Whether Do Not Publish blurring uses a lower match threshold than recognition.** `docs/ARCHITECTURE.md` §6, settled with S-26's measurements.
- **Why D-69 kept the client thumbnail.** The alternative, the worker writing every thumbnail, lost without a recorded reason. Write the reason into D-69 while someone still remembers it.
