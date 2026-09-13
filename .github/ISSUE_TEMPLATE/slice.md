---
name: Work slice
about: One slice from docs/WorkSlices.md. One issue, one branch, one PR.
title: "S-XX: <slice name>"
---

<!-- References only. What the feature does lives in the spec, never in this issue (docs/WorkSlices.md). -->

**Spec:** §
**Handbook:** §
**Decisions:** D-
**Depends on:**
**Owner:**

## Definition of done

- [ ] zod schema merged in `packages/shared-types` before any UI or handler
- [ ] RLS policy written, or noted here as not applicable. Only `media` and `event` have one (D-73)
- [ ] Human read before merge if this touches any RLS policy, the image-serving authorization check, the upload queue state machine, or auth and invite-token handling (D-68). If it touches none, say so here
- [ ] Negative authorization test for every new endpoint: another user, another event, the wrong role (D-73)
- [ ] Loading, empty and error states, not only the happy path (Handbook §15)
- [ ] Tested on a physical device if it touches camera, GPS or the queue (Handbook §10)
- [ ] Unit test for any pure logic (Handbook §11)
- [ ] Dark mode through tokens, no hardcoded hex
- [ ] Reviewed by one of the other two (Handbook §12)
- [ ] `docs/ARCHITECTURE.md` updated in this PR if it added a table, column, R2 key or job, and Ukasha has reviewed that change (D-75)
