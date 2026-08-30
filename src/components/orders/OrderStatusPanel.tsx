"use client";

/**
 * 注文の照会と段階ごとの進捗・経過時間の表示（要件 14.4 / 2.5 / 2.6）。
 *
 * ## 何を出すか
 *
 * `GET /orders/{orderId}` の応答から、
 *
 * - 注文ステータスと完了段階数（`stagesDone` / 4）
 * - 段階ごとの状態・完了時刻・受付からの経過時間（`stages`）
 * - 直前の段階からの所要時間（`order-progress.ts` で算出）
 * - 全段階完了までの経過時間（`endToEndMs`）
 *
 * を表示する。段階の並べ方と時間の書式は `order-progress.ts` に閉じてあり、
 * このコンポーネントは取得と描画だけを持つ。
 *
 * ## 自動更新を終端で止める
 *
 * 後続処理は Streams 経由で非同期に進むため、投入直後は `PENDING` しか返らない。
 * 段階が埋まる様子を見るために一定間隔で再取得するが、
 * 終端ステータス（`COMPLETED` / `*_FAILED`。design §E-2）に達したら止める。
 * 止めないと、もう変化しない注文を延々と照会し続け、
 * 並行計測（要件 12）の測定対象に自分の照会が混ざる。
 *
 * 失敗したときも止める。404 の注文を秒間隔で叩き続けても結果は変わらない。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { getOrder } from "@/src/lib/orders/api";
import type { OrderStatusResponse } from "@/src/lib/orders/types";

import FailureAlert from "./FailureAlert";
import { describeOrderApiFailure, type FailureNotice } from "./order-api-failure";
import { parseOrderIdInput } from "./order-form";
import {
  EMPTY_VALUE,
  ORDER_STAGE_LABELS,
  ORDER_STATUS_LABELS,
  STAGE_STATUS_LABELS,
  deriveStageProgress,
  formatElapsedMs,
  formatJpy,
  formatTimestamp,
  isTerminalOrderStatus,
  orderStatusBadgeClass,
} from "./order-progress";
import styles from "./orders.module.css";
import SummaryItem from "./SummaryItem";

/** 自動更新の間隔。段階の擬似待機（既定 3.6 秒。design §10.1）より短くする */
const POLL_INTERVAL_MS = 2_000;

interface OrderStatusPanelProps {
  /**
   * 投入直後の注文 ID（`OrderSubmitPanel` から親経由で渡る）。
   * 変化したら入力欄に反映し、そのまま照会する。
   */
  trackedOrderId?: string | null;
}

export default function OrderStatusPanel({ trackedOrderId = null }: OrderStatusPanelProps) {
  const [orderIdInput, setOrderIdInput] = useState("");
  const [orderIdIssue, setOrderIdIssue] = useState<string | null>(null);
  /** 照会中の注文 ID。自動更新の対象 */
  const [queriedOrderId, setQueriedOrderId] = useState<string | null>(null);
  const [order, setOrder] = useState<OrderStatusResponse | null>(null);
  const [failure, setFailure] = useState<FailureNotice | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const abortRef = useRef<AbortController | null>(null);

  /**
   * 注文を取得する。
   *
   * @param silent 自動更新による取得。表示中のデータを消さずに差し替える
   */
  const lookup = useCallback(async (orderId: string, silent = false) => {
    // 直前の取得を打ち切る。古い応答が新しい応答を上書きしないようにする
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
      setOrder(null);
      setFailure(null);
    }

    try {
      const response = await getOrder(orderId, { signal: controller.signal });
      if (controller.signal.aborted) {
        return;
      }
      setOrder(response);
      setFailure(null);
      setFetchedAt(new Date().toISOString());
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      setFailure(describeOrderApiFailure(error, "getOrder"));
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  // 投入直後の注文をそのまま照会する。同じ ID で二重に走らせない
  const handledTrackedIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (trackedOrderId === null || trackedOrderId === handledTrackedIdRef.current) {
      return;
    }
    handledTrackedIdRef.current = trackedOrderId;
    setOrderIdInput(trackedOrderId);
    setOrderIdIssue(null);
    setQueriedOrderId(trackedOrderId);
    void lookup(trackedOrderId);
  }, [trackedOrderId, lookup]);

  // 自動更新。終端ステータスと失敗では止める（上のコメントの理由）
  const isTerminal = order !== null && isTerminalOrderStatus(order.orderStatus);
  const polling = autoRefresh && queriedOrderId !== null && failure === null && !isTerminal;

  useEffect(() => {
    if (!polling || queriedOrderId === null) {
      return;
    }
    const timer = setInterval(() => {
      void lookup(queriedOrderId, true);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [polling, queriedOrderId, lookup]);

  // 画面を離れるときに進行中の取得を止める
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseOrderIdInput(orderIdInput);
    setOrderIdIssue(parsed.ok ? null : parsed.issue);
    if (!parsed.ok) {
      return;
    }
    setQueriedOrderId(parsed.value);
    void lookup(parsed.value);
  }

  const progress = order === null ? null : deriveStageProgress(order);

  return (
    <section className="card" aria-labelledby="order-status-heading">
      <h2 id="order-status-heading" className={styles.sectionTitle}>
        注文の照会
      </h2>
      <p className={styles.sectionDescription}>
        <code>GET /orders/{"{orderId}"}</code> で注文ステータスと段階ごとの進捗・経過時間を表示する。
        後続処理は非同期に進むため、投入直後は未完了の段階が並ぶ。
      </p>

      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="order-status-id">
            注文 ID
          </label>
          <input
            id="order-status-id"
            className={`input ${styles.textInput}`}
            type="text"
            value={orderIdInput}
            onChange={(event) => setOrderIdInput(event.target.value)}
            placeholder="ORD#01J..."
            aria-describedby={
              orderIdIssue === null ? "order-status-id-hint" : "order-status-id-hint order-status-id-error"
            }
            aria-invalid={orderIdIssue !== null}
          />
          <p id="order-status-id-hint" className={styles.fieldHint}>
            注文を投入すると、その注文 ID がここに入る。
          </p>
          {orderIdIssue !== null && (
            <p id="order-status-id-error" className={styles.fieldError}>
              {orderIdIssue}
            </p>
          )}
        </div>

        <div className={styles.checkboxField}>
          <input
            id="order-status-auto-refresh"
            type="checkbox"
            checked={autoRefresh}
            onChange={(event) => setAutoRefresh(event.target.checked)}
          />
          <label htmlFor="order-status-auto-refresh">
            自動更新する（{POLL_INTERVAL_MS / 1_000} 秒間隔。全段階完了または失敗で停止）
          </label>
        </div>

        <div className={styles.actions}>
          <button type="submit" className="btn-primary" disabled={loading}>
            {loading ? "照会中…" : "照会する"}
          </button>
          {queriedOrderId !== null && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void lookup(queriedOrderId, true)}
              disabled={loading || refreshing}
            >
              今すぐ再取得
            </button>
          )}
        </div>
      </form>

      {/* 進捗は自動更新で変わるため、読み上げは要約 1 行に絞る（表全体を読ませない） */}
      <p className={styles.statusLine} role="status" aria-live="polite">
        {loading
          ? "注文を照会しています…"
          : failure !== null
            ? `注文の照会に失敗しました: ${failure.title}`
            : order !== null && progress !== null
              ? `${ORDER_STATUS_LABELS[order.orderStatus]} / ${progress.stagesDone} 段階完了（全 ${progress.totalStages} 段階）${
                  polling ? "。自動更新中" : "。自動更新は停止中"
                }`
              : ""}
      </p>

      {failure !== null && (
        <FailureAlert
          notice={failure}
          onRetry={
            queriedOrderId === null ? undefined : () => void lookup(queriedOrderId)
          }
        />
      )}

      {order !== null && progress !== null && (
        <div className={styles.result}>
          <dl className={styles.summaryGrid}>
            <div className={styles.summaryItem}>
              <dt className={styles.summaryLabel}>ステータス</dt>
              <dd className={styles.summaryValue}>
                <span className={orderStatusBadgeClass(order.orderStatus)}>
                  {ORDER_STATUS_LABELS[order.orderStatus]}
                </span>
              </dd>
            </div>
            <SummaryItem label="注文 ID" value={order.orderId} mono />
            <SummaryItem label="顧客 ID" value={order.customerId} mono />
            <SummaryItem label="合計金額" value={formatJpy(order.totalAmount)} />
            <SummaryItem label="付与ポイント" value={formatJpy(order.pointEarned)} />
            <SummaryItem
              label="全段階完了までの経過"
              value={formatElapsedMs(progress.endToEndMs)}
            />
            <SummaryItem label="受付時刻" value={formatTimestamp(order.createdAt)} mono />
            <SummaryItem label="最終更新" value={formatTimestamp(order.updatedAt)} mono />
            <SummaryItem
              label="パイプライン構成"
              value={order.pipelineMode ?? EMPTY_VALUE}
            />
            <SummaryItem label="失敗理由" value={order.failureReason ?? EMPTY_VALUE} />
          </dl>

          <div className={styles.progressBlock}>
            <p className={styles.progressLabel} id="order-stage-progress-label">
              段階の進捗: {progress.stagesDone} / {progress.totalStages}
            </p>
            <div
              className={styles.progressTrack}
              role="progressbar"
              aria-labelledby="order-stage-progress-label"
              aria-valuemin={0}
              aria-valuemax={progress.totalStages}
              aria-valuenow={progress.stagesDone}
              aria-valuetext={`${progress.stagesDone} / ${progress.totalStages} 段階完了`}
            >
              <div
                className={progress.failedStage === null ? styles.progressBar : styles.progressBarFailed}
                style={{ width: `${progress.progressPercent}%` }}
              />
            </div>
          </div>

          <div className={styles.tableWrap}>
            <table className="data-table">
              <caption className={styles.tableCaption}>
                段階ごとの進捗と経過時間（受付からの経過 / 直前の段階からの所要）
              </caption>
              <thead>
                <tr>
                  <th scope="col">段階</th>
                  <th scope="col">状態</th>
                  <th scope="col">完了時刻</th>
                  <th scope="col">受付からの経過</th>
                  <th scope="col">この段階の所要</th>
                </tr>
              </thead>
              <tbody>
                {progress.rows.map((row) => (
                  <tr key={row.stage}>
                    <th scope="row">{ORDER_STAGE_LABELS[row.stage]}</th>
                    <td className={stageStatusClass(row.status)}>
                      {STAGE_STATUS_LABELS[row.status]}
                    </td>
                    <td className={styles.mono}>{formatTimestamp(row.completedAt)}</td>
                    <td>{formatElapsedMs(row.elapsedMs)}</td>
                    <td>{formatElapsedMs(row.stageDurationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={styles.tableWrap}>
            <table className="data-table">
              <caption className={styles.tableCaption}>注文の明細</caption>
              <thead>
                <tr>
                  <th scope="col">SKU</th>
                  <th scope="col">数量</th>
                  <th scope="col">単価</th>
                  <th scope="col">小計</th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((item) => (
                  <tr key={item.sku}>
                    <th scope="row" className={styles.mono}>
                      {item.sku}
                    </th>
                    <td>{item.qty}</td>
                    <td>{formatJpy(item.price)}</td>
                    <td>{formatJpy(item.qty * item.price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className={styles.fieldHint}>
            最終取得: {formatTimestamp(fetchedAt)}
            {refreshing ? "（更新中）" : ""}
          </p>
        </div>
      )}
    </section>
  );
}

/** 段階の状態に応じた文字色（`globals.css` のセマンティックトークン） */
function stageStatusClass(status: keyof typeof STAGE_STATUS_LABELS): string {
  if (status === "DONE") {
    return styles.stageDone;
  }
  if (status === "FAILED") {
    return styles.stageFailed;
  }
  return styles.stageWaiting;
}
