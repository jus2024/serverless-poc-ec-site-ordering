#!/usr/bin/env bash
# run-e11b.sh — E11（リアル版）: 消化上限を少し超える緩やかな継続負荷で、小さな滞留を出しつつ
#   S が段階的に育つのを待つ → 投入停止 → 滞留ゼロまで drain（親シャード消化完了）→
#   バースト1発で同時実行を実測。「親が片付けば負荷育成 S でも S×P に届くか」を検証する。
#
# E8/E9（滞留を抱えたまま測定 → ~40〜81）との唯一の違いは「滞留ゼロにしてから測る」こと。
# D=50ms consumer 前提。
#
# 注意（過去の失敗の教訓）:
#   - overload.mjs を kill しても fork された e2-burst 子が生き残ることがある。
#     本スクリプトは stop 時に `pkill -9 -f e2-burst.mjs` でパターン一括 kill する。
#   - 高レートで殴ると滞留が膨れて drain が長引く。消化上限を「少しだけ」超える緩やかな
#     レートにして、小さな滞留で S を育てる（リアルな運用に近い）。
#
# 使い方: bash tmp/shard-autoscale-probe/run-e11b.sh

set -uo pipefail
# node / npm / aws CLI が PATH 上にあること（Node.js 20+ 推奨）。

REGION="${REGION:-us-west-2}"; TABLE="shard-autoscale-probe"; FUNC="shard-autoscale-probe-consumer"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS="$HERE/logs"; mkdir -p "$LOGS"
P=10
TARGET_S=16
GROW_CAP_SEC=600        # 緩やか育成の上限（10分）
DRAIN_FLOOR_MS=3000
DRAIN_CAP_MIN=25

kill_writers() { pkill -9 -f 'e2-burst.mjs' >/dev/null 2>&1 || true; pkill -9 -f 'overload.mjs' >/dev/null 2>&1 || true; }

echo "== run-e11b.sh START (緩やか継続負荷で S を育て→滞留ゼロ→バースト測定) =="

# ---- P1: 緩やか継続負荷で S を育てる ----
# 2 proc・中 concurrency で ~5-8k/s を狙う（S が育つと table 容量も増え、徐々にレートが上がる）。
echo ""
echo "== [P1] gentle continuous load until S>=$TARGET_S (cap ${GROW_CAP_SEC}s) =="
node "$HERE/overload.mjs" --procs 3 --rounds 100000 --round-items 20000 \
  --concurrency 40 --item-bytes 1024 --round-gap-ms 150 \
  --table "$TABLE" --region "$REGION" > "$LOGS/e11b.p1.driver.log" 2>&1 &
P1LOG="$LOGS/e11b.p1.shards.log"; : > "$P1LOG"
START=$(date +%s); S=0
while :; do
  S="$(node "$HERE/count-shards.mjs" --table "$TABLE" --region "$REGION" 2>/dev/null \
    | grep -oE 'OPEN_SHARDS=[0-9]+' | sed -E 's/OPEN_SHARDS=//')"
  NOW=$(date +%s)
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) S=$S elapsed=$(( NOW - START ))s" | tee -a "$P1LOG"
  if [ -n "$S" ] && [ "$S" -ge "$TARGET_S" ] 2>/dev/null; then
    echo "[P1] reached S=$S; stop injecting now (keep backlog small)" | tee -a "$P1LOG"; break
  fi
  if [ $(( NOW - START )) -ge "$GROW_CAP_SEC" ]; then
    echo "[P1] grow cap ${GROW_CAP_SEC}s hit at S=$S; stop" | tee -a "$P1LOG"; break
  fi
  sleep 25
done
kill_writers
echo "[P1] writers killed. settle 90s for delayed splits..."
sleep 90
S="$(node "$HERE/count-shards.mjs" --table "$TABLE" --region "$REGION" 2>/dev/null \
  | grep -oE 'OPEN_SHARDS=[0-9]+' | sed -E 's/OPEN_SHARDS=//')"
echo "== [P1] done. grown S=$S =="

# ---- P2: 滞留ゼロ待ち ----
echo ""
echo "== [P2] drain until IteratorAge <= ${DRAIN_FLOOR_MS}ms (cap ${DRAIN_CAP_MIN}min) =="
node "$HERE/drain-wait.mjs" --function "$FUNC" --region "$REGION" \
  --floor-ms "$DRAIN_FLOOR_MS" --cap-min "$DRAIN_CAP_MIN" --interval-sec 30 \
  2>&1 | tee "$LOGS/e11b.p2.drain.log"
DRAIN_VERDICT="$(grep -oE 'verdict=[A-Z]+' "$LOGS/e11b.p2.drain.log" | tail -1 | sed 's/verdict=//')"
sleep 30
S="$(node "$HERE/count-shards.mjs" --table "$TABLE" --region "$REGION" 2>/dev/null \
  | grep -oE 'OPEN_SHARDS=[0-9]+' | sed -E 's/OPEN_SHARDS=//')"
echo "== [P2] drain verdict=$DRAIN_VERDICT  S after drain=$S =="

# ---- P3: 滞留ゼロからバースト → 同時実行測定 ----
BURST_ITEMS=$(( S * P * 400 )); [ "$BURST_ITEMS" -lt 60000 ] && BURST_ITEMS=60000
echo ""
echo "== [P3] burst=$BURST_ITEMS across S=$S, sample ConcurrentExecutions (period=1s) =="
P3_T0="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node "$HERE/overload.mjs" --procs 4 --rounds 1 --round-items $(( BURST_ITEMS / 4 )) \
  --concurrency 50 --item-bytes 1024 --round-gap-ms 0 \
  --table "$TABLE" --region "$REGION" > "$LOGS/e11b.p3.burst.log" 2>&1
kill_writers
echo "[P3] burst injected at $P3_T0; sampling ~150s"
sleep 150
P3_T1="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "== [P3] ConcurrentExecutions (period=1s) [$P3_T0 .. $P3_T1] =="
node "$HERE/conc-sample.mjs" --function "$FUNC" --region "$REGION" \
  --t0 "$P3_T0" --t1 "$P3_T1" | tee "$LOGS/e11b.p3.conc.log"

echo ""
echo "== E11 SUMMARY: grown S=$S expected S×P=$(( S * P )) drainVerdict=$DRAIN_VERDICT window=[$P3_T0..$P3_T1] =="
echo "== run-e11b.sh DONE =="
