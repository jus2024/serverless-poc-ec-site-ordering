#!/usr/bin/env bash
# Poll count-shards until OPEN_SHARDS unchanged for STABLE_SECS (3 min), cap CAP_SECS (10 min).
# Usage: poll-stable.sh <stageNum>
set -u
STAGE="${1:?stage number required}"
TABLE=shard-autoscale-probe
REGION=${REGION:-us-west-2}
DIR="$(cd "$(dirname "$0")" && pwd)"
POLL_LOG="$DIR/logs/stage${STAGE}.shards.log"
: > "$POLL_LOG"
STABLE_SECS=180
CAP_SECS=600
INTERVAL=30
start=$(date +%s)
last_S=""
last_change=$start
while :; do
  nowiso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  out=$(node "$DIR/count-shards.mjs" --table "$TABLE" --region "$REGION" 2>/dev/null)
  S=$(echo "$out" | grep -oE 'OPEN_SHARDS=[0-9]+' | sed -E 's/OPEN_SHARDS=//')
  warm=$(echo "$out" | grep -oE 'warm=[0-9]+w' | head -1)
  total=$(echo "$out" | grep -oE 'TOTAL_SHARDS=[0-9]+' | sed -E 's/TOTAL_SHARDS=//')
  items=$(echo "$out" | grep -oE 'items=[0-9]+' | head -1)
  echo "$nowiso S=$S $warm TOTAL=$total $items" | tee -a "$POLL_LOG"
  now=$(date +%s)
  if [ "$S" != "$last_S" ]; then last_S="$S"; last_change=$now; fi
  unchanged=$(( now - last_change ))
  elapsed=$(( now - start ))
  if [ "$unchanged" -ge "$STABLE_SECS" ]; then echo "RESULT stage=$STAGE verdict=STABLE S=$S unchanged=${unchanged}s elapsed=${elapsed}s"; break; fi
  if [ "$elapsed" -ge "$CAP_SECS" ]; then echo "RESULT stage=$STAGE verdict=CAP S=$S unchanged=${unchanged}s elapsed=${elapsed}s"; break; fi
  sleep "$INTERVAL"
done
