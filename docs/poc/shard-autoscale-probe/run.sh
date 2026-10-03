#!/usr/bin/env bash
# run.sh — 4 段の漸増負荷を順に投入し、各段で S 安定を待って CloudWatch を採取する（★従量課金）。
#
# 段構成（要件 2.1 / design §3.3）: 2k → 4k → 8k → 16k write/s で打ち切り。
#   Max=40k/S64 は E1〜E6 で既知のため実測せず、カーブから外挿で確認する。
#   proc 目安: 1 / 1 / 2 / 4（1 proc ≒ 2.5〜4.8k w/s）。
#
# 各段の進め方（S 安定ゲート。時間固定ではない）:
#   t0 記録 → overload.mjs を background 起動 → poll-stable.sh で
#   OPEN_SHARDS が 3 分変化なし（上限 10 分）まで待機 → t1 記録 →
#   driver ログから実効レート、count-shards から S を採取 →
#   metrics.mjs で [t0,t1] の IteratorAge(Max/Avg)/ConcurrentExecutions(Max) を採取 →
#   JSON 行を logs/results.jsonl に追記。
#
# コスト: 1KB 項目 × 4 段の投入。概算 $8〜15。warm 引き上げは不可逆のため終了後 teardown 必須。
#
# 使い方: bash tmp/shard-autoscale-probe/run.sh
#   結果: tmp/shard-autoscale-probe/logs/results.jsonl（段ごと 1 行 JSON）
#         docs/poc/shard-autoscale-probe-results.md に手で転記（または集計）。

set -uo pipefail
# node / npm / aws CLI が PATH 上にあること（Node.js 20+ 推奨）。

REGION="${REGION:-us-west-2}"
TABLE="shard-autoscale-probe"
FUNC="shard-autoscale-probe-consumer"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS="$HERE/logs"
mkdir -p "$LOGS"
RESULTS="$LOGS/results.jsonl"
: > "$RESULTS"

# 段ごとの (proc数, concurrency) 目安。概ね target w/s に合わせる。
#   stage: target  procs  concurrency(per proc)
#   1    : 2,000    1      15
#   2    : 4,000    1      28
#   3    : 8,000    2      24
#   4    : 16,000   4      26
run_stage() {
  local stage="$1" target="$2" procs="$3" conc="$4" rounds="$5" ritems="$6"
  echo ""
  echo "===== STAGE $stage: target=${target} procs=${procs} conc=${conc} ====="
  local t0; t0="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "STAGE${stage}_T0=$t0" | tee "$LOGS/stage${stage}.meta"

  # 負荷ドライバを background 起動（ログは stageN.driver.log）
  node "$HERE/overload.mjs" --procs "$procs" --rounds "$rounds" --round-items "$ritems" \
    --concurrency "$conc" --item-bytes 1024 --round-gap-ms 0 \
    --table "$TABLE" --region "$REGION" > "$LOGS/stage${stage}.driver.log" 2>&1 &
  local driver_pid=$!

  # 投入が立ち上がるまで少し待つ
  sleep 40

  # S 安定ゲート（3 分変化なし・上限 10 分）
  bash "$HERE/poll-stable.sh" "$stage"

  local t1; t1="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "STAGE${stage}_T1=$t1" | tee -a "$LOGS/stage${stage}.meta"

  # 投入停止（この段のウィンドウを閉じる）
  kill "$driver_pid" >/dev/null 2>&1 || true
  pkill -P "$driver_pid" >/dev/null 2>&1 || true
  wait "$driver_pid" 2>/dev/null || true

  # 実効レート（driver ログの rate=.../s の中央寄り = 代表値として平均を概算）
  local eff
  eff="$(grep -oE 'rate=[0-9]+/s' "$LOGS/stage${stage}.driver.log" \
    | sed -E 's/rate=([0-9]+)\/s/\1/' \
    | awk -v p="$procs" '{sum+=$1; n++} END{ if(n>0) printf "%d", (sum/n)*p; else print 0 }')"

  # S（安定値 = poll ログ末尾の OPEN_SHARDS）
  local sval
  sval="$(grep -oE 'S=[0-9]+' "$LOGS/stage${stage}.shards.log" | tail -1 | sed -E 's/S=//')"

  echo "[stage $stage] effective≈${eff} w/s  S=${sval}"

  # ESM メトリクスが CloudWatch に出揃うまで少し待つ
  sleep 75

  node "$HERE/metrics.mjs" --function "$FUNC" --region "$REGION" \
    --t0 "$t0" --t1 "$t1" --stage "$stage" --target "$target" \
    --effective "$eff" --shards "$sval" --json | tee -a "$RESULTS"
}

echo "== run.sh START (4 段 2k→4k→8k→16k, S 安定ゲート) =="
echo "WARNING: 従量課金が発生します（概算 \$8〜15）。終了後は必ず teardown.sh を実行してください。"

run_stage 1 2000  1 15 60  30000
run_stage 2 4000  1 28 80  50000
run_stage 3 8000  2 24 80  50000
run_stage 4 16000 4 26 100 50000

echo ""
echo "== run.sh DONE =="
echo "結果 JSON: $RESULTS"
echo "次: docs/poc/shard-autoscale-probe-results.md に転記 → teardown.sh で課金停止"
