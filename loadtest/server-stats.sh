#!/usr/bin/env bash
# Samples the server every 5 s during a load test run and prints CSV on stdout. It runs on the
# server, fed from a laptop over SSH, and changes nothing there (README, "Running a step"):
#
#   ssh momentlens 'sudo bash -s -- 600' < loadtest/server-stats.sh > loadtest/results/<run>-server.csv
#
# The argument is how many seconds to sample. At the end, Realtime's log lines about limits go to
# stderr, so they show in the terminal.
#
# cpu_pct is CPU time over wall time as a percent of one core, so 400 means all four cores, for
# systemd units and Docker containers alike.

set -euo pipefail

DURATION="${1:-600}"
INTERVAL=5
UNITS=(momentlens-api momentlens-worker nginx)
REALTIME=realtime-dev.supabase-realtime
DB=supabase-db
START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

unit_ns() { systemctl show -p CPUUsageNSec --value "$1" 2>/dev/null || echo 0; }

declare -A last_ns
for unit in "${UNITS[@]}"; do last_ns[$unit]="$(unit_ns "$unit")"; done
last_t="$(date +%s%N)"

echo "time,source,name,value,detail"
end=$(($(date +%s) + DURATION))
while [ "$(date +%s)" -lt "$end" ]; do
  sleep "$INTERVAL"
  now="$(date -u +%H:%M:%S)"
  t="$(date +%s%N)"
  elapsed=$((t - last_t))
  last_t="$t"
  for unit in "${UNITS[@]}"; do
    ns="$(unit_ns "$unit")"
    pct="$(awk -v a="$ns" -v b="${last_ns[$unit]}" -v e="$elapsed" 'BEGIN { printf "%.1f", (a - b) * 100 / e }')"
    last_ns[$unit]="$ns"
    echo "$now,unit_cpu_pct,$unit,$pct,mem_bytes=$(systemctl show -p MemoryCurrent --value "$unit")"
  done
  # docker stats measures CPU over its own short window, also as a percent of one core.
  docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' |
    while IFS=, read -r name cpu mem; do
      echo "$now,container_cpu_pct,$name,${cpu%\%},mem=${mem// /}"
    done
  read -r load1 _ </proc/loadavg
  echo "$now,host,load1,$load1,"
  echo "$now,host,mem_available_kb,$(awk '/MemAvailable/ { print $2 }' /proc/meminfo),"
  # Phones' connections to nginx: every WebSocket and every HTTP keep-alive connection.
  echo "$now,host,tcp_443_established,$(ss -Htn state established '( sport = :443 )' | wc -l),"
  echo "$now,host,postgres_connections,$(docker exec "$DB" psql -U postgres -tAc 'select count(*) from pg_stat_activity' 2>/dev/null || echo NA),"
done

echo "Realtime log lines about limits since $START_ISO:" >&2
docker logs --since "$START_ISO" "$REALTIME" 2>&1 | grep -iE 'limit|too many|rate|exceed' | tail -n 50 >&2 || true
