## 3. Schema

Load the card: `gh issue view <n> --json body`. `git fetch origin` and cut `feat/<id>-schema` from `origin/docs/<id>-rulings` if the read-back opened one, otherwise from `origin/main`. Read `packages/shared-types`. Write the zod schemas the card's "Produces" line names, and nothing else: every request, response and error shape the slice's endpoints use, following the paths, error body and status codes in Handbook §5.3. Run `pnpm typecheck`.

Commit, push, and open the PR `<id>: schema` on the stack. Do not wait for a review or a merge. Show the developer each exported schema name with its fields in a short list, since every later stage builds on that contract, then post the discussion log and tell them the next stage is `/slice <id> build <first package in the card>` in a fresh session.
