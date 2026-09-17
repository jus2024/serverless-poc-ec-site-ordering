"use client";

/**
 * 失敗の案内表示（`order-api-failure.ts` の `FailureNotice` を描く）。
 *
 * 見た目は `src/app/globals.css` の `alert-error` トークンに従う。
 *
 * ## 設定不備を他の失敗と区別する
 *
 * `isConfigError`（ベース URL 未設定。要件 14.10）のときは再試行ボタンを出さない。
 * 再試行しても直らず、`.env.local` の設定と開発サーバの再起動が必要である。
 * 案内文は `api.ts` が組み立てたものをそのまま見せる（手順が本文に含まれる）。
 *
 * `role="alert"` を付けているのは、失敗が非同期に現れるためである。
 * 送信ボタンを押した検証者の focus は移動しないので、この要素が
 * 読み上げられなければ失敗に気づけない。
 */

import type { FailureNotice } from "./order-api-failure";
import styles from "./orders.module.css";

interface FailureAlertProps {
  notice: FailureNotice;
  /** 再試行の操作。渡されても `retryable` が false なら出さない */
  onRetry?: () => void;
}

export default function FailureAlert({ notice, onRetry }: FailureAlertProps) {
  const showRetry = onRetry !== undefined && notice.retryable && !notice.isConfigError;

  return (
    <div className={`alert-error ${styles.alert}`} role="alert">
      <p className={styles.alertTitle}>{notice.title}</p>
      <p className={styles.alertMessage}>{notice.message}</p>
      {notice.hint !== null && <p className={styles.alertHint}>{notice.hint}</p>}
      {notice.reference !== null && (
        <p className={styles.alertReference}>
          <span className={styles.srOnly}>API の応答: </span>
          {notice.reference}
        </p>
      )}
      {showRetry && (
        <div className={styles.inlineActions}>
          <button type="button" className="btn-secondary" onClick={onRetry}>
            再試行する
          </button>
        </div>
      )}
    </div>
  );
}
