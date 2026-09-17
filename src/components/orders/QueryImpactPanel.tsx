"use client";

/**
 * 並行計測の開始と結果の表示（要件 14.5 / 12.1〜12.5 / 12.7）。
 *
 * ## 何を測るための画面か
 *
 * 後続処理が高負荷なときに**注文照会 API のレイテンシとエラー率が
 * 悪化するかどうか**を測る（要件 12.1）。軸 A では波及が発生しない見込みで、
 * 「発生しない」という結果もそのまま成果になる（要件 12.6）。
 * したがって p50 だけでなく p95 / p99 / 最大まで出す。平均値では
 * 裾の悪化が見えない（要件 12.3）。
 *
 * ## スロットルを他のエラーと区別して見せる
 *
 * 429 / `TooManyRequestsException` は他のエラーと分けて集計される（要件 12.2）。
 * 画面でも件数と率を別々に出す。合算すると、429 が 1 件も出ていない実行と
 * 429 だけで埋まった実行が同じ「エラー率」として並んでしまう。
 *
 * ## 負荷生成との関連付け
 *
 * 並行計測の結果は「どの投入レートの最中に測ったのか」と対でなければ
 * 意味を持たない。`loadTestId` を渡すと実行レコードに記録され（要件 12.5）、
 * 後から突き合わせられる。負荷生成パネルで追跡中の実行 ID を
 * 親経由で受け取り、既定値として入れておく。
 *
 * ## 計測はローカルからではなく Lambda から行う
 *
 * 計測の実体は `query-impact-measure` Lambda であり、この画面は
 * 開始要求と結果表示だけを担う（要件 12.4。検証者の回線品質を
 * 測定結果に混ぜないため）。
 *
 * ## 現在の制約
 *
 * PoC API の全ルートに Cognito 認証を掛けた（方式A）ため、
 * `query-impact-measure` Lambda が内部から `GET /orders` を呼ぶ経路が
 * 401 になり、measure は一時的に使用できない。実行しても「完了」と
 * 表示されるが、エラー率は 100%（成功 0 件）になり計測結果にはならない。
 * この既知の制約を見た人が本物のバグを疑わないよう、パネル冒頭に常時の
 * 注記を出している。復旧には Lambda 側での M2M トークン取得（方式B）が要る。
 * 復旧後はこの注記を外すだけで戻る（開始ボタンは disabled にしていない）。
 */

import { useEffect, useRef, useState } from "react";

import { startQueryImpact } from "@/src/lib/orders/api";
import { isQueryImpactStatus, type StartQueryImpactRequest } from "@/src/lib/orders/types";

import ExecutionConditions from "./ExecutionConditions";
import FailureAlert from "./FailureAlert";
import {
  deriveQueryImpactProgress,
  executionStatusBadgeClass,
  formatPercent,
  formatRatePerSecond,
  formatSeconds,
  parseConcurrencyInput,
  parseDurationSecondsInput,
  parseExecutionIdInput,
  parseOptionalIdInput,
} from "./execution-run";
import { describeOrderApiFailure, type FailureNotice } from "./order-api-failure";
import { EMPTY_VALUE, formatCount, formatElapsedMs, formatTimestamp } from "./order-progress";
import styles from "./orders.module.css";
import SummaryItem from "./SummaryItem";
import { useVerificationConfig } from "./use-verification-config";
import { EXECUTION_POLL_INTERVAL_MS, useExecutionPolling } from "./use-execution-polling";

/** 計測対象の種別（`measure-request.ts` の `QueryTarget` に対応） */
type TargetKind = "ORDER_LIST" | "ORDER_DETAIL";

interface QueryImpactPanelProps {
  /**
   * 並行して走らせている負荷生成の実行 ID（要件 12.5）。
   * 負荷生成パネルが追跡している実行 ID が親経由で渡る。
   */
  loadTestId?: string | null;
}

export default function QueryImpactPanel({ loadTestId = null }: QueryImpactPanelProps) {
  const { state: configState, config, failure: configFailure, reload } = useVerificationConfig();
  const tracking = useExecutionPolling("QUERY_IMPACT", isQueryImpactStatus);

  // ── 開始パラメータ
  const [concurrencyInput, setConcurrencyInput] = useState("");
  const [concurrencyIssue, setConcurrencyIssue] = useState<string | null>(null);
  const [durationSecondsInput, setDurationSecondsInput] = useState("");
  const [durationSecondsIssue, setDurationSecondsIssue] = useState<string | null>(null);
  const [targetKind, setTargetKind] = useState<TargetKind>("ORDER_LIST");
  const [customerIdInput, setCustomerIdInput] = useState("");
  const [orderIdInput, setOrderIdInput] = useState("");
  const [targetIssue, setTargetIssue] = useState<string | null>(null);
  const [loadTestIdInput, setLoadTestIdInput] = useState("");
  const [loadTestIdIssue, setLoadTestIdIssue] = useState<string | null>(null);

  const [starting, setStarting] = useState(false);
  const [startFailure, setStartFailure] = useState<FailureNotice | null>(null);

  // ── 既存の実行を追跡する
  const [trackIdInput, setTrackIdInput] = useState("");
  const [trackIdIssue, setTrackIdIssue] = useState<string | null>(null);

  const limits = config === null ? null : config.limits;

  // 負荷生成側で新しい実行を追跡し始めたら、その実行 ID を既定値として入れる。
  // 同じ ID で入力を上書きし続けない（検証者が消した値を戻さない）
  const appliedLoadTestIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (loadTestId === null || loadTestId === appliedLoadTestIdRef.current) {
      return;
    }
    appliedLoadTestIdRef.current = loadTestId;
    setLoadTestIdInput(loadTestId);
    setLoadTestIdIssue(null);
  }, [loadTestId]);

  async function handleStart(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (starting) {
      return;
    }

    const concurrency = parseConcurrencyInput(
      concurrencyInput,
      limits?.maxMeasureConcurrency ?? null
    );
    const durationSeconds = parseDurationSecondsInput(
      durationSecondsInput,
      limits?.maxDurationSeconds ?? null
    );
    setConcurrencyIssue(concurrency.ok ? null : concurrency.issue);
    setDurationSecondsIssue(durationSeconds.ok ? null : durationSeconds.issue);

    // 対象は片方だけを送る（両方指定は API 側で 400。`measure-request.ts`）
    const rawTargetId = targetKind === "ORDER_DETAIL" ? orderIdInput : customerIdInput;
    const targetLabel = targetKind === "ORDER_DETAIL" ? "注文 ID" : "顧客 ID";
    const targetId = parseOptionalIdInput(rawTargetId, targetLabel);
    setTargetIssue(targetId.ok ? null : targetId.issue);

    const parsedLoadTestId = parseOptionalIdInput(loadTestIdInput, "負荷テスト実行 ID");
    setLoadTestIdIssue(parsedLoadTestId.ok ? null : parsedLoadTestId.issue);

    if (!concurrency.ok || !durationSeconds.ok || !targetId.ok || !parsedLoadTestId.ok) {
      return;
    }
    if (targetKind === "ORDER_DETAIL" && targetId.value === undefined) {
      setTargetIssue("注文 1 件を対象にする場合は注文 ID を入力してください。");
      return;
    }

    const request: StartQueryImpactRequest = {
      concurrency: concurrency.value,
      durationSeconds: durationSeconds.value,
    };
    if (targetId.value !== undefined) {
      if (targetKind === "ORDER_DETAIL") {
        request.orderId = targetId.value;
      } else {
        request.customerId = targetId.value;
      }
    }
    if (parsedLoadTestId.value !== undefined) {
      request.loadTestId = parsedLoadTestId.value;
    }

    setStarting(true);
    setStartFailure(null);
    try {
      const response = await startQueryImpact(request);
      tracking.track(response.executionId);
    } catch (error) {
      setStartFailure(describeOrderApiFailure(error, "startQueryImpact"));
    } finally {
      setStarting(false);
    }
  }

  function handleTrack(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseExecutionIdInput(trackIdInput);
    setTrackIdIssue(parsed.ok ? null : parsed.issue);
    if (!parsed.ok) {
      return;
    }
    setStartFailure(null);
    tracking.track(parsed.value);
  }

  const execution = tracking.execution;
  const progress = execution === null ? null : deriveQueryImpactProgress(execution);
  const percentiles = execution === null ? null : execution.latencyPercentiles;

  const canStart = starting ? false : configState === "ready";

  return (
    <section className="card" aria-labelledby="query-impact-heading">
      <h2 id="query-impact-heading" className={styles.sectionTitle}>
        並行計測（同期パスへの波及）
      </h2>
      <p className={styles.sectionDescription}>
        <code>POST /measure/start</code> で注文照会 API に連続してリクエストを送り、
        レイテンシ分布とエラー率を計測する。計測は Lambda 上で実行されるため、
        検証者の回線品質は結果に影響しない。結果は
        <code>GET /executions/{"{executionId}"}</code> を{" "}
        {EXECUTION_POLL_INTERVAL_MS / 1_000} 秒間隔で取得して表示する。
      </p>

      <div className={styles.costPreview}>
        <p className={styles.costPreviewTitle}>
          この機能は現在使用できません（API 認証の追加による既知の制約）。
        </p>
        <p>
          PoC API の全ルートに Cognito 認証を掛けたため、
          <code>query-impact-measure</code> Lambda が内部で{" "}
          <code>GET /orders</code> を呼ぶ経路が 401 になります。実行しても「完了」と
          表示されますが、エラー率は 100%（成功 0 件・その他のエラーが全件）になり、
          これは計測結果ではありません。復旧には Lambda 側での M2M トークン取得
          （方式 B）が必要です。
        </p>
      </div>

      <p className={styles.statusLine} role="status" aria-live="polite">
        {configState === "loading"
          ? "検証パラメータ（上限）を読み込んでいます…"
          : configState === "ready" && limits !== null
            ? `上限: ${formatCount(limits.maxMeasureConcurrency)} 並行 / ${formatCount(
                limits.maxDurationSeconds
              )} 秒（デプロイ済みの設定）`
            : "検証パラメータを取得できないため、並行計測を開始できません。"}
      </p>

      {configFailure !== null && <FailureAlert notice={configFailure} onRetry={reload} />}

      <form className={styles.form} onSubmit={handleStart} noValidate>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="measure-concurrency">
            並行数
          </label>
          <input
            id="measure-concurrency"
            className={`input ${styles.numberInput}`}
            type="text"
            inputMode="numeric"
            value={concurrencyInput}
            onChange={(event) => setConcurrencyInput(event.target.value)}
            aria-describedby={
              concurrencyIssue === null
                ? "measure-concurrency-hint"
                : "measure-concurrency-hint measure-concurrency-error"
            }
            aria-invalid={concurrencyIssue !== null}
          />
          <p id="measure-concurrency-hint" className={styles.fieldHint}>
            {limits === null
              ? "上限はデプロイ済みの設定（GET /config）から取得する。"
              : `1〜${formatCount(limits.maxMeasureConcurrency)} 並行。同期パス側の需要を動かす変数。`}
          </p>
          {concurrencyIssue !== null && (
            <p id="measure-concurrency-error" className={styles.fieldError}>
              {concurrencyIssue}
            </p>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="measure-duration">
            継続時間（秒）
          </label>
          <input
            id="measure-duration"
            className={`input ${styles.numberInput}`}
            type="text"
            inputMode="numeric"
            value={durationSecondsInput}
            onChange={(event) => setDurationSecondsInput(event.target.value)}
            aria-describedby={
              durationSecondsIssue === null
                ? "measure-duration-hint"
                : "measure-duration-hint measure-duration-error"
            }
            aria-invalid={durationSecondsIssue !== null}
          />
          <p id="measure-duration-hint" className={styles.fieldHint}>
            {limits === null
              ? "上限はデプロイ済みの設定（GET /config）から取得する。"
              : `1〜${formatCount(limits.maxDurationSeconds)} 秒。`}
            {" "}
            並行計測は分位点を全件から算出するため 1 回の実行で測り切る。
            計測 Lambda の実行時間に収まらない長さは API 側が範囲外として拒否する。
          </p>
          {durationSecondsIssue !== null && (
            <p id="measure-duration-error" className={styles.fieldError}>
              {durationSecondsIssue}
            </p>
          )}
        </div>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>計測対象</legend>

          <div className={styles.checkboxField}>
            <input
              id="measure-target-list"
              type="radio"
              name="measure-target-kind"
              value="ORDER_LIST"
              checked={targetKind === "ORDER_LIST"}
              onChange={() => {
                setTargetKind("ORDER_LIST");
                setTargetIssue(null);
              }}
            />
            <label htmlFor="measure-target-list">
              顧客別の注文一覧（<code>GET /orders?customerId=</code>）
            </label>
          </div>

          <div className={styles.checkboxField}>
            <input
              id="measure-target-detail"
              type="radio"
              name="measure-target-kind"
              value="ORDER_DETAIL"
              checked={targetKind === "ORDER_DETAIL"}
              onChange={() => {
                setTargetKind("ORDER_DETAIL");
                setTargetIssue(null);
              }}
            />
            <label htmlFor="measure-target-detail">
              注文 1 件（<code>GET /orders/{"{orderId}"}</code>）
            </label>
          </div>

          {targetKind === "ORDER_LIST" ? (
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="measure-customer-id">
                顧客 ID（任意）
              </label>
              <input
                id="measure-customer-id"
                className={`input ${styles.textInput}`}
                type="text"
                value={customerIdInput}
                onChange={(event) => setCustomerIdInput(event.target.value)}
                placeholder="test-0001"
                aria-describedby={
                  targetIssue === null
                    ? "measure-customer-id-hint"
                    : "measure-customer-id-hint measure-target-error"
                }
                aria-invalid={targetIssue !== null}
              />
              <p id="measure-customer-id-hint" className={styles.fieldHint}>
                未入力なら既定のテスト顧客を対象にする。該当が 0 件でも
                GSI への Query は実際に走るため、計測は成立する。
              </p>
            </div>
          ) : (
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="measure-order-id">
                注文 ID
              </label>
              <input
                id="measure-order-id"
                className={`input ${styles.textInput}`}
                type="text"
                value={orderIdInput}
                onChange={(event) => setOrderIdInput(event.target.value)}
                placeholder="ORD#01J..."
                aria-describedby={
                  targetIssue === null
                    ? "measure-order-id-hint"
                    : "measure-order-id-hint measure-target-error"
                }
                aria-invalid={targetIssue !== null}
              />
              <p id="measure-order-id-hint" className={styles.fieldHint}>
                存在する注文 ID を指定する。存在しない ID は全リクエストが 404
                になり、その他のエラーとして集計される。
              </p>
            </div>
          )}

          {targetIssue !== null && (
            <p id="measure-target-error" className={styles.fieldError}>
              {targetIssue}
            </p>
          )}
        </fieldset>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="measure-load-test-id">
            負荷テスト実行 ID（任意）
          </label>
          <input
            id="measure-load-test-id"
            className={`input ${styles.textInput}`}
            type="text"
            value={loadTestIdInput}
            onChange={(event) => setLoadTestIdInput(event.target.value)}
            placeholder="LOAD#01J..."
            aria-describedby={
              loadTestIdIssue === null
                ? "measure-load-test-id-hint"
                : "measure-load-test-id-hint measure-load-test-id-error"
            }
            aria-invalid={loadTestIdIssue !== null}
          />
          <p id="measure-load-test-id-hint" className={styles.fieldHint}>
            並行して走らせている負荷生成の実行 ID。上のパネルで実行を追跡すると
            自動で入る。記録しておくと、どの投入レートの最中に測った結果かを
            後から突き合わせられる。
          </p>
          {loadTestIdIssue !== null && (
            <p id="measure-load-test-id-error" className={styles.fieldError}>
              {loadTestIdIssue}
            </p>
          )}
        </div>

        <div className={styles.actions}>
          <button type="submit" className="btn-primary" disabled={!canStart}>
            {starting ? "開始中…" : "並行計測を開始する"}
          </button>
        </div>
      </form>

      <p className={styles.statusLine} role="status" aria-live="polite">
        {starting
          ? "並行計測を開始しています…"
          : tracking.loading
            ? "実行状態を取得しています…"
            : tracking.failure !== null
              ? `実行状態の照会に失敗しました: ${tracking.failure.title}`
              : progress !== null
                ? `${progress.statusLabel} / リクエスト ${formatCount(progress.requestCount)} 件${
                    tracking.polling ? "。自動更新中" : "。自動更新は停止中"
                  }`
                : ""}
      </p>

      {startFailure !== null && <FailureAlert notice={startFailure} />}

      {tracking.executionId !== null && (
        <div className={styles.result}>
          <dl className={styles.summaryGrid}>
            <SummaryItem label="実行 ID" value={tracking.executionId} mono />
          </dl>

          <div className={styles.inlineActions}>
            <button
              type="button"
              className="btn-secondary"
              onClick={tracking.refresh}
              disabled={tracking.loading || tracking.refreshing}
            >
              今すぐ再取得
            </button>
          </div>

          {tracking.failure !== null && (
            <FailureAlert notice={tracking.failure} onRetry={tracking.refresh} />
          )}

          {execution !== null && progress !== null && (
            <>
              <dl className={styles.summaryGrid}>
                <div className={styles.summaryItem}>
                  <dt className={styles.summaryLabel}>実行状態</dt>
                  <dd className={styles.summaryValue}>
                    <span className={executionStatusBadgeClass(progress.status)}>
                      {progress.statusLabel}
                    </span>
                  </dd>
                </div>
                <SummaryItem label="並行数" value={formatCount(progress.concurrency)} />
                <SummaryItem label="リクエスト総数" value={formatCount(progress.requestCount)} />
                <SummaryItem label="成功件数" value={formatCount(progress.successCount)} />
                <SummaryItem
                  label="スロットル件数（429）"
                  value={formatCount(progress.throttleCount)}
                />
                <SummaryItem
                  label="その他のエラー件数"
                  value={formatCount(progress.otherErrorCount)}
                />
                <SummaryItem label="スロットル率" value={formatPercent(progress.throttleRate)} />
                <SummaryItem label="エラー率（合計）" value={formatPercent(progress.errorRate)} />
                <SummaryItem
                  label="実測スループット"
                  value={formatRatePerSecond(progress.requestsPerSecond)}
                />
                <SummaryItem label="継続時間" value={formatSeconds(execution.durationSeconds)} />
                <SummaryItem label="経過時間" value={formatElapsedMs(execution.elapsedMs)} />
                <SummaryItem
                  label="負荷テスト実行 ID"
                  value={execution.loadTestId ?? EMPTY_VALUE}
                  mono
                />
                <SummaryItem label="開始時刻" value={formatTimestamp(execution.startedAt)} mono />
                <SummaryItem
                  label="終了時刻"
                  value={
                    execution.finishedAt === null ? EMPTY_VALUE : formatTimestamp(execution.finishedAt)
                  }
                  mono
                />
              </dl>

              <div className={styles.progressBlock}>
                <p className={styles.progressLabel} id="measure-progress-label">
                  経過: {formatElapsedMs(execution.elapsedMs)} /{" "}
                  {formatSeconds(execution.durationSeconds)}
                </p>
                <div
                  className={styles.progressTrack}
                  role="progressbar"
                  aria-labelledby="measure-progress-label"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  {...(progress.progressPercent === null
                    ? {}
                    : {
                        "aria-valuenow": progress.progressPercent,
                        "aria-valuetext": `${progress.progressPercent}% 経過`,
                      })}
                >
                  <div
                    className={
                      progress.status === "FAILED" ? styles.progressBarFailed : styles.progressBar
                    }
                    style={{ width: `${progress.progressPercent ?? 0}%` }}
                  />
                </div>
              </div>

              <div className={styles.tableWrap}>
                <table className="data-table">
                  <caption className={styles.tableCaption}>
                    照会 API のレイテンシ分布（計測完了まで空欄。要件 12.3）
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">p50</th>
                      <th scope="col">p95</th>
                      <th scope="col">p99</th>
                      <th scope="col">最大</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{formatElapsedMs(percentiles?.p50)}</td>
                      <td>{formatElapsedMs(percentiles?.p95)}</td>
                      <td>{formatElapsedMs(percentiles?.p99)}</td>
                      <td>{formatElapsedMs(percentiles?.max)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {execution.errorMessage !== null && (
                <p className={styles.warningAlert} role="alert">
                  実行が失敗しました: {execution.errorMessage}
                </p>
              )}

              <ExecutionConditions conditions={execution.conditions} />

              <p className={styles.fieldHint}>
                最終取得: {formatTimestamp(tracking.fetchedAt)}
                {tracking.refreshing ? "（更新中）" : ""}
              </p>
            </>
          )}
        </div>
      )}

      <form className={styles.form} onSubmit={handleTrack} noValidate>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="measure-track-id">
            既存の実行 ID を追跡する
          </label>
          <input
            id="measure-track-id"
            className={`input ${styles.textInput}`}
            type="text"
            value={trackIdInput}
            onChange={(event) => setTrackIdInput(event.target.value)}
            placeholder="MEASURE#01J..."
            aria-describedby={
              trackIdIssue === null
                ? "measure-track-id-hint"
                : "measure-track-id-hint measure-track-id-error"
            }
            aria-invalid={trackIdIssue !== null}
          />
          <p id="measure-track-id-hint" className={styles.fieldHint}>
            計測は画面を離れても継続する。再読み込みで実行 ID を見失ったときは、
            ここに貼り直すと結果表示を再開できる。
          </p>
          {trackIdIssue !== null && (
            <p id="measure-track-id-error" className={styles.fieldError}>
              {trackIdIssue}
            </p>
          )}
        </div>
        <div className={styles.actions}>
          <button type="submit" className="btn-secondary">
            この実行を追跡する
          </button>
        </div>
      </form>
    </section>
  );
}
