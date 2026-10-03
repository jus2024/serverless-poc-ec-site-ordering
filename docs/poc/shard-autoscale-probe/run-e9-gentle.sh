#!/usr/bin/env bash
# run-e9-gentle.sh — E9 補足: 「消化が追いつく緩やかな低レート」で IteratorAge が秒オーダーに
#   収まり業務が回るか、を直接確かめる（本来の問い）。E9 本編(2k→16k)は消化上限を超過して
#   過負荷になり IterAge が分オーダーに膨れた。ここでは投入を消化上限(S=4 で ~800件/s)の
#   下と上に振り、滞留が秒オーダーで安定するレート帯を見る。
#
# D=50ms 消費者。S=4 の消化目安 = S×P÷D = 4×10÷0.05 = 800 件/s。
# 段構成:
#   G1: ~470 件/s（消化上限 800 の下）→ 滞留が出ず秒オーダーで安定するはず
#   G2: ~935 件/s（消化上限 800 の少し上）→ 軽い滞留は出るが S が追従すれば収まるか
#
# 各段 STAGE_SECS 継続投入 → S を 20s 間隔で記録 → metrics.mjs で IterAge/Conc 採取。
# 使い方: bash tmp/shard-autoscale-probe/run-e9-gentle.sh

set -uo pipefail
# node / npm / aws CLI が PATH 上にあること（Node.js 20+ 推奨）。

REGION="${REGION:-us-west-2}"; TABLE="shard-autoscale-probe"; FUNC="shard-autoscale-probe-consumer"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS="$HERE/logs"; mkdir -p "$LOGS"
RESULTS="$LOGS/e9-gentle-results.jsonl"; : > "$RESULTS"
STAGE_SECS=240

run_stage() {
  local tag="$1" target="$2" conc="$3" ritems="$4" gap="$5"
  echo ""
  echo "===== E9-GENTLE $tag: target≈${target} write/s (継続投入 ${STAGE_SECS}s, 消化上限 S×200/s) ====="
  local t0; t0="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  node "$HERE/overload.mjs" --procs 1 --rounds 100000 --round-items "$ritems" \
    --concurrency "$conc" --item-bytes 1024 --round-gap-ms "$gap" \
    --table "$TABLE" --region "$REGION" > "$LOGS/e9-gentle-${tag}.driver.log" 2>&1 &
  local pid=$!
  local slog="$LOGS/e9-gentle-${tag}.shards.log"; : > "$slog"
  local start now S; start=$(date +%s)
  while :; do
    S="$(node "$HERE/count-shards.mjs" --table "$TABLE" --region "$REGION" 2>/dev/null \
      | grep -oE 'OPEN_SHARDS=[0-9]+' | sed -E 's/OPEN_SHARDS=//')"
    now=$(date +%s)
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) S=$S elapsed=$(( now - start ))s" | tee -a "$slog"
    if [ $(( now - start )) -ge "$STAGE_SECS" ]; then break; fi
    sleep 20
  done
  local t1; t1="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  kill "$pid" >/dev/null 2>&1 || true; pkill -P "$pid" >/dev/null 2>&1 || true; wait "$pid" 2>/dev/null || true
  local eff; eff="$(grep -oE 'rate=[0-9]+/s' "$LOGS/e9-gentle-${tag}.driver.log" \
    | sed -E 's/rate=([0-9]+)\/s/\1/' | awk '{s+=$1;n++} END{if(n>0) printf "%d",s/n; else print 0}')"
  local sval; sval="$(grep -oE 'S=[0-9]+' "$slog" | tail -1 | sed -E 's/S=//')"
  echo "[$tag] effective≈${eff} w/s S(終端)=${sval}"
  sleep 70
  node "$HERE/metrics.mjs" --function "$FUNC" --region "$REGION" \
    --t0 "$t0" --t1 "$t1" --stage "$tag" --target "$target" \
    --effective "$eff" --shards "$sval" --json | tee -a "$RESULTS"
}

echo "== run-e9-gentle.sh START (低レート 470/935 件/s) =="
run_stage G1 470 3 400 600
run_stage G2 935 6 800 250
echo ""
echo "== run-e9-gentle.sh DONE =="
echo "結果: $RESULTS"
