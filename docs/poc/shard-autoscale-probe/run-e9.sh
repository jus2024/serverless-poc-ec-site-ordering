#!/usr/bin/env bash
# run-e9.sh — E9: D=50ms の速い消費者で「緩やかな負荷上昇に対し S が緩やかに増え、
#   滞留(IteratorAge)が秒オーダーに収まって業務が回るか」を実測する（★従量課金）。
#
# E1〜E8 との違い（design.md の過負荷前提からの転換）:
#   - 消費者 D=50ms（E8 までは 3.0s）。消化能力 = S×P÷D = S×10÷0.05 = S×200 件/s。
#     S=4→800件/s, S=8→1,600, S=16→3,200, S=32→6,400。
#   - 各段は「1発バースト」ではなく「目標レートで継続投入」。投入を流し続けたまま
#     S が追従し IteratorAge が低位で安定するかを観測する（＝定常運用の近似）。
#   - 段構成: 2k → 4k → 8k → 16k write/s を緩やかに倍々で上げる。
#       2k: S=4 の消化(800)を超えるが分割で S が育てば追いつく帯
#       4k: warm 4,000 境界。分割の入口
#       8k/16k: 4→8→16 の分割を誘発しつつ、D=50ms なら消化が追う
#
# 各段の進め方:
#   t0 記録 → overload.mjs を background で継続投入 → STAGE_SECS 秒のあいだ
#   20s 間隔で count-shards を回して S を追う → t1 記録 → 投入停止 →
#   metrics.mjs(period=60s) で [t0,t1] の IteratorAge(Max/Avg)/ConcurrentExecutions(Max) 採取 →
#   JSON 1 行を logs/e9-results.jsonl に追記。
#
# 判定の狙い: 各段で IteratorAge が秒〜十数秒オーダー（過負荷実験の時間オーダーではない）に
#   収まり、S が緩やかに増えるか。収まれば「設定を触らず緩やか負荷なら業務が回る」の実証。
#
# 使い方: bash tmp/shard-autoscale-probe/run-e9.sh

set -uo pipefail
# node / npm / aws CLI が PATH 上にあること（Node.js 20+ 推奨）。

REGION="${REGION:-us-west-2}"
TABLE="shard-autoscale-probe"
FUNC="shard-autoscale-probe-consumer"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS="$HERE/logs"
mkdir -p "$LOGS"
RESULTS="$LOGS/e9-results.jsonl"
: > "$RESULTS"

STAGE_SECS=240   # 各段の継続投入・観測時間（4 分）

# 段ごとの (proc数, 1proc内concurrency, round-items)。目標 write/s に合わせる。
# overload は procs 本の e2-burst を fork。各 e2-burst は round を回し続ける。
# round-gap-ms を入れてレートを緩やかに（過負荷で殴らない）保つ。
run_stage() {
  local stage="$1" target="$2" procs="$3" conc="$4" ritems="$5" gap="$6"
  echo ""
  echo "############################################################"
  echo "# E9 STAGE $stage: target=${target} write/s (継続投入 ${STAGE_SECS}s)"
  echo "#   消化目安: S×200 件/s（S=4→800, S=8→1600, S=16→3200）"
  echo "############################################################"
  local t0; t0="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "STAGE${stage}_T0=$t0" | tee "$LOGS/e9-stage${stage}.meta"

  # 継続投入（rounds を大きくして STAGE_SECS 使い切る）
  node "$HERE/overload.mjs" --procs "$procs" --rounds 100000 --round-items "$ritems" \
    --concurrency "$conc" --item-bytes 1024 --round-gap-ms "$gap" \
    --table "$TABLE" --region "$REGION" > "$LOGS/e9-stage${stage}.driver.log" 2>&1 &
  local driver_pid=$!

  # 観測ループ: 20s 間隔で S を記録
  local shards_log="$LOGS/e9-stage${stage}.shards.log"; : > "$shards_log"
  local start now S
  start=$(date +%s)
  while :; do
    S="$(node "$HERE/count-shards.mjs" --table "$TABLE" --region "$REGION" 2>/dev/null \
      | grep -oE 'OPEN_SHARDS=[0-9]+' | sed -E 's/OPEN_SHARDS=//')"
    now=$(date +%s)
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) S=$S elapsed=$(( now - start ))s" | tee -a "$shards_log"
    if [ $(( now - start )) -ge "$STAGE_SECS" ]; then break; fi
    sleep 20
  done

  local t1; t1="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "STAGE${stage}_T1=$t1" | tee -a "$LOGS/e9-stage${stage}.meta"

  # 投入停止
  kill "$driver_pid" >/dev/null 2>&1 || true
  pkill -P "$driver_pid" >/dev/null 2>&1 || true
  wait "$driver_pid" 2>/dev/null || true

  # 実効レート（driver ログの rate=.../s 平均 × procs）
  local eff
  eff="$(grep -oE 'rate=[0-9]+/s' "$LOGS/e9-stage${stage}.driver.log" \
    | sed -E 's/rate=([0-9]+)\/s/\1/' \
    | awk -v p="$procs" '{sum+=$1;n++} END{ if(n>0) printf "%d",(sum/n)*p; else print 0 }')"

  # S（観測ログ末尾）
  local sval; sval="$(grep -oE 'S=[0-9]+' "$shards_log" | tail -1 | sed -E 's/S=//')"

  echo "[stage $stage] effective≈${eff} w/s  S(終端)=${sval}"

  # メトリクスが出揃うまで少し待つ
  sleep 70

  node "$HERE/metrics.mjs" --function "$FUNC" --region "$REGION" \
    --t0 "$t0" --t1 "$t1" --stage "$stage" --target "$target" \
    --effective "$eff" --shards "$sval" --json | tee -a "$RESULTS"
}

echo "== run-e9.sh START (D=50ms 速い消費者, 緩やか負荷 2k→4k→8k→16k) =="
echo "WARNING: 従量課金が発生します（概算 \$5〜10）。終了後は必ず teardown.sh を実行してください。"

# stage target procs conc ritems gap-ms   （キャリブレーション実測で調整済み）
#   1proc の上限は ~4-5k/s（SDK 単プロセス上限）。8k/16k は procs を増やす。
#   実測: conc12/gap150→~1.9k, conc30/gap40→~4k。multi-proc はほぼ線形。
run_stage 1 2000  1 12 1500 150
run_stage 2 4000  1 30 3000 40
run_stage 3 8000  2 30 3000 40
run_stage 4 16000 4 30 3000 40

echo ""
echo "== run-e9.sh DONE =="
echo "結果 JSON: $RESULTS"
echo "次: docs/poc/shard-autoscale-probe-results.md に E9 セクションとして転記 → teardown.sh で課金停止"
