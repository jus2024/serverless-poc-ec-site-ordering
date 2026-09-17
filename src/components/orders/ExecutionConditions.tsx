"use client";

/**
 * 実行時の観測条件（`ExecutionConditionsView`。要件 19.3 / 19.5、design §11.2）。
 *
 * ## なぜ実行のたびに条件を出すか
 *
 * 消費能力 `S × P ÷ D`（design §2.1）の変数はすべて実行時の状態で決まる。
 * とくにオープンシャード数 S は CloudWatch メトリクスとして提供されないため
 * （要件 19 の但し書き）、実行レコードに記録された値が唯一の出典である。
 * 負荷生成と並行計測のどちらの結果も、この条件と対にしなければ解釈できない
 * （Property 10）。両パネルで同じ形に出すためにここへ切り出している。
 *
 * ## シャード数の取得失敗を欠測として見せる
 *
 * `openShardCount` が null の実行は、消費能力を算出できない
 * （`estimated_capacity_per_minute` も書かれない。`execution-record.ts`）。
 * 空欄で済ませると「S = 0」とも「取れなかった」とも読めるため、
 * `shardCountError` を警告として本文に出す。
 */

import type { ExecutionConditionsView } from "@/src/lib/orders/types";

import { formatRatePerMinute } from "./execution-run";
import { EMPTY_VALUE, formatCount, formatElapsedMs } from "./order-progress";
import styles from "./orders.module.css";
import SummaryItem from "./SummaryItem";

interface ExecutionConditionsProps {
  conditions: ExecutionConditionsView;
}

export default function ExecutionConditions({ conditions }: ExecutionConditionsProps) {
  const {
    openShardCount,
    shardCountError,
    parallelizationFactor,
    stageDelaysMs,
    estimatedCapacityPerMinute,
    warmThroughputWrite,
  } = conditions;

  return (
    <div className={styles.subCard}>
      <h3 className={styles.subTitle}>実行時の観測条件</h3>
      <p className={styles.fieldHint}>
        消費能力 <code>S × P ÷ D</code> の変数。オープンシャード数は CloudWatch
        では取得できないため、この実行レコードが唯一の出典になる。
      </p>

      <dl className={styles.summaryGrid}>
        <SummaryItem
          label="オープンシャード数 (S)"
          value={openShardCount === null ? EMPTY_VALUE : formatCount(openShardCount)}
        />
        <SummaryItem label="並列化係数 (P)" value={formatCount(parallelizationFactor)} />
        <SummaryItem label="決済の擬似処理時間" value={formatElapsedMs(stageDelaysMs.payment)} />
        <SummaryItem
          label="通知の擬似処理時間"
          value={formatElapsedMs(stageDelaysMs.notification)}
        />
        <SummaryItem
          label="算出した消費能力"
          value={formatRatePerMinute(estimatedCapacityPerMinute)}
        />
        <SummaryItem
          label="warm throughput（書き込み）"
          value={warmThroughputWrite === null ? "既定" : formatCount(warmThroughputWrite)}
        />
      </dl>

      {shardCountError !== null && (
        <p className={styles.warningNote} role="note">
          シャード数を取得できませんでした（{shardCountError}
          ）。この実行は消費能力を算出できないため、壁の位置の検証には使えません。
        </p>
      )}
    </div>
  );
}
