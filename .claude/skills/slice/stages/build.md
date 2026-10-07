## 4. Build

One package per session, in the card's build order: `/slice S-12 build api`, `/clear`, then `/slice S-12 build mobile`. Load the card, `git fetch origin`, and cut `feat/<id>-<package>` from the branch below it: the schema branch for the first package, the previous package's branch after that. If that branch is not on GitHub, stop and say which stage has not run. Read that package's `AGENTS.md`, the schema files the card names, by path, and the files you will change. Fetch a doc section only if the card lists its id.

**In the mobile build, ask for the screens once.** Before writing any screen, list the screens the card names and ask one question: do they have designs for these, as screenshots or Figma exports, or should you improvise? Never insist, and never ask twice. With no images, build every screen in the style of the screens already in `apps/mobile/src/features/`. With images for some screens, follow those and improvise the rest to match them. An image sets layout and direction; D-112 sets sizes and the spec sets behavior. The discussion log records which screens had an image and which were improvised, so the reviewer knows what to look at.

**The api build owns the card's migration**, if it has one. Create it with `pnpm exec supabase migration new <name>` and push it to the dev project when the tests or the phone need it, following Handbook §13.4 and asking first. Once pushed it is frozen: a change is a new migration.

1. Write each negative test the card lists for this package before the code it tests, run it, and watch it fail. Then write the code and watch it pass.
2. Run `slice-verifier` with the slice id, the package, the base (`origin/<the branch below>`), and the card's invariant numbers and negative tests. It runs the checks, keeps the full logs out of this session, and returns only failures.
3. Fix what it reports and run it again. After two failed rounds on the same failure, stop and ask the user; a third attempt means context is missing (Handbook §18.2).
4. When the verifier is clean, commit this package's work in small conventional commits.

Stay inside the package. Never edit `packages/shared-types`, `docs/` (the done stage writes any `ARCHITECTURE.md` change) or another package, and never add a dependency; if the card needs one of those, stop and ask. When the card is silent, wrong, or conflicts with a numbered invariant, ask the user rather than choosing a reading, and fix the card in the issue before building on the answer.

If the card says the slice touches the camera, GPS or the upload queue, ask the user to run it on a physical phone and report back, and log what they report. To try an API change on the phone before the stack merges, the developer deploys this branch to the dev server (Handbook §13.4); offer the commands, ask before running each, and remind them to put `main` back.

Push the branch and open `<id>: <package>` on the stack, naming the human-read surfaces the verifier listed. Post the discussion log. Tell the user the next stage: the next package in the card, or `/slice <id> done`.
