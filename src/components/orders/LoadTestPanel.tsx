"use client";

/**
 * 負荷生成の開始と実行状態の表示（要件 14.3 / 11.1〜11.6 / 11.11）。
 *
 * ## 開始前に「何件入るのか」を出す
 *
 * この画面のボタンは**実際の AWS 課金を発生させる**（design §7.3 では
 * 軸 A 全体で約 $2.7、軸 B で約 $18.3 を見込んでいる）。目標レートの上限は
 * デプロイ済みの設定次第で 16,000 件/分まで許される（design §10.2 の軸 B）ため、
 * 桁を 1 つ間違えた実行がそのまま流れうる。
 *
 * そこで「目標レート × 継続時間 = 見込み件数」を送信前に提示し、
 * 確認のチェックを通さないと開始できないようにしている。
 * チェックは実行ごとに外す（同じ確認を次の実行に流用させない）。
 *
 * ## 上限は `GET /config` から取る（要件 10.6）
 *
 * 入力の検証に使う上限はデプロイ済みの Lambda 環境変数が出典であり、
 * 画面に定数として持たない（`execution-run.ts` の注記）。
 * 取得できていない間は開始できない。上限を知らずに送ると、
 * 400 で弾かれるか、意図より大きな負荷が通ってしまう。
 *
 * ## 開始後はポーリングで追う
 *
 * `POST /load-test/start` は 202 と実行 ID だけを返し、投入は非同期に続く
 * （要件 11.9）。進捗は `GET /executions/{executionId}` を繰り返し取得して
 * 表示し、`COMPLETED` / `FAILED` で止める（`use-execution-polling.ts`）。
 *
 * 実測投入レートと乖離警告は完了時にしか記録されない
 * （`execution-record.ts`）。実行中は投入件数 ÷ 経過時間の暫定レートを
 * 併記するが、これは実行レコードの値ではないので §2.4 の算術には使わない。
 */

import { useEffect, useState } from "react";

import { startLoadTest } from "@/src/lib/orders/api";
import { isLoadTestStatus } from "@/src/lib/orders/types";

import ExecutionConditions from "./ExecutionConditions";
import FailureAlert from "./FailureAlert";
import {
  deriveLoadTestProgress,
  executionStatusBadgeClass,
  formatPercent,
  formatRatePerMinute,
  formatSeconds,
  parseDurationSecondsInput,
  parseExecutionIdInput,
  parseOrdersPerMinuteInput,
  previewLoadTestPlanFromInputs,
} from "./execution-run";
import { describeOrderApiFailure, type FailureNotice } from "./order-api-failure";
import { EMPTY_VALUE, formatCount, formatElapsedMs, formatTimestamp } from "./order-progress";
import styles from "./orders.module.css";
import SummaryItem from "./SummaryItem";
import { useVerificationConfig } from "./use-verification-config";
import { EXECUTION_POLL_INTERVAL_MS, useExecutionPolling } from "./use-execution-polling";

interface LoadTestPanelProps {
  /**
   * 追跡中の負荷テスト実行 ID を親に伝える。
   * 親（`OrderDashboard`）が `QueryImpactPanel` に渡し、
   * 並行計測の `loadTestId` として関連付けられるようにする（要件 12.5）。
   */
  onLoadTestTracked?: (loadTestId: string | null) => void;
}

export default function LoadTestPanel({ onLoadTestTracked }: LoadTestPanelProps) {
  const { state: configState, config, failure: configFailure, reload } = useVerificationConfig();
  const tracking = useExecutionPolling("LOAD_TEST", isLoadTestStatus);

  // ── 開始パラメータ
  const [ordersPerMinuteInput, setOrdersPerMinuteInput] = useState("");
  const [ordersPerMinuteIssue, setOrdersPerMinuteIssue] = useState<string | null>(null);
  const [durationSecondsInput, setDurationSecondsInput] = useState("");
  const [durationSecondsIssue, setDurationSecondsIssue] = useState<string | null>(null);
  const [useRampCurve, setUseRampCurve] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [acknowledgeIssue, setAcknowledgeIssue] = useState<string | null>(null);

  const [starting, setStarting] = useState(false);
  const [startFailure, setStartFailure] = useState<FailureNotice | null>(null);

  // ── 既存の実行を追跡する（再読み込みで実行 ID を見失ったとき）
  const [trackIdInput, setTrackIdInput] = useState("");
  const [trackIdIssue, setTrackIdIssue] = useState<string | null>(null);

  const limits = config === null ? null : config.limits;

  // 追跡対象が変わったら親へ伝える（並行計測の loadTestId になる）
  useEffect(() => {
    onLoadTestTracked?.(tracking.executionId);
  }, [tracking.executionId, onLoadTestTracked]);

  const preview = previewLoadTestPlanFromInputs({
    ordersPerMinuteInput,
    durationSecondsInput,
    useRampCurve,
    limits,
  });

  async function handleStart(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (starting) {
      return;
    }

    const ordersPerMinute = parseOrdersPerMinuteInput(
      ordersPerMinuteInput,
      limits?.maxOrdersPerMinute ?? null
    );
    const durationSeconds = parseDurationSecondsInput(
      durationSecondsInput,
      limits?.maxDurationSeconds ?? null
    );
    setOrdersPerMinuteIssue(ordersPerMinute.ok ? null : ordersPerMinute.issue);
    setDurationSecondsIssue(durationSeconds.ok ? null : durationSeconds.issue);

    if (!ordersPerMinute.ok || !durationSeconds.ok) {
      return;
    }

    // 課金を伴う操作なので、見込み件数を確認したことを明示させる
    if (!acknowledged) {
      setAcknowledgeIssue("投入する見込み件数を確認してください。");
      return;
    }
    setAcknowledgeIssue(null);

    setStarting(true);
    setStartFailure(null);
    try {
      const response = await startLoadTest({
        ordersPerMinute: ordersPerMinute.value,
        durationSeconds: durationSeconds.value,
        useRampCurve,
      });
      tracking.track(response.executionId);
      // 次の実行でも改めて確認させる
      setAcknowledged(false);
    } catch (error) {
      setStartFailure(describeOrderApiFailure(error, "startLoadTest"));
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
  const progress = execution === null ? null : deriveLoadTestProgress(execution);

  const canStart = starting ? false : configState === "ready" && preview !== null && acknowledged;

  return (
    <section className="card" aria-labelledby="load-test-heading">
      <h2 id="load-test-heading" className={styles.sectionTitle}>
        負荷生成
      </h2>
      <p className={styles.sectionDescription}>
        <code>POST /load-test/start</code> で注文の連続投入を開始する。開始要求には
        即座に応答が返り、投入は非同期に継続する。進捗は
        <code>GET /executions/{"{executionId}"}</code> を{" "}
        {EXECUTION_POLL_INTERVAL_MS / 1_000} 秒間隔で取得して表示する。
      </p>

      <p className={styles.warningNote}>
        この操作は実際の AWS 課金を発生させる。開始前に見込み件数を確認すること。
      </p>

      {/* 上限の出典を明示する。取得できていなければ開始させない（要件 10.6） */}
      <p className={styles.statusLine} role="status" aria-live="polite">
        {configState === "loading"
          ? "検証パラメータ（上限）を読み込んでいます…"
          : configState === "ready" && limits !== null
            ? `上限: ${formatCount(limits.maxOrdersPerMinute)} 件/分 / ${formatCount(
                limits.maxDurationSeconds
              )} 秒（デプロイ済みの設定）`
            : "検証パラメータを取得できないため、負荷生成を開始できません。"}
      </p>

      {configFailure !== null && <FailureAlert notice={configFailure} onRetry={reload} />}

      <form className={styles.form} onSubmit={handleStart} noValidate>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="load-test-rate">
            目標投入レート（件/分）
          </label>
          <input
            id="load-test-rate"
            className={`input ${styles.numberInput}`}
            type="text"
            inputMode="numeric"
            value={ordersPerMinuteInput}
            onChange={(event) => setOrdersPerMinuteInput(event.target.value)}
            aria-describedby={
              ordersPerMinuteIssue === null
                ? "load-test-rate-hint"
                : "load-test-rate-hint load-test-rate-error"
            }
            aria-invalid={ordersPerMinuteIssue !== null}
          />
          <p id="load-test-rate-hint" className={styles.fieldHint}>
            {limits === null
              ? "上限はデプロイ済みの設定（GET /config）から取得する。"
              : `1〜${formatCount(limits.maxOrdersPerMinute)} 件/分。負荷カーブを使う場合はピーク時のレート。`}
          </p>
          {ordersPerMinuteIssue !== null && (
            <p id="load-test-rate-error" className={styles.fieldError}>
              {ordersPerMinuteIssue}
            </p>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="load-test-duration">
            継続時間（秒）
          </label>
          <input
            id="load-test-duration"
            className={`input ${styles.numberInput}`}
            type="text"
            inputMode="numeric"
            value={durationSecondsInput}
            onChange={(event) => setDurationSecondsInput(event.target.value)}
            aria-describedby={
              durationSecondsIssue === null
                ? "load-test-duration-hint"
                : "load-test-duration-hint load-test-duration-error"
            }
            aria-invalid={durationSecondsIssue !== null}
          />
          <p id="load-test-duration-hint" className={styles.fieldHint}>
            {limits === null
              ? "上限はデプロイ済みの設定（GET /config）から取得する。"
              : `1〜${formatCount(limits.maxDurationSeconds)} 秒。`}
          </p>
          {durationSecondsIssue !== null && (
            <p id="load-test-duration-error" className={styles.fieldError}>
              {durationSecondsIssue}
            </p>
          )}
        </div>

        <div className={styles.checkboxField}>
          <input
            id="load-test-ramp"
            type="checkbox"
            checked={useRampCurve}
            onChange={(event) => setUseRampCurve(event.target.checked)}
          />
          <label htmlFor="load-test-ramp">
            負荷カーブを使う（漸増 30% → ピーク 40% → 漸減 30%）
          </label>
        </div>
        <p className={styles.fieldHint}>
          壁の位置を測るシナリオでは定常負荷（カーブなし）を使う。カーブでは
          投入レートが時間変化するため、消費能力との交点が動く。
        </p>

        {/*
          課金の事前確認。
          `aria-live` は付けない（入力のたびに読み上げると打鍵の邪魔になる）。
          代わりに確認チェックボックスの `aria-describedby` からこの文を指し、
          チェックする直前に見込み件数が読み上がるようにしている。
        */}
        <div className={styles.costPreview}>
          {preview === null ? (
            <p id="load-test-cost-preview" className={styles.fieldHint}>
              目標投入レートと継続時間を入力すると、投入される見込み件数を表示する。
            </p>
          ) : (
            <>
              <p id="load-test-cost-preview" className={styles.costPreviewTitle}>
                この設定で投入される見込み: 約 {formatCount(preview.estimatedOrderCount)} 件
              </p>
              <dl className={styles.summaryGrid}>
                <SummaryItem
                  label={preview.useRampCurve ? "ピーク時のレート" : "目標投入レート"}
                  value={formatRatePerMinute(preview.peakOrdersPerMinute)}
                />
                <SummaryItem label="継続時間" value={formatSeconds(preview.durationSeconds)} />
                <SummaryItem
                  label="期待される平均レート"
                  value={formatRatePerMinute(preview.expectedOrdersPerMinute)}
                />
                <SummaryItem
                  label="負荷カーブ"
                  value={preview.useRampCurve ? "使う" : "使わない（定常負荷）"}
                />
              </dl>
            </>
          )}
        </div>

        <div className={styles.checkboxField}>
          <input
            id="load-test-acknowledge"
            type="checkbox"
            checked={acknowledged}
            disabled={preview === null}
            onChange={(event) => {
              setAcknowledged(event.target.checked);
              if (event.target.checked) {
                setAcknowledgeIssue(null);
              }
            }}
            aria-describedby={
              acknowledgeIssue === null
                ? "load-test-cost-preview"
                : "load-test-cost-preview load-test-acknowledge-error"
            }
            aria-invalid={acknowledgeIssue !== null}
          />
          <label htmlFor="load-test-acknowledge">
            上記の件数を投入すること（課金が発生すること）を確認した
          </label>
        </div>
        {acknowledgeIssue !== null && (
          <p id="load-test-acknowledge-error" className={styles.fieldError}>
            {acknowledgeIssue}
          </p>
        )}

        <div className={styles.actions}>
          <button type="submit" className="btn-primary" disabled={!canStart}>
            {starting ? "開始中…" : "負荷生成を開始する"}
          </button>
        </div>
      </form>

      {/* 開始とポーリングの状態を 1 行にまとめて読み上げる */}
      <p className={styles.statusLine} role="status" aria-live="polite">
        {starting
          ? "負荷生成を開始しています…"
          : tracking.loading
            ? "実行状態を取得しています…"
            : tracking.failure !== null
              ? `実行状態の照会に失敗しました: ${tracking.failure.title}`
              : progress !== null
                ? `${progress.statusLabel} / 投入 ${formatCount(progress.submittedCount)} 件${
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
                <SummaryItem label="投入件数" value={formatCount(progress.submittedCount)} />
                <SummaryItem
                  label="投入エラー件数"
                  value={formatCount(progress.submitErrorCount)}
                />
                <SummaryItem
                  label="投入エラー率"
                  value={formatPercent(progress.submitErrorRate)}
                />
                <SummaryItem
                  label={execution.useRampCurve ? "目標レート（ピーク）" : "目標投入レート"}
                  value={formatRatePerMinute(progress.targetOrdersPerMinute)}
                />
                <SummaryItem
                  label="期待される平均レート"
                  value={formatRatePerMinute(progress.expectedOrdersPerMinute)}
                />
                <SummaryItem
                  label="実測投入レート（記録値）"
                  value={formatRatePerMinute(progress.actualOrdersPerMinute)}
                />
                <SummaryItem
                  label="暫定レート（投入 ÷ 経過）"
                  value={formatRatePerMinute(progress.interimOrdersPerMinute)}
                />
                <SummaryItem
                  label="期待レートに対する達成率"
                  value={formatPercent(progress.rateAchievement)}
                />
                <SummaryItem label="継続時間" value={formatSeconds(execution.durationSeconds)} />
                <SummaryItem label="経過時間" value={formatElapsedMs(execution.elapsedMs)} />
                <SummaryItem
                  label="負荷カーブ"
                  value={execution.useRampCurve ? "使う" : "使わない（定常負荷）"}
                />
                <SummaryItem label="開始時刻" value={formatTimestamp(execution.startedAt)} mono />
                <SummaryItem
                  label="終了時刻"
                  value={execution.finishedAt === null ? EMPTY_VALUE : formatTimestamp(execution.finishedAt)}
                  mono
                />
              </dl>

              <div className={styles.progressBlock}>
                <p className={styles.progressLabel} id="load-test-progress-label">
                  経過: {formatElapsedMs(execution.elapsedMs)} /{" "}
                  {formatSeconds(execution.durationSeconds)}
                </p>
                <div
                  className={styles.progressTrack}
                  role="progressbar"
                  aria-labelledby="load-test-progress-label"
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

              {/*
                実測レートの乖離警告（要件 11.11）。
                乖離した実行の算出値は §2.4 の算術に使えない（Property 11）ため、
                値の並びに埋めず、警告として独立させる。
              */}
              {progress.rateDeviationWarning === true && (
                <p className={styles.warningAlert} role="alert">
                  実測投入レート（{formatRatePerMinute(progress.actualOrdersPerMinute)}）が
                  期待レート（{formatRatePerMinute(progress.expectedOrdersPerMinute)}）から
                  乖離しています。この実行の算出値（消費能力との比較、滞留の増加率、
                  データロス猶予時間）は信用できません。
                </p>
              )}

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
          <label className={styles.fieldLabel} htmlFor="load-test-track-id">
            既存の実行 ID を追跡する
          </label>
          <input
            id="load-test-track-id"
            className={`input ${styles.textInput}`}
            type="text"
            value={trackIdInput}
            onChange={(event) => setTrackIdInput(event.target.value)}
            placeholder="LOAD#01J..."
            aria-describedby={
              trackIdIssue === null
                ? "load-test-track-id-hint"
                : "load-test-track-id-hint load-test-track-id-error"
            }
            aria-invalid={trackIdIssue !== null}
          />
          <p id="load-test-track-id-hint" className={styles.fieldHint}>
            投入は画面を離れても継続する。再読み込みで実行 ID を見失ったときは、
            ここに貼り直すと状態表示を再開できる。
          </p>
          {trackIdIssue !== null && (
            <p id="load-test-track-id-error" className={styles.fieldError}>
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
