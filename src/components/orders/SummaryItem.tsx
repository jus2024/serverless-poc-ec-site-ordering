"use client";

/**
 * ラベルと値の 1 組（`dl` の中で使う）。
 *
 * `dt` / `dd` を使うのは、値だけを読み上げても意味が通らないためである
 * （「3.60 秒」が何の時間なのかはラベルとの対応で決まる）。
 * `dl` は呼び出し側が置き、この部品は 1 項目だけを描く。
 */

import styles from "./orders.module.css";

interface SummaryItemProps {
  label: string;
  /** 表示する値。未取得は `EMPTY_VALUE`（—）で埋めて桁を崩さない */
  value: string;
  /** ID や時刻など、桁を揃えて読む値は等幅にする */
  mono?: boolean;
}

export default function SummaryItem({ label, value, mono = false }: SummaryItemProps) {
  return (
    <div className={styles.summaryItem}>
      <dt className={styles.summaryLabel}>{label}</dt>
      <dd className={mono ? `${styles.summaryValue} ${styles.mono}` : styles.summaryValue}>
        {value}
      </dd>
    </div>
  );
}
