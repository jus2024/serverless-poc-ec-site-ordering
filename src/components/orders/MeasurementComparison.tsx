"use client";

/**
 * 複数実行の比較表（design §11.2 / §11.4。要件 14.6 / 11.11）。
 *
 * ## この表が成果物である
 *
 * 本 Spec の主要な成果はシナリオ間の差（design §2.2 の壁の候補表）であり、
 * 1 回の実行結果だけでは何も言えない。A3 と A5 で PF を変えたときに
 * 消費能力と滞留の増加率がどう動いたか、その並びが結論になる。
 *
 * ## 乖離した行を目立たせる（要件 11.11）
 *
 * 実測投入レートが目標から乖離した実行では、`S × P ÷ D` との比較も
 * 滞留の増加率もデータロス猶予時間も**意味を持たない**（Property 11）。
 * そこで乖離した行には
 *
 * - 行内の投入レート欄に警告を出す
 * - 算出値の列を空欄にし、「算術に使えない理由」を明示する
 * - 表の上に該当する実行 ID をまとめて出す（`role="alert"`）
 *
 * の 3 つを行う。列が多く横スクロールを伴う表なので、行内のマークだけでは
 * 見落としうる。
 *
 * ## 実行の追加は手動である
 *
 * 実行 ID を貼って `GET /executions/{id}` を取得し、その時点の
 * スナップショットを保存する。負荷生成・並行計測のパネルから
 * 自動で流し込まない理由は 2 つある。
 *
 * 1. 比較したいのは**選んだシナリオ**であり、試し撃ちを含む全実行ではない
 * 2. 実測投入レートと乖離警告は実行が完了した時点で記録される
 *    （`execution-record.ts`）。実行中に取り込むと未記録の行が並ぶ
 *
 * 同じ実行 ID を貼り直すと行が差し替わる（`upsertMeasurementRun`）ので、
 * 実行中に追加した行は完了後に貼り直して更新する。
 *
 * ## 保存は `localStorage`（design §11.4）
 *
 * シナリオの一部は再デプロイを伴うため、1 セッションで測り切れない。
 * 容量超過時は生データを落とした軽量版で再試行する
 * （`measurement-store.ts`）。ストレージが使えない環境でも
 * 表はメモリ上で動き、その旨を案内する。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { getExecution } from "@/src/lib/orders/api";

import {
  EXECUTION_STATUS_LABELS,
  EXECUTION_TYPE_LABELS,
  executionStatusBadgeClass,
  formatRatePerMinute,
  formatSeconds,
  parseExecutionIdInput,
} from "./execution-run";
import {
  deriveComparisonRows,
  describeLoadResult,
  describeSaveResult,
  formatArithmeticAvailability,
  formatBacklogGrowth,
  formatDataLossGrace,
  formatErrorCounts,
  formatLatencySummary,
  formatRateComparison,
  formatRecoveryTime,
  formatStageDelays,
  summarizeComparison,
  type ComparisonRow,
} from "./measurement-comparison";
import {
  MAX_RUN_LABEL_LENGTH,
  MAX_STORED_RUNS,
  createMeasurementRun,
  loadMeasurementRuns,
  removeMeasurementRun,
  resolveMeasurementStorage,
  saveMeasurementRuns,
  upsertMeasurementRun,
  type MeasurementRun,
  type StorageLike,
} from "./measurement-store";
import { describeOrderApiFailure, type FailureNotice } from "./order-api-failure";
import FailureAlert from "./FailureAlert";
import { EMPTY_VALUE, formatCount, formatTimestamp } from "./order-progress";
import styles from "./orders.module.css";

export default function MeasurementComparison() {
  const [runs, setRuns] = useState<readonly MeasurementRun[]>([]);
  /** 読み込み時の案内（破棄・読み飛ばし・軽量版） */
  const [loadNotice, setLoadNotice] = useState<string | null>(null);
  /** 保存時の案内（軽量版・保存不可） */
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const [executionIdInput, setExecutionIdInput] = useState("");
  const [executionIdIssue, setExecutionIdIssue] = useState<string | null>(null);
  const [labelInput, setLabelInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [addFailure, setAddFailure] = useState<FailureNotice | null>(null);
  /**
   * 全削除の確認待ち。
   *
   * 比較表そのものが本 Spec の成果物であり、再デプロイを挟んだシナリオの行は
   * 実行を流し直さないと復元できない。1 クリックで消えないようにする。
   */
  const [confirmingClear, setConfirmingClear] = useState(false);

  /**
   * `localStorage`。サーバ側描画では存在しないため、マウント後に解決する。
   * 描画のたびに参照し直さないよう ref に持つ。
   */
  const storageRef = useRef<StorageLike | null>(null);

  /** 進行中の実行レコード取得（他のパネルと同じ作法で中断する） */
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const storage = resolveMeasurementStorage();
    storageRef.current = storage;
    const result = loadMeasurementRuns(storage);
    setRuns(result.runs);
    setLoadNotice(describeLoadResult(result));
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  /** 一覧を差し替えて保存する（保存の失敗は案内に出すだけで表は動かす） */
  const persist = useCallback((next: readonly MeasurementRun[]) => {
    setRuns(next);
    setSaveNotice(describeSaveResult(saveMeasurementRuns(storageRef.current, next)));
  }, []);

  async function handleAdd(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (adding) {
      return;
    }

    const parsed = parseExecutionIdInput(executionIdInput);
    setExecutionIdIssue(parsed.ok ? null : parsed.issue);
    if (!parsed.ok) {
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setAdding(true);
    setAddFailure(null);
    try {
      const execution = await getExecution(parsed.value, { signal: controller.signal });
      if (controller.signal.aborted) {
        return;
      }
      persist(
        upsertMeasurementRun(runs, createMeasurementRun({ execution, label: labelInput }))
      );
      setExecutionIdInput("");
      setLabelInput("");
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      setAddFailure(describeOrderApiFailure(error, "getExecution"));
    } finally {
      if (!controller.signal.aborted) {
        setAdding(false);
      }
    }
  }

  const rows = deriveComparisonRows(runs);
  const overview = summarizeComparison(rows);

  return (
    <section className="card" aria-labelledby="measurement-comparison-heading">
      <h2 id="measurement-comparison-heading" className={styles.sectionTitle}>
        計測結果の比較
      </h2>
      <p className={styles.sectionDescription}>
        実行 ID を追加すると、その時点の実行レコードを保存して並べる。滞留の増加率と
        データロス猶予時間は保存した実測投入レートと消費能力から算出する（design §2.4）。
        結果はブラウザに保存されるため、再デプロイを挟むシナリオでも比較できる。
      </p>

      <form className={styles.form} onSubmit={handleAdd} noValidate>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="comparison-execution-id">
            実行 ID
          </label>
          <input
            id="comparison-execution-id"
            className={`input ${styles.textInput}`}
            type="text"
            value={executionIdInput}
            onChange={(event) => setExecutionIdInput(event.target.value)}
            placeholder="LOAD#01J... または MEASURE#01J..."
            aria-describedby={
              executionIdIssue === null
                ? "comparison-execution-id-hint"
                : "comparison-execution-id-hint comparison-execution-id-error"
            }
            aria-invalid={executionIdIssue !== null}
          />
          <p id="comparison-execution-id-hint" className={styles.fieldHint}>
            負荷生成（<code>LOAD#</code>）と並行計測（<code>MEASURE#</code>）のどちらも
            追加できる。実測投入レートと乖離警告は実行の完了時に記録されるため、
            実行中に追加した行は完了後に同じ実行 ID を追加し直すと更新される。
          </p>
          {executionIdIssue !== null && (
            <p id="comparison-execution-id-error" className={styles.fieldError}>
              {executionIdIssue}
            </p>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="comparison-label">
            シナリオ名（任意）
          </label>
          <input
            id="comparison-label"
            className={`input ${styles.textInput}`}
            type="text"
            value={labelInput}
            maxLength={MAX_RUN_LABEL_LENGTH}
            onChange={(event) => setLabelInput(event.target.value)}
            placeholder="A3: PF=1 / 2,000 件/分"
            aria-describedby="comparison-label-hint"
          />
          <p id="comparison-label-hint" className={styles.fieldHint}>
            design §10.2 のシナリオ ID を入れておくと、どの設定の実行かを
            実行 ID から辿らずに読める。{MAX_RUN_LABEL_LENGTH} 文字まで。
          </p>
        </div>

        <div className={styles.actions}>
          <button type="submit" className="btn-primary" disabled={adding}>
            {adding ? "取得中…" : "この実行を比較表に追加する"}
          </button>
          {runs.length > 0 && !confirmingClear && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setConfirmingClear(true)}
            >
              すべて削除する
            </button>
          )}
          {confirmingClear && (
            <>
              <span className={styles.fieldError} role="alert">
                保存済みの {formatCount(runs.length)} 件をすべて削除します。実行を流し直さないと
                復元できません。
              </span>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  persist([]);
                  setConfirmingClear(false);
                }}
              >
                削除する
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setConfirmingClear(false)}
              >
                やめる
              </button>
            </>
          )}
        </div>
      </form>

      <p className={styles.statusLine} role="status" aria-live="polite">
        {adding
          ? "実行レコードを取得しています…"
          : `${formatCount(overview.rowCount)} 件を保存中（負荷生成 ${formatCount(
              overview.loadTestCount
            )} 件 / 並行計測 ${formatCount(overview.queryImpactCount)} 件。上限 ${formatCount(
              MAX_STORED_RUNS
            )} 件）`}
      </p>

      {addFailure !== null && <FailureAlert notice={addFailure} />}

      {loadNotice !== null && (
        <p className={styles.warningNote} role="note">
          {loadNotice}
        </p>
      )}
      {saveNotice !== null && (
        <p className={styles.warningAlert} role="alert">
          {saveNotice}
        </p>
      )}

      {/*
        乖離警告の集約（要件 11.11）。
        表の中のマークだけに頼らないのは、列が多く横スクロールを伴うためである。
      */}
      {overview.deviatedExecutionIds.length > 0 && (
        <p className={styles.warningAlert} role="alert">
          実測投入レートが目標から乖離した実行が{" "}
          {formatCount(overview.deviatedExecutionIds.length)} 件あります（
          {overview.deviatedExecutionIds.join(", ")}
          ）。これらの行の算出値（消費能力との比較、滞留の増加率、データロス猶予時間）は
          信用できないため、表では空欄にしています。
        </p>
      )}

      {overview.shardCountMissingExecutionIds.length > 0 && (
        <p className={styles.warningNote} role="note">
          オープンシャード数を取得できなかった実行が{" "}
          {formatCount(overview.shardCountMissingExecutionIds.length)} 件あります（
          {overview.shardCountMissingExecutionIds.join(", ")}
          ）。消費能力を算出できないため、壁の位置の検証には使えません。
        </p>
      )}

      {rows.length === 0 ? (
        <p className={styles.fieldHint}>
          まだ比較する実行がありません。負荷テストのタブで実行を開始し、その実行 ID を
          ここに追加してください。
        </p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={`data-table ${styles.comparisonTable}`}>
            <caption className={styles.tableCaption}>
              実行条件と算出値の比較（design §11.2）。滞留の増加率・データロス猶予時間・
              回復時間は実測投入レートと消費能力から算出した値で、実測投入レートが
              目標から乖離した実行では算出しない（要件 11.11）。
            </caption>
            <thead>
              <tr>
                <th scope="col">実行 / 種別</th>
                <th scope="col">状態</th>
                <th scope="col">
                  シャード数 (S)
                </th>
                <th scope="col">PF (P)</th>
                <th scope="col">擬似処理時間（決済 + 通知）</th>
                <th scope="col">算出した消費能力</th>
                <th scope="col">投入レート（目標 / 実測）</th>
                <th scope="col">滞留の増加率</th>
                <th scope="col">データロス猶予時間</th>
                <th scope="col">回復時間（予測）</th>
                <th scope="col">レイテンシ分位点</th>
                <th scope="col">エラー件数</th>
                <th scope="col">算術の可否</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ComparisonTableRow
                  key={row.key}
                  row={row}
                  onRemove={() =>
                    persist(removeMeasurementRun(runs, row.summary.executionId))
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * 比較表の 1 行。
 *
 * 行見出し（`th scope="row"`）にシナリオ名と実行 ID を置く。読み上げの際に
 * 各セルが「どの実行の値か」と対で読まれるようにするためで、列が多い表では
 * これが無いと数値の並びだけが読み上げられる。
 */
function ComparisonTableRow({
  row,
  onRemove,
}: {
  row: ComparisonRow;
  onRemove: () => void;
}) {
  const { summary } = row;

  return (
    <tr className={row.rateDeviationWarning ? styles.rowDeviated : undefined}>
      <th scope="row" className={styles.rowHeader}>
        <span className={styles.rowLabel}>{row.label ?? EMPTY_VALUE}</span>
        <span className={`${styles.rowId} ${styles.mono}`}>{summary.executionId}</span>
        <span className={styles.rowMeta}>
          {EXECUTION_TYPE_LABELS[summary.executionType]} / 継続{" "}
          {formatSeconds(summary.durationSeconds)}
          {row.hasRawSnapshot ? "" : " / 軽量版"}
        </span>
        <span className={styles.rowMeta}>保存: {formatTimestamp(row.savedAt)}</span>
      </th>

      <td>
        <span className={executionStatusBadgeClass(summary.status)}>
          {EXECUTION_STATUS_LABELS[summary.status]}
        </span>
      </td>

      <td>
        {summary.openShardCount === null ? (
          <span className={styles.cellBlocked}>{EMPTY_VALUE}（未取得）</span>
        ) : (
          formatCount(summary.openShardCount)
        )}
      </td>

      <td>{formatCount(summary.parallelizationFactor)}</td>
      <td>{formatStageDelays(summary.stageDelaysMs)}</td>

      <td>{formatRatePerMinute(summary.estimatedCapacityPerMinute)}</td>

      {/* 乖離警告はこのセルに置く。値そのものが信用できないことを値の隣で示す */}
      <td>
        {formatRateComparison(summary)}
        {row.rateDeviationWarning && (
          <span className={styles.cellWarning}>警告: 目標から乖離</span>
        )}
      </td>

      <td>{formatBacklogGrowth(row.backlog)}</td>
      <td>{formatDataLossGrace(row.backlog)}</td>
      <td>{formatRecoveryTime(row.projectedRecoverySeconds)}</td>
      <td>{formatLatencySummary(summary.latencyPercentiles)}</td>
      <td>{formatErrorCounts(summary)}</td>

      <td>
        <span className={row.blockedReason === null ? undefined : styles.cellBlocked}>
          {formatArithmeticAvailability(row)}
        </span>
      </td>

      <td>
        <button type="button" className="btn-secondary" onClick={onRemove}>
          削除
          <span className={styles.srOnly}>（{summary.executionId}）</span>
        </button>
      </td>
    </tr>
  );
}
