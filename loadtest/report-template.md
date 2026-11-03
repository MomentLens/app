# Load test report: <date>

Copy this file to `loadtest/results/<date>-report.md` (git ignores that folder) and fill it in as the ladder runs. When the session ends, the numbers that matter go into the decision log entry that records them, because `results/` stays on one laptop.

## Setup

- Server: Azure `<size>` in UAE North, `<branch and commit deployed>`.
- Realtime limits: `<defaults (D-163), or what was raised and the D-nn that raised it>`.
- Load machines: `<this Mac on <connection>, or the list of machines and each one's ACCOUNT_OFFSET>`.
- Round trip with 1 guest: P95 `<n>` ms for `GET /events/{eventId}/media`. Every P95 below includes this network time.
- Model: think time `<THINK_MIN>` to `<THINK_MAX>` s, `FOREGROUND_SHARE` `<n>`, `<n>` uploads a minute per event, `<n>` photos per event before the run.
- Other users on the server during the session: `<none, or who>`.

## Ladder

One row per run. A run passes when every threshold passes.

| Run | Guests | Events | WebSockets held | Requests a second | Worst endpoint P95 / P99 | Errors | Realtime closes | Delivery lag P95 | Result |
|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | |

## Step `<n>`: `<guests>` guests

Paste the run's `results/<run>-summary.md` here.

Server at the hold's peak, from `results/<run>-server.csv` (`cpu_pct` is a percent of one core, so 400 is the whole server):

| Process | CPU % | Memory |
|---|---|---|
| momentlens-api (unit) | | |
| momentlens-worker (unit) | | |
| nginx (unit) | | |
| supabase-db | | |
| supabase-rest | | |
| supabase-auth | | |
| realtime-dev.supabase-realtime | | |
| supabase-envoy | | |
| Host load average, available memory, TCP connections on 443, Postgres connections | | |

Realtime log lines about limits: `<paste, or none>`

## What broke first

- Limit for this configuration: `<last passing guests>` guests (`<first failing guests>` failed).
- Which threshold failed first, and at what time in the run: `<threshold, time>`.
- The component, and the evidence that names it: `<a log line, an error code, a process at 100% of one core, a counter at its limit>`.
- What raising it would take, and what it costs: `<setting, the D-nn it needs, the risk>`.

## Next wall

After raising the limit above: `<the next limit, and the same evidence>`.
