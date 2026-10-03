#!/usr/bin/env bash
# run-e8.sh — E8: 滞留ゼロリセット方式で「S が増えれば同時実行も S×P に伸びるか」を測る（★従量課金）。
#
# 背景: E7 §7.4 は前段の滞留を抱えたまま次段を積んだため、消費が古い4シャードのバックログに
#   張り付き同時実行が ~40 で律速された（測定アーティファクト）。E8 は各段で滞留をゼロに
#   リセットしてから短時間バーストを1発入れ、その消化中の同時実行ピークを period=1s で測る。
#
# 段構成: 4k → 8k → 16k write/s（確実に分割が起きる帯。2k は E7 で S が動かなかったので飛ばす）。
#   期待する分割後 S: 8 → 16 → 32（倍々）。P=10 固定なので S×P = 80 → 160 → 320。
#
# 各段 3 フェーズ:
#   P1 S を上げる  : 目標ピークの短時間バーストを投入してシャード分割。count-shards で S 安定を確認。
#   P2 滞留を消す  : 投入を止め、drain-wait.mjs で IteratorAge が低位(<=floor)に戻るまで待つ。
#   P3 同時実行測定: 全シャードに行き渡る短時間バースト(= S×P×K 件)を1発入れ、
#                    conc-sample.mjs(period=1s)で ConcurrentExecutions ピークを採取。
#
# 判定: 段ごとに同時実行ピークが 80→160→320 と伸びれば「滞留を消せば枠は使われる」が実証。
#   伸びずまた ~40 で頭打ちなら別の律速（アカウント同時実行配分など）を切り分ける。
#
# 使い方: bash tmp/shard-autoscale-probe/run-e8.sh
#   結果: logs/e8-results.jsonl（段ごと1行JSON） と各フェーズのログ。

set -uo pipefail
# node / npm / aws CLI が PATH 上にあること（Node.js 20+ 推奨）。

REGION="${REGION:-us-west-2}"
TABLE="shard-autoscale-probe"
FUNC="shard-autoscale-probe-consumer"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS="$HERE/logs"
mkdir -p "$LOGS"
RESULTS="$LOGS/e8-results.jsonl"
: > "$RESULTS"

P=10              # ParallelizationFactor（ESM 固定）
DRAIN_FLOOR_MS=2000   # 滞留消化の低位しきい値
DRAIN_CAP_MIN=20      # 滞留消化待ちの上限（分）
CONC_BURST_K=5        # P3 バースト件数 = S×P×K
CONC_BURST_CONC=60    # P3 バースト投入の並列度（短時間で入れ切る）

# S を観測してログに出し、現在値を返す（stdout 最終行が S）。
read_shards() {
  local stage="$1"
  local log="$LOGS/e8-stage${stage}.shards.log"
  local out; out="$(node "$HERE/count-shards.mjs" --table "$TABLE" --region "$REGION" 2>/dev/null)"
  local S warm total nowiso
  S="$(echo "$out" | grep -oE 'OPEN_SHARDS=[0-9]+' | sed -E 's/OPEN_SHARDS=//')"
  warm="$(echo "$out" | grep -oE 'warm=[0-9]+w' | head -1)"
  total="$(echo "$out" | grep -oE 'TOTAL_SHARDS=[0-9]+' | sed -E 's/TOTAL_SHARDS=//')"
  nowiso="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$nowiso S=$S $warm TOTAL=$total" >> "$log"
  echo "$S"
}

# P1 の成長ゲート（修正版）:
#   投入を継続しながら S が target_S 以上になるまで待つ。到達したら「もう少し押し続けて」
#   ピークを latch させてから停止する。到達しなくても inject_cap_sec で投入を打ち切る。
#   その後、投入停止のまま settle_cap_sec まで遅延分割（E7 §7.8）を待って最終 S を確定する。
#   注意: 90s plateau で早期停止しない（旧版の誤り）。S は単調増なので下がらない。
# 引数: stage target_S driver_pid inject_cap_sec hold_after_reach_sec settle_cap_sec
grow_and_settle() {
  local stage="$1" target_S="$2" driver_pid="$3" inject_cap="$4" hold="$5" settle_cap="$6"
  local log="$LOGS/e8-stage${stage}.shards.log"; : > "$log"
  local start now S reached=0
  start=$(date +%s)
  # --- 投入継続中: target_S 到達を待つ ---
  while :; do
    S="$(read_shards "$stage")"
    now=$(date +%s)
    echo "[stage $stage][grow] S=$S (target_S=$target_S) elapsed=$(( now - start ))s" | tee -a "$log"
    if [ -n "$S" ] && [ "$S" -ge "$target_S" ] 2>/dev/null; then
      reached=1
      echo "[stage $stage][grow] REACHED S=$S; hold injection ${hold}s to latch peak" | tee -a "$log"
      break
    fi
    if [ $(( now - start )) -ge "$inject_cap" ]; then
      echo "[stage $stage][grow] inject cap ${inject_cap}s hit at S=$S (target未達); stop injecting" | tee -a "$log"
      break
    fi
    sleep 20
  done
  # 到達した場合はピーク latch のため少し押し続ける
  if [ "$reached" = "1" ] && [ "$hold" -gt 0 ]; then sleep "$hold"; fi

  # --- 投入停止 ---
  kill "$driver_pid" >/dev/null 2>&1 || true
  pkill -P "$driver_pid" >/dev/null 2>&1 || true
  wait "$driver_pid" 2>/dev/null || true
  echo "[stage $stage][grow] injection stopped; waiting delayed splits up to ${settle_cap}s" | tee -a "$log"

  # --- 投入停止後: 遅延分割を待つ（S が settle_quiet 秒変化しなくなるか settle_cap で確定）---
  local settle_start last_S="" last_change settle_quiet=120
  settle_start=$(date +%s); last_change=$settle_start
  while :; do
    S="$(read_shards "$stage")"
    now=$(date +%s)
    echo "[stage $stage][settle] S=$S elapsed=$(( now - settle_start ))s" | tee -a "$log"
    [ "$S" != "$last_S" ] && { last_S="$S"; last_change=$now; }
    if [ $(( now - last_change )) -ge "$settle_quiet" ]; then
      echo "SHARDS stage=$stage verdict=SETTLED S=$S (quiet ${settle_quiet}s)" | tee -a "$log"; break
    fi
    if [ $(( now - settle_start )) -ge "$settle_cap" ]; then
      echo "SHARDS stage=$stage verdict=SETTLE_CAP S=$S" | tee -a "$log"; break
    fi
    sleep 20
  done
  echo "$S"
}

run_stage() {
  local stage="$1" target="$2" procs="$3" conc="$4" rounds="$5" ritems="$6" target_S="$7"
  echo ""
  echo "############################################################"
  echo "# E8 STAGE $stage: target=${target} w/s  期待分割後 S≈${target_S} (S×P=$(( target_S * P )))"
  echo "############################################################"

  # ---- P1: S を上げる（投入継続で target_S まで育て、遅延分割を待って確定）----
  echo "== [stage $stage][P1] grow S: inject procs=$procs conc=$conc rounds=$rounds ritems=$ritems until S>=$target_S =="
  node "$HERE/overload.mjs" --procs "$procs" --rounds "$rounds" --round-items "$ritems" \
    --concurrency "$conc" --item-bytes 1024 --round-gap-ms 0 \
    --table "$TABLE" --region "$REGION" > "$LOGS/e8-stage${stage}.p1.driver.log" 2>&1 &
  local driver_pid=$!
  # grow: 投入上限 540s / 到達後 60s hold / 停止後 settle 上限 300s
  local S; S="$(grow_and_settle "$stage" "$target_S" "$driver_pid" 540 60 300 | tail -1)"
  echo "== [stage $stage][P1] done. final S=$S =="

  # ---- P2: 滞留を消す（投入停止のまま IteratorAge 低位まで待つ）----
  echo "== [stage $stage][P2] drain backlog until IteratorAge <= ${DRAIN_FLOOR_MS}ms (cap ${DRAIN_CAP_MIN}min) =="
  node "$HERE/drain-wait.mjs" --function "$FUNC" --region "$REGION" \
    --floor-ms "$DRAIN_FLOOR_MS" --cap-min "$DRAIN_CAP_MIN" --interval-sec 30 \
    2>&1 | tee "$LOGS/e8-stage${stage}.p2.drain.log"
  local drain_verdict; drain_verdict="$(grep -oE 'verdict=[A-Z]+' "$LOGS/e8-stage${stage}.p2.drain.log" | tail -1 | sed 's/verdict=//')"
  echo "== [stage $stage][P2] drain verdict=$drain_verdict =="

  # ---- P3: 同時実行測定（全シャードに行き渡る1発バースト → period=1s 採取）----
  local burst_items=$(( S * P * CONC_BURST_K ))
  echo "== [stage $stage][P3] concurrency burst: items=$burst_items (=S($S)*P($P)*K($CONC_BURST_K)) conc=$CONC_BURST_CONC =="
  local p3_t0; p3_t0="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  # 1 プロセス・1 ラウンドで burst_items を一気に投入（短時間で入れ切る）
  node "$HERE/e2-burst.mjs" --table "$TABLE" --region "$REGION" \
    --rounds 1 --round-items "$burst_items" --concurrency "$CONC_BURST_CONC" \
    --item-bytes 1024 --round-gap-ms 0 > "$LOGS/e8-stage${stage}.p3.burst.log" 2>&1
  echo "   burst injected; consuming (D=3s). sampling window stays open ~120s"
  # バースト消化中、同時実行ピークが CloudWatch に出揃うまで待つ（高解像度メトリクスは
  # 発行に 1〜3 分遅延しうるため、消化+余裕で 180s 確保）
  sleep 180
  local p3_t1; p3_t1="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  echo "== [stage $stage][P3] sample ConcurrentExecutions (period=1s) [$p3_t0 .. $p3_t1] =="
  node "$HERE/conc-sample.mjs" --function "$FUNC" --region "$REGION" \
    --t0 "$p3_t0" --t1 "$p3_t1" | tee "$LOGS/e8-stage${stage}.p3.conc.log"
  local conc_json
  conc_json="$(node "$HERE/conc-sample.mjs" --function "$FUNC" --region "$REGION" \
    --t0 "$p3_t0" --t1 "$p3_t1" --json)"

  # 実効レート(P1)
  local eff
  eff="$(grep -oE 'rate=[0-9]+/s' "$LOGS/e8-stage${stage}.p1.driver.log" \
    | sed -E 's/rate=([0-9]+)\/s/\1/' \
    | awk -v p="$procs" '{sum+=$1;n++} END{ if(n>0) printf "%d",(sum/n)*p; else print 0 }')"

  # 段の結果 JSON を1行追記
  node -e '
    const s=process.argv;
    const g=(k)=>{const i=s.indexOf("--"+k);return i>=0?s[i+1]:null;};
    const conc=JSON.parse(g("conc"));
    const row={stage:+g("stage"),targetRate:+g("target"),effectiveRate:+g("eff"),
      openShards:+g("S"),P:+g("P"),expectedConc:(+g("S"))*(+g("P")),
      concPeak:conc.concPeak,concPeakAt:conc.concPeakAt,
      drainIterAgeMaxMs:conc.iteratorAgeMaxMs,drainIterAgeAvgMs:conc.iteratorAgeAvgMs,
      drainVerdict:g("drain"),burstItems:+g("burst"),
      p3Window:[g("t0"),g("t1")]};
    console.log(JSON.stringify(row));
  ' --stage "$stage" --target "$target" --eff "$eff" --S "$S" --P "$P" \
    --drain "$drain_verdict" --burst "$burst_items" --t0 "$p3_t0" --t1 "$p3_t1" \
    --conc "$conc_json" | tee -a "$RESULTS"

  echo "== [stage $stage] DONE: S=$S expectedConc=$(( S * P )) =="
}

echo "== run-e8.sh START (3 段 4k→8k→16k, 滞留ゼロリセット方式) =="
echo "WARNING: 従量課金が発生します（概算 \$5〜10）。終了後は必ず teardown.sh を実行してください。"

# stage target procs conc rounds ritems target_S
# E7 実測: 4→8 は実効 ~4.8k、8→16 は ~8.4k、16→32 は ~16.9k で誘発。
# 境界を確実に跨ぐため各段とも名目をやや上回る実効を出す。
# rounds×ritems は投入上限 540s を使い切れる十分な量にする（到達後は hold して停止）。
#   5k 段: S →8 を狙う（4k 境界を明確に超える）。1 proc ~4.5-5k w/s。
run_stage 1 5000  1 40 400 50000  8
#   9k 段: S →16 を狙う。2 proc ~9k w/s。
run_stage 2 9000  2 36 400 50000  16
#   18k 段: S →32 を狙う。4 proc ~17-18k w/s。
run_stage 3 18000 4 30 400 50000  32

echo ""
echo "== run-e8.sh DONE =="
echo "結果 JSON: $RESULTS"
echo "次: docs/poc/shard-autoscale-probe-results.md に E8 セクションとして転記 → teardown.sh で課金停止"
