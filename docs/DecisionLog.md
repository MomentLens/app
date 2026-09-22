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

### D-36 — GPS is transmitted for verification and not persisted
**Decision.** Stripped from the image file. A separate reading rides with the pre-flight request, is validated against the sub-event's coordinates, and is not written to the media record.
**Why.** v9.1's onboarding promised GPS never reaches the network while the pipeline sent a per-photo GPS reading with every upload and stored one per queued item. The promise was misleading as written, which matters more in a consent screen than anywhere else.

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

### D-43 — Two notification channels, not four
**Decision.** Approval Alerts and Album Lifecycle only. Settings shows exactly two toggles.
**Why.** v9.1's Settings screen listed four toggles for two features, because Schedule Changes and Upload Activity had been deferred without updating Settings.

### D-44 — The demo script is the scope boundary
**Decision.** An eight-beat script lives in the spec, and anything not in it is not core scope.
**Why.** Scope discussions without an anchor drift forever. With one, "is this core?" becomes "does it appear in a beat?", which is answerable in five seconds.
**Corollary.** A seeded dataset that loads in ten seconds must exist before the defense, so that a WiFi failure does not become a live debugging session.
**Amended.** The v11 script in spec §9 has nine beats. D-62 replaced this corollary's fallback with a recording.
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
**Decision.** Express and the FastAPI worker run on the team's M1 behind a Cloudflare Tunnel named hostname for the demo. Supabase and R2 are unchanged. The Oracle ARM instance is still provisioned in week one, still runs production, and is still reachable during the defense.
**Why.** The M1 runs InsightFace 3 to 5 times faster than 2 OCPUs of Ampere, and demo latency is what a panel experiences. Dev and demo become the same environment. Oracle's capacity lottery stops being a demo-day risk.
**Why the instance stays regardless.** The deployment claim has to survive "show me." It is a fallback that is not sitting in the demo room. It is the shared backend the other two team members develop against, which is also the fix for a bus factor of one on demo morning. And D-38's reason is untouched: the home region is fixed at signup and ARM capacity is contested, so it is a week-one task or it never happens.
**Rejected.** Claiming a deployment without having one. "We deployed but chose our laptop due to compute costs" invites exactly one follow-up, and a panel that asks for the systemd unit and gets improvisation has learned something about the whole project rather than just about the server. D-45 is the team's own rule; this is that rule pointed at the deployment story.
**Cost.** ⚠ The laptop moves compute out of the cloud. It does not remove the network dependency: Supabase, R2 and the phones are all still on it. See D-61.
**The line to use.** Production runs on an Oracle ARM instance. The demo runs the API and worker locally behind a Cloudflare Tunnel because the M1 gives roughly four times the inference throughput of the free tier, and the panel should see real latency rather than free-tier latency.
**Amended (see D-76).** Development runs on the Oracle instance and the M1 demo stack goes up one month before the demo, so dev and demo are no longer the same environment.

### D-51 — ngrok is not the tunnel ~~(SUPERSEDED by D-78)~~
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

### D-92: The worker runs `buffalo_l`
**Decision.** The worker uses InsightFace's `buffalo_l` model pack, with the detection and recognition modules only, the configuration D-78 benchmarked. `buffalo_s` is not a fallback.
**Why.** Blur and Find My Photos both rest on recognition accuracy, and a missed match is the costly failure (spec §4.11.4.5). `buffalo_l` is the more accurate pack, and D-78's timings were measured on it, so the latency the team knows is the latency of the model it ships.
**Rejected.** `buffalo_s`, faster with lower accuracy, which trades away the one property a missed blur costs.
**Cost.** A larger model and slower recognition on large group photos: D-78 measured about 200ms per face at two threads on the free-tier instance.
**Reopen if.** The benchmark on the Netcup server misses D-78's bar.

## Open items that are not decisions yet

These are not settled and should not be treated as though they are.

- **Similarity thresholds.** Not measured; the plan and the table are `docs/ARCHITECTURE.md` §6. Shipping an example number is how the blur silently fails in a demo.
- **Whether the standby actually works.** D-79 defines it. It is not real until `scripts/provision.sh` has run against a real VM on one of the three credits. Half a day in Phase 7.
- **The feature-complete date.** The buffer is imaginary until a date is attached to "feature complete." March 2027 has been proposed and not agreed. Handbook §14.7 has the two things the build-fast-harden-later plan gets wrong.
- **The judge-device plan in D-61.** Written down as a decision, not yet rehearsed. It is not real until the build is installed on the actual devices and someone has joined an event on them.
- **Why D-69 kept the client thumbnail.** The alternative, the worker writing every thumbnail, lost without a recorded reason. Write the reason into D-69 while someone still remembers it.
