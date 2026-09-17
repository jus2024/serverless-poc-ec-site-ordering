"use client";

/**
 * 注文の受付結果と失敗の案内（要件 4.2 / 4.5 / 6.5）。
 *
 * `CartPanel` の `children` に差し込む表示専用の部品である。`useOrderSubmit` が
 * 持つ状態をそのまま描くだけで、判断（送信するか、失敗をどう言い換えるか）は
 * 持たない。カートの下に置くのは、注文ボタンを押した位置から視線を動かさずに
 * 結果を読めるようにするためである。
 *
 * 表示は `OrderSubmitPanel` の受付結果をそのまま引き継ぐ（`FailureAlert`・
 * `SummaryItem`・`data-table` の既存トークン）。文言だけを検証者向けの
 * 「投入した注文」から顧客向けの「ご注文を受け付けました」に変える。
 *
 * ## ステータスが `PENDING` で止まることを画面で断らない
 *
 * 受付は Streams の滞留に影響されず健全に返る（design §2.1.1）。その先が
 * 進むかどうかは `OrderStatusPanel` の段階表示に現れる。ここに「処理中です」
 * 以上の説明を足すと、溢れが起きている状態でも画面が正常に見えるという
 * 本 PoC の観察点をこの部品が先に説明してしまう。受付の事実だけを出す。
 */

import FailureAlert from "./FailureAlert";
import { formatElapsedMs, formatJpy } from "./order-progress";
import styles from "./orders.module.css";
import SummaryItem from "./SummaryItem";
import type { OrderSubmitState } from "./use-order-submit";

interface OrderSubmitOutcomeProps {
  /** `useOrderSubmit` の戻り値 */
  submit: OrderSubmitState;
}

export default function OrderSubmitOutcome({ submit }: OrderSubmitOutcomeProps) {
  const { result, failure, draftIssue, statusMessage } = submit;

  return (
    <>
      {/*
        成功・失敗・送信中を 1 箇所から読み上げる（要件 6.5）。文言の決定は
        `order-submit.ts` の `describeOrderSubmitStatus`（テスト済み）。
      */}
      <p className={styles.statusLine} role="status" aria-live="polite">
        {statusMessage}
      </p>

      {/* 送信前に止めた理由。入力の誤りなので API の失敗とは別の見た目にする */}
      {draftIssue !== null && <p className={styles.fieldError}>{draftIssue}</p>}

      {/* 再試行ボタンは出さない（`onRetry` を渡さない）。カートは残っているので
          同じ注文ボタンをもう一度押せばよく、押す場所を 2 つに増やさない */}
      {failure !== null && <FailureAlert notice={failure} />}

      {result !== null && (
        <div className={styles.subCard}>
          <h3 className={styles.subTitle}>ご注文を受け付けました</h3>
          <dl className={styles.summaryGrid}>
            <SummaryItem label="注文番号" value={result.orderId} mono />
            <SummaryItem label="顧客 ID" value={result.customerId} mono />
            <SummaryItem label="ステータス" value={result.orderStatus} />
            <SummaryItem label="合計金額（税込）" value={formatJpy(result.totalAmount)} />
            <SummaryItem label="受付時刻" value={result.createdAt} mono />
            <SummaryItem
              label="受付 API の処理時間"
              value={formatElapsedMs(result.acceptLatencyMs)}
            />
          </dl>
          <div className={styles.tableWrap}>
            <table className="data-table">
              <caption className={styles.tableCaption}>受け付けた明細</caption>
              <thead>
                <tr>
                  <th scope="col">SKU</th>
                  <th scope="col">数量</th>
                  <th scope="col">単価</th>
                </tr>
              </thead>
              <tbody>
                {result.items.map((item) => (
                  <tr key={item.sku}>
                    <td className={styles.mono}>{item.sku}</td>
                    <td>{item.qty}</td>
                    <td>{formatJpy(item.price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
