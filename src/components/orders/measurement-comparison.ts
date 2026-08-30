/**
 * 比較表の行の導出（純粋関数。design §11.2。要件 14.6 / 11.11）。
 *
 * ## 何を導出するのか
 *
 * 保存済みの実行レコード（`measurement-store.ts`）から design §11.2 の列を組む。
 * S / P / D / 算出した消費能力 / 目標・実測投入レート /
 * レイテンシ分位点 / スロットル件数は実行レコードの値をそのまま並べるだけだが、
 * **滞留の増加率とデータロス猶予時間は `capacity.ts` の式で算出する**
 * （design §2.4。要件 20.2 / 20.3）。
 *
 * ## 算術に使える行かどうかを行ごとに決める（要件 11.11 / Property 11）
 *
 * §2.4 の算術は「投入レート A」と「消費能力 C」の 2 つを入力にする。
 * どちらかが信用できない行では算出値を**出さない**。空欄にする代わりに
 * 理由を出す（`ArithmeticBlockReason`）。0 や「—」だけを並べると
 * 「滞留しなかった」と読めてしまい、結論が逆になる。
 *
 * | 理由 | 状況 | 出典 |
 * |------|------|------|
 * | `RATE_DEVIATION` | 実測投入レートが目標から乖離した | 要件 11.11 / Property 11 |
 * | `RATE_NOT_RECORDED` | 実行中または失敗で実測レートが未記録 | `execution-record.ts` |
 * | `SHARD_COUNT_MISSING` | S が取れず消費能力を算出できない | 要件 19.5 / design §E-8 |
 * | `NOT_LOAD_TEST` | 並行計測には投入レートが無い | design §4.3 |
 *
 * `RATE_DEVIATION` を他より先に判定する。乖離した実行は消費能力が
 * 算出できていても算術に使えない（Property 11）ため、
 * 「S は取れているから使える」と読ませてはならない。
 *
 * ## 回復時間は観測値ではなく予測である
 *
 * design §2.4 の回復時間は `T_recover = B ÷ C` であり、`IteratorAge` から求めるなら
 * `停止時点の IteratorAge × A ÷ C` になる（要件 20.4。§2.4 の訂正の記録）。
 * **「グラフから直接読める」という当初の記述は誤りだった。**
 * いずれにせよ実行レコードは `IteratorAge` を持たないため、この列は
 * 「継続時間ぶん滞留し続けたと仮定した場合の予測」として算出する。
 * 画面側でも予測であることを明示する。
 */

import {
  estimateRecoverySeconds,
  projectBacklog,
  type BacklogProjection,
} from "../../lib/orders/capacity";

import { formatRatePerMinute } from "./execution-run";
import { EMPTY_VALUE, formatCount, formatElapsedMs } from "./order-progress";
import type {
  MeasurementLoadResult,
  MeasurementRun,
  MeasurementSaveResult,
  MeasurementSummary,
} from "./measurement-store";

// ─── 算術の可否 ───────────────────────────────────────────────────

/** §2.4 の算術に使えない理由（このファイルの冒頭の表） */
export type ArithmeticBlockReason =
  | "RATE_DEVIATION"
  | "RATE_NOT_RECORDED"
  | "SHARD_COUNT_MISSING"
  | "NOT_LOAD_TEST";

/** 理由の日本語表示（表のセルに出す短い文） */
export const ARITHMETIC_BLOCK_LABELS: Record<ArithmeticBlockReason, string> = {
  RATE_DEVIATION: "使用不可: 実測レートが目標から乖離",
  RATE_NOT_RECORDED: "使用不可: 実測レートが未記録",
  SHARD_COUNT_MISSING: "使用不可: シャード数が未取得",
  NOT_LOAD_TEST: "対象外: 投入レートを持たない実行",
};

/** 算術に使える行の表示 */
export const ARITHMETIC_USABLE_LABEL = "使用可";

// ─── 行 ──────────────────────────────────────────────────────────

/** 比較表の 1 行（design §11.2） */
export interface ComparisonRow {
  /** React の key。実行 ID は一覧内で一意（`upsertMeasurementRun`） */
  key: string;
  savedAt: string;
  label: string | null;
  summary: MeasurementSummary;
  /** 生データを持つか（軽量版で保存された行は持たない。design §11.4） */
  hasRawSnapshot: boolean;

  /**
   * 実測投入レートと消費能力から求めた滞留の予測（design §2.4）。
   * 算術に使えない行は null
   */
  backlog: BacklogProjection | null;
  /**
   * 継続時間ぶん滞留し続けたと仮定した場合の回復時間（秒。要件 20.4）。
   * 滞留しない場合は 0、算出できない場合は null
   */
  projectedRecoverySeconds: number | null;
  /** 算術に使えない理由。使える行は null */
  blockedReason: ArithmeticBlockReason | null;
  /**
   * 実測レートの乖離警告（要件 11.11）。
   *
   * `blockedReason` とは別に持つ。乖離は「算術に使えない」理由のうち
   * **唯一、値が揃っているのに使えないもの**であり、表の上でも
   * 独立した警告として示す必要がある（design §11.2 の但し書き）。
   */
  rateDeviationWarning: boolean;
}

/** 保存済みの一覧から比較表の行を組む */
export function deriveComparisonRows(runs: readonly MeasurementRun[]): ComparisonRow[] {
  return runs.map((run) => deriveComparisonRow(run));
}

/** 保存済みの 1 件から行を組む */
export function deriveComparisonRow(run: MeasurementRun): ComparisonRow {
  const { summary } = run;
  const blockedReason = resolveBlockedReason(summary);

  const base = {
    key: summary.executionId,
    savedAt: run.savedAt,
    label: run.label,
    summary,
    hasRawSnapshot: run.execution !== null,
    rateDeviationWarning: summary.rateDeviationWarning === true,
    blockedReason,
  };

  if (blockedReason !== null) {
    return { ...base, backlog: null, projectedRecoverySeconds: null };
  }

  // `resolveBlockedReason` が null を返した時点で両方が有限な非負の数である
  const arrivalPerMinute = summary.actualOrdersPerMinute as number;
  const capacityPerMinute = summary.estimatedCapacityPerMinute as number;

  const backlog = projectBacklog({ arrivalPerMinute, capacityPerMinute });

  return {
    ...base,
    backlog,
    projectedRecoverySeconds: projectRecoverySeconds(backlog, summary.durationSeconds),
  };
}

/**
 * 算術に使えない理由を決める。使えるなら `null`。
 *
 * 判定順は冒頭の注記どおり。乖離（要件 11.11）を最優先にする。
 */
function resolveBlockedReason(summary: MeasurementSummary): ArithmeticBlockReason | null {
  if (summary.executionType !== "LOAD_TEST") {
    return "NOT_LOAD_TEST";
  }
  if (summary.rateDeviationWarning === true) {
    return "RATE_DEVIATION";
  }
  if (!isUsableNumber(summary.actualOrdersPerMinute)) {
    return "RATE_NOT_RECORDED";
  }
  if (!isUsableNumber(summary.estimatedCapacityPerMinute)) {
    return "SHARD_COUNT_MISSING";
  }
  return null;
}

/**
 * `capacity.ts` に渡せる値か。
 *
 * `projectBacklog` は負や非有限を `RangeError` で弾く。保存済みの値は
 * 手で編集されている可能性もあるため、投げさせずに「使えない行」として扱う。
 */
function isUsableNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

/**
 * 継続時間ぶん滞留し続けた場合の回復時間（秒）を予測する。
 *
 * 滞留量は `増加率 × 継続時間`。design §2.4 の `T_recover = B ÷ C` に
 * その滞留量を入れる。**この経路は §2.4 の訂正に影響されない。**
 * 滞留件数を `IteratorAge` を経由せず `(A − C) × 継続時間` で直接求めているためで、
 * `IteratorAge` 経由の式に展開しても一致する
 * （`継続時間 × (1 − C ÷ A) × A ÷ C = (A − C) × 継続時間 ÷ C`）。
 * 誤っていたのは分母に C を置いた `IteratorAge` 側の式だけである。
 *
 * A には実測投入レート（`actual_orders_per_minute`）を使う。目標レートは使わない。
 * 乖離した行はここに来ない（`resolveBlockedReason` が `RATE_DEVIATION` で弾く。
 * Property 11）。
 */
function projectRecoverySeconds(
  backlog: BacklogProjection,
  durationSeconds: number
): number | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    return null;
  }
  const backlogCount = backlog.backlogGrowthPerMinute * (durationSeconds / 60);
  return estimateRecoverySeconds({ backlogCount, capacityPerMinute: backlog.capacityPerMinute });
}

// ─── 一覧のまとめ ─────────────────────────────────────────────────

/** 比較表の上に出すまとめ（要件 11.11 の警告集約） */
export interface ComparisonSummaryView {
  rowCount: number;
  loadTestCount: number;
  queryImpactCount: number;
  /** 乖離警告が付いた実行 ID（要件 11.11）。表の上でまとめて示す */
  deviatedExecutionIds: string[];
  /** シャード数を取得できなかった実行 ID（要件 19.5） */
  shardCountMissingExecutionIds: string[];
  /** 生データを持たない行があるか（軽量版で保存された。design §11.4） */
  hasLightRows: boolean;
}

/**
 * 行の一覧からまとめを作る。
 *
 * 乖離警告を表の上にも集約するのは、列が多く横スクロールを伴う表で
 * 行内のマークだけに頼ると見落としうるためである。要件 11.11 は
 * 「乖離している行に警告を表示する」だが、その行の算出値を
 * 使ってしまうと結論そのものが誤るため、二重に示す。
 */
export function summarizeComparison(rows: readonly ComparisonRow[]): ComparisonSummaryView {
  return {
    rowCount: rows.length,
    loadTestCount: rows.filter((row) => row.summary.executionType === "LOAD_TEST").length,
    queryImpactCount: rows.filter((row) => row.summary.executionType === "QUERY_IMPACT").length,
    deviatedExecutionIds: rows
      .filter((row) => row.rateDeviationWarning)
      .map((row) => row.summary.executionId),
    shardCountMissingExecutionIds: rows
      .filter((row) => row.summary.openShardCount === null)
      .map((row) => row.summary.executionId),
    hasLightRows: rows.some((row) => !row.hasRawSnapshot),
  };
}

// ─── 書式 ────────────────────────────────────────────────────────

/**
 * 擬似処理時間 D の内訳を 1 セルに収める（例: `1,800 + 1,800 ms`）。
 *
 * 決済と通知の合計が D の主要部で、残りはオーバーヘッド（design §10.1）。
 * 合計だけを出すと、どちらの段階を動かしたシナリオなのかが読めない。
 */
export function formatStageDelays(delays: {
  payment: number;
  notification: number;
}): string {
  const payment = formatCount(delays.payment);
  const notification = formatCount(delays.notification);
  if (payment === EMPTY_VALUE || notification === EMPTY_VALUE) {
    return EMPTY_VALUE;
  }
  return `${payment} + ${notification} ms`;
}

/**
 * レイテンシ分位点を 1 セルに収める（要件 12.3）。
 *
 * 4 つの値を別の列に散らすと、負荷生成の行では 4 列が空欄になる。
 * 1 列にまとめ、どの分位点かをラベルとともに書く。
 */
export function formatLatencySummary(
  percentiles: { p50: number; p95: number; p99: number; max: number } | null
): string {
  if (percentiles === null) {
    return EMPTY_VALUE;
  }
  return [
    `p50 ${formatElapsedMs(percentiles.p50)}`,
    `p95 ${formatElapsedMs(percentiles.p95)}`,
    `p99 ${formatElapsedMs(percentiles.p99)}`,
    `最大 ${formatElapsedMs(percentiles.max)}`,
  ].join(" / ");
}

/**
 * エラー件数を 1 セルに収める（要件 12.2）。
 *
 * スロットルとその他を必ず併記する。合算した 1 つの数にすると、
 * 429 が出ていない実行と 429 だけの実行が同じ見え方になる。
 */
export function formatErrorCounts(summary: MeasurementSummary): string {
  if (summary.throttleCount === null && summary.otherErrorCount === null) {
    return EMPTY_VALUE;
  }
  return `スロットル ${formatCount(summary.throttleCount)} 件 / その他 ${formatCount(
    summary.otherErrorCount
  )} 件`;
}

/**
 * 目標と実測の投入レートを 1 セルに収める（design §11.2）。
 *
 * 並べて出すのは、乖離があること自体が読み取りたい情報だからである
 * （要件 11.11）。実測が未記録の行は目標だけを出す。
 */
export function formatRateComparison(summary: MeasurementSummary): string {
  if (summary.targetOrdersPerMinute === null) {
    return EMPTY_VALUE;
  }
  return `目標 ${formatRatePerMinute(summary.targetOrdersPerMinute)} / 実測 ${formatRatePerMinute(
    summary.actualOrdersPerMinute
  )}`;
}

/**
 * 滞留の増加率を表示する（design §2.4。要件 20.2）。
 *
 * 滞留しない場合（`A ≤ C`）は 0 ではなく余力を出す。
 * 「増加率 0 件/分」は均衡と余剰の区別が付かないためである。
 */
export function formatBacklogGrowth(backlog: BacklogProjection | null): string {
  if (backlog === null) {
    return EMPTY_VALUE;
  }
  if (backlog.regime === "GROWING" || backlog.regime === "STALLED") {
    return `+${formatRatePerMinute(backlog.backlogGrowthPerMinute)}`;
  }
  if (backlog.regime === "STEADY") {
    return "均衡（滞留せず）";
  }
  return `余力 ${formatRatePerMinute(backlog.surplusCapacityPerMinute)}`;
}

/**
 * データロス猶予時間を表示する（design §2.4。要件 20.3）。
 *
 * 滞留しない行（`secondsUntilDataLoss === null`）は「—」ではなく
 * 「発生しない」と書く。空欄は「算出できなかった」と紛れる。
 */
export function formatDataLossGrace(backlog: BacklogProjection | null): string {
  if (backlog === null) {
    return EMPTY_VALUE;
  }
  if (backlog.secondsUntilDataLoss === null) {
    return "発生しない";
  }
  return formatDurationSeconds(backlog.secondsUntilDataLoss);
}

/** 回復時間（予測）を表示する（要件 20.4） */
export function formatRecoveryTime(seconds: number | null): string {
  if (seconds === null) {
    return EMPTY_VALUE;
  }
  if (seconds === 0) {
    return "滞留なし";
  }
  return formatDurationSeconds(seconds);
}

/**
 * 秒数を「時間・分・秒」で表示する。
 *
 * 猶予時間は 12 時間（design §2.4 の数値例）から数分までの幅を取る。
 * `formatElapsedMs` はミリ秒起点で時の桁を持たないため、
 * この桁のためだけに別の書式を用意している。
 */
export function formatDurationSeconds(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return EMPTY_VALUE;
  }
  if (seconds < 60) {
    return `${(Math.floor(seconds * 10) / 10).toFixed(1)} 秒`;
  }
  if (seconds < 3_600) {
    const minutes = Math.floor(seconds / 60);
    const rest = Math.floor(seconds % 60);
    return `${minutes} 分 ${rest} 秒`;
  }
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${formatCount(hours)} 時間 ${minutes} 分`;
}

/** 算術の可否をセルの文字にする */
export function formatArithmeticAvailability(row: ComparisonRow): string {
  return row.blockedReason === null
    ? ARITHMETIC_USABLE_LABEL
    : ARITHMETIC_BLOCK_LABELS[row.blockedReason];
}

// ─── 永続化の状態の案内 ────────────────────────────────────────────

/**
 * 保存結果の案内文（design §11.4）。完全版で保存できたときは `null`。
 *
 * 何も言わないのは完全版で保存できた場合だけにする。軽量版に落ちたことも
 * 保存できなかったことも、**次に画面を開いたときの見え方が変わる**ため
 * 検証者に伝える必要がある。とくに軽量版では生データが落ちるので、
 * 失敗した実行の理由が後から読めなくなる。
 */
export function describeSaveResult(result: MeasurementSaveResult): string | null {
  switch (result.kind) {
    case "SAVED":
      if (result.mode === "FULL") {
        return null;
      }
      return result.droppedCount === 0
        ? `保存容量に収まらなかったため、生データを落とした軽量版で保存しました（${result.storedCount} 件）。実行の詳細（失敗理由・時刻）は再読み込み後に表示できません。比較表の列は保持されます。`
        : `保存容量に収まらなかったため、生データを落とし、新しい ${result.storedCount} 件だけを保存しました（${result.droppedCount} 件は保存されていません）。`;
    case "UNAVAILABLE":
      return "このブラウザでは計測結果を保存できません（プライベートモードなどでストレージが使えません）。この画面を離れると比較表の内容は失われます。";
    case "FAILED":
      return result.reason === "QUOTA"
        ? `保存容量が不足しており、軽量版でも保存できませんでした（${result.message}）。不要な行を削除してください。`
        : `計測結果の保存に失敗しました（${result.message}）。この画面を離れると比較表の内容は失われます。`;
  }
}

/**
 * 読み込み結果の案内文。正常なら `null`。
 *
 * 壊れた値を黙って捨てると「保存したはずの行が消えた」ようにしか見えない。
 * 捨てたことと件数を出す。
 */
export function describeLoadResult(result: MeasurementLoadResult): string | null {
  if (result.problem === "UNAVAILABLE") {
    return "このブラウザでは保存済みの計測結果を読み込めません（プライベートモードなどでストレージが使えません）。";
  }
  if (result.problem === "CORRUPT") {
    return "保存されていた計測結果を読み込めなかったため、破棄して空の状態から始めます。";
  }
  const notes: string[] = [];
  if (result.skippedCount > 0) {
    notes.push(`形式が合わない ${result.skippedCount} 件を読み飛ばしました。`);
  }
  if (result.light) {
    notes.push(
      "保存容量の都合で軽量版として保存されていたため、一部の行は生データ（失敗理由・時刻の詳細）を持ちません。"
    );
  }
  return notes.length === 0 ? null : notes.join(" ");
}
