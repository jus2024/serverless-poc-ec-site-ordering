/**
 * 負荷生成 / 並行計測の開始と実行状態表示のロジック（純粋関数。要件 14.3 / 14.5）。
 *
 * ## なぜコンポーネントから切り出すか
 *
 * `order-progress.ts` / `order-form.ts` と同じ方針（`.kiro/steering/testing.md` の
 * 「最も狭い範囲の検証を最初に実行する」）。Vitest は `environment: "node"` のままで、
 * DOM を必要とするテストは持ち込まない（design Testing Strategy）。
 * このタブで判断を要するのは次の 3 つで、いずれも DOM に依存しない。
 *
 * | 判断 | 関数 | 理由 |
 * |------|------|------|
 * | パラメータが上限内か | `parseOrdersPerMinuteInput` 他 | 上限は `GET /config` 由来。誤ると 400 か課金事故になる |
 * | ポーリングを続けるか | `shouldContinuePolling` | 止め忘れると計測対象に自分の照会が混ざる |
 * | 実行結果をどう読むか | `deriveLoadTestProgress` / `deriveQueryImpactProgress` | 乖離警告（要件 11.11）とエラー率の分母 |
 *
 * ## 上限をこのモジュールに焼き込まない（要件 10.6）
 *
 * `maxOrdersPerMinute` / `maxDurationSeconds` / `maxMeasureConcurrency` は
 * デプロイ済みの Lambda 環境変数で決まり、`GET /config` の `limits` として届く。
 * 画面に定数として持つと、デプロイ済みの設定と画面の許容範囲が食い違い、
 * 「画面は通したのに 400 が返る」あるいは逆の状態になる。上限は引数で受け取り、
 * 未取得（`null`）なら**検証できないものとして弾く**。
 * 下限（1）だけは Lambda 側と同じ値を持つ（`MIN_*`）。0 件/分・0 並行の実行は
 * どの設定でも成立しないため、設定に依存しない。
 *
 * ## `ordersPerMinute` / `durationSeconds` / `concurrency` に既定値を置かない
 *
 * 開始 API はこれらを**必須**にしている（`load-test-request.ts` /
 * `measure-request.ts` の注記）。負荷生成は課金の支配要因（design §7.3）であり、
 * 「何件/分を何秒流すのか」は検証者が毎回明示する。画面側で既定値を補うと
 * その設計が無効になるため、空欄は補完せず入力を促す。
 */

import type { FailureNotice } from "./order-api-failure";
import type { ParsedField } from "./order-form";
import { EMPTY_VALUE, formatCount } from "./order-progress";
import type {
  ExecutionStatus,
  ExecutionType,
  LoadTestStatusResponse,
  QueryImpactStatusResponse,
} from "../../lib/orders/types";

// ─── 実行の状態 ───────────────────────────────────────────────────

/** 実行種別の日本語表示 */
export const EXECUTION_TYPE_LABELS: Record<ExecutionType, string> = {
  LOAD_TEST: "負荷生成",
  QUERY_IMPACT: "並行計測",
};

/** 実行状態の日本語表示 */
export const EXECUTION_STATUS_LABELS: Record<ExecutionStatus, string> = {
  RUNNING: "実行中",
  COMPLETED: "完了",
  FAILED: "失敗",
};

/** 実行状態に対応するバッジのクラス（`src/app/globals.css` のトークン） */
export function executionStatusBadgeClass(status: ExecutionStatus): string {
  if (status === "COMPLETED") {
    return "badge badge-completed";
  }
  if (status === "FAILED") {
    return "badge badge-failed";
  }
  return "badge badge-running";
}

/**
 * これ以上変化しない実行状態か。
 *
 * 開始 API は 202 を返して実行 ID だけを渡し、投入・計測は非同期に続く
 * （要件 11.9 / 12.1）。したがって画面は `GET /executions/{id}` を
 * 繰り返し取得するしかないが、`COMPLETED` / `FAILED` に達したレコードは
 * それ以降更新されない（`execution-record.ts` の更新式）。
 */
export function isTerminalExecutionStatus(status: ExecutionStatus): boolean {
  return status === "COMPLETED" || status === "FAILED";
}

/**
 * ポーリングを続けるかを判定する。
 *
 * 終端に達したら止める。止めないと、もう変化しない実行レコードを
 * 数秒間隔で照会し続けることになる。並行計測は照会 API のレイテンシを
 * 測る装置（要件 12.1）なので、画面のポーリングが同じ API Gateway に
 * 乗り続けると測定対象そのものを歪める。
 *
 * まだ 1 度も取得できていない（`null`）場合は続ける。開始直後は
 * 取得が終わっていないだけで、状態が分からないことと終わったことは違う。
 */
export function shouldContinuePolling(execution: { status: ExecutionStatus } | null): boolean {
  if (execution === null) {
    return true;
  }
  return !isTerminalExecutionStatus(execution.status);
}

/**
 * 照会した実行が期待した種別でなかったときの案内（design §E-1 の注記）。
 *
 * 実行管理テーブルは負荷生成と並行計測で共有しており（design §4.3）、
 * `GET /executions/{id}` はどちらも返す。負荷テストのパネルに
 * `MEASURE#...` を貼られた場合、`executionType` を見ずに描くと
 * 投入件数の欄に空欄が並ぶだけで、原因が分からない。
 * 404（`EXECUTION_NOT_FOUND`）とも区別して案内する。
 */
export function describeExecutionTypeMismatch(
  expected: ExecutionType,
  actual: ExecutionType
): FailureNotice {
  return {
    title: `${EXECUTION_TYPE_LABELS[expected]}の実行 ID ではありません`,
    message: `指定した実行 ID は${EXECUTION_TYPE_LABELS[actual]}の実行です。${EXECUTION_TYPE_LABELS[expected]}の実行 ID を指定してください。`,
    hint: `負荷生成の実行 ID は \`LOAD#\`、並行計測の実行 ID は \`MEASURE#\` で始まります。`,
    isConfigError: false,
    retryable: false,
    reference: `executionType: ${actual}`,
  };
}

// ─── パラメータの検証（上限は `GET /config` 由来）───────────────────

/** 投入レートの下限（件/分。`load-test-request.ts` の `MIN_ORDERS_PER_MINUTE`） */
export const MIN_ORDERS_PER_MINUTE = 1;

/** 継続時間の下限（秒。`load-test-request.ts` / `measure-request.ts` と同じ） */
export const MIN_DURATION_SECONDS = 1;

/** 並行数の下限（`measure-request.ts` の `MIN_CONCURRENCY`） */
export const MIN_CONCURRENCY = 1;

/** ID の長さの上限（`order-form.ts` と同じ出典。`order-keys.ts` の `MAX_ID_LENGTH`） */
export const MAX_ID_LENGTH = 128;

/** 上限が未取得であることを伝える案内（`GET /config` を取得できていない状態） */
const LIMITS_UNAVAILABLE_ISSUE =
  "上限を取得できていないため検証できません。検証パラメータ（GET /config）を再読み込みしてください。";

interface BoundedIntegerInput {
  raw: string;
  label: string;
  min: number;
  /** `GET /config` の `limits` から渡す。未取得なら null */
  max: number | null;
  /** 単位（案内文に添える） */
  unit: string;
}

/**
 * 必須の整数パラメータを検証する。
 *
 * 判定の順序と文言は Lambda 側（`requireBoundedInteger`）に合わせてある。
 * 画面で弾いた誤りと API が弾いた誤りが違う言い方で出ると、
 * 検証者は「どちらが本当の制約か」を確かめ直すことになる。
 */
function parseBoundedIntegerInput(input: BoundedIntegerInput): ParsedField<number> {
  const { raw, label, min, max, unit } = input;
  const trimmed = raw.trim();

  if (trimmed === "") {
    // API 側に既定値が無い（このモジュールの冒頭の注記）ため、空欄は補完しない
    return { ok: false, issue: `${label}を入力してください。` };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, issue: `${label}は整数で入力してください。` };
  }

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    return { ok: false, issue: `${label}が大きすぎます。` };
  }
  if (max === null) {
    return { ok: false, issue: LIMITS_UNAVAILABLE_ISSUE };
  }
  if (value < min || value > max) {
    return {
      ok: false,
      issue: `${label}は ${formatCount(min)}〜${formatCount(max)} ${unit}の範囲で指定してください。`,
    };
  }

  return { ok: true, value };
}

/** 目標投入レートを検証する（上限は `limits.maxOrdersPerMinute`。要件 11.1 / 10.6） */
export function parseOrdersPerMinuteInput(
  raw: string,
  maxOrdersPerMinute: number | null
): ParsedField<number> {
  return parseBoundedIntegerInput({
    raw,
    label: "目標投入レート",
    min: MIN_ORDERS_PER_MINUTE,
    max: maxOrdersPerMinute,
    unit: "件/分",
  });
}

/** 継続時間を検証する（上限は `limits.maxDurationSeconds`。要件 10.6） */
export function parseDurationSecondsInput(
  raw: string,
  maxDurationSeconds: number | null
): ParsedField<number> {
  return parseBoundedIntegerInput({
    raw,
    label: "継続時間",
    min: MIN_DURATION_SECONDS,
    max: maxDurationSeconds,
    unit: "秒",
  });
}

/** 並行数を検証する（上限は `limits.maxMeasureConcurrency`。要件 12.7 / 10.6） */
export function parseConcurrencyInput(
  raw: string,
  maxMeasureConcurrency: number | null
): ParsedField<number> {
  return parseBoundedIntegerInput({
    raw,
    label: "並行数",
    min: MIN_CONCURRENCY,
    max: maxMeasureConcurrency,
    unit: "並行",
  });
}

/**
 * 追跡する実行 ID の入力を検証する。
 *
 * 形式（`LOAD#` / `MEASURE#`）までは検査しない。`parseOrderIdInput`
 * （`order-form.ts`）と同じ理由で、画面が先に弾くと
 * 「API が 404 を返した」のか「画面が弾いた」のかが分からなくなる。
 * 種別の取り違えは応答の `executionType` で判定する
 * （`describeExecutionTypeMismatch`）。
 */
export function parseExecutionIdInput(raw: string): ParsedField<string> {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, issue: "実行 ID を入力してください。" };
  }
  if (trimmed.length > MAX_ID_LENGTH) {
    return { ok: false, issue: `実行 ID は ${MAX_ID_LENGTH} 文字までです。` };
  }
  return { ok: true, value: trimmed };
}

/**
 * 省略可能な ID の入力を検証する（`loadTestId` / `orderId` / `customerId`）。
 *
 * 空欄は「未指定」として `undefined` を返す。空文字を送ると API 側が
 * 未指定として扱う（`readOptionalId`）ものの、送らないほうが
 * リクエストの意図が明確になる。
 */
export function parseOptionalIdInput(raw: string, label: string): ParsedField<string | undefined> {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: true, value: undefined };
  }
  if (trimmed.length > MAX_ID_LENGTH) {
    return { ok: false, issue: `${label}は ${MAX_ID_LENGTH} 文字までです。` };
  }
  return { ok: true, value: trimmed };
}

// ─── 投入計画の事前確認（コスト）───────────────────────────────────

/**
 * 負荷カーブの区間の割合（design 論点 2 / 要件 11.2）。
 *
 * 出典は `amplify/functions/shared/load-curve.ts` であり、`types.ts` と
 * 同じ理由で **import しない**（要件 18.6）。画面側がこれを持つのは
 * 「カーブ実行では何件入るのか」を送信前に出すため（`previewLoadTestPlan`）で、
 * 投入レートそのものを画面が決めるわけではない。
 *
 * **カーブの定義を変えるときは両方を更新すること。**
 */
const RAMP_UP_FRACTION = 0.3;
const PEAK_FRACTION = 0.4;
const RAMP_DOWN_FRACTION = 0.3;

/**
 * 負荷カーブでの平均係数（`load-plan.ts` の `AVERAGE_RAMP_FACTOR` と同じ導出）。
 *
 * 漸増区間の平均 0.5、ピーク 1、漸減区間の平均 0.5 の加重平均で 0.7 になる。
 * 区間の割合から導出しているので、カーブの定義を変えればここも追随する。
 */
export const AVERAGE_RAMP_FACTOR =
  RAMP_UP_FRACTION / 2 + PEAK_FRACTION + RAMP_DOWN_FRACTION / 2;

/** 開始前に提示する投入計画（課金の事前確認） */
export interface LoadTestPlanPreview {
  /** 目標投入レート（件/分）。カーブではピーク値 */
  peakOrdersPerMinute: number;
  durationSeconds: number;
  useRampCurve: boolean;
  /** この実行条件で期待される平均レート（件/分。`expectedOrdersPerMinute` と同じ定義） */
  expectedOrdersPerMinute: number;
  /** 投入される見込みの注文件数（期待平均レート × 継続時間） */
  estimatedOrderCount: number;
}

/**
 * 投入計画を組み立てる（開始前の事前確認。design §7.3）。
 *
 * 負荷生成は**実際の AWS 課金**を発生させる。目標レートの入力欄には
 * 16,000 まで入るため（軸 B のシナリオ。design §10.2）、
 * 桁を 1 つ間違えた実行がそのまま流れると課金額も 1 桁変わる。
 * 「レート × 継続時間で何件入るのか」を送信前に画面へ出すのは、
 * 桁の誤りを件数の側から気づけるようにするためである。
 *
 * 見込み件数は**期待平均レート**から算出する。カーブ実行（要件 11.2）は
 * ピークレートが継続時間の 40% しか続かないため、ピークレートで
 * 掛け算すると実際より 3 割多い件数を提示することになる。
 */
export function previewLoadTestPlan(input: {
  ordersPerMinute: number;
  durationSeconds: number;
  useRampCurve: boolean;
}): LoadTestPlanPreview {
  const expectedOrdersPerMinute = input.useRampCurve
    ? input.ordersPerMinute * AVERAGE_RAMP_FACTOR
    : input.ordersPerMinute;

  return {
    peakOrdersPerMinute: input.ordersPerMinute,
    durationSeconds: input.durationSeconds,
    useRampCurve: input.useRampCurve,
    expectedOrdersPerMinute: roundTo(expectedOrdersPerMinute, 1),
    estimatedOrderCount: Math.round((expectedOrdersPerMinute * input.durationSeconds) / 60),
  };
}

/** `GET /config` の `limits` のうち負荷生成に関わる 2 つ */
export interface LoadTestLimitsView {
  maxOrdersPerMinute: number;
  maxDurationSeconds: number;
}

/**
 * 入力欄の値から投入計画を組み立てる。両方が有効でなければ `null`。
 *
 * 事前確認の表示と送信時の検証で同じ判定を使うため、入力の解析ごと
 * ここに寄せてある。上限を満たさない入力では計画を出さない
 * （入力欄側にその旨の指摘が出る）。
 */
export function previewLoadTestPlanFromInputs(input: {
  ordersPerMinuteInput: string;
  durationSecondsInput: string;
  useRampCurve: boolean;
  limits: LoadTestLimitsView | null;
}): LoadTestPlanPreview | null {
  const ordersPerMinute = parseOrdersPerMinuteInput(
    input.ordersPerMinuteInput,
    input.limits?.maxOrdersPerMinute ?? null
  );
  const durationSeconds = parseDurationSecondsInput(
    input.durationSecondsInput,
    input.limits?.maxDurationSeconds ?? null
  );

  if (!ordersPerMinute.ok || !durationSeconds.ok) {
    return null;
  }

  return previewLoadTestPlan({
    ordersPerMinute: ordersPerMinute.value,
    durationSeconds: durationSeconds.value,
    useRampCurve: input.useRampCurve,
  });
}

// ─── 実行状態の導出 ────────────────────────────────────────────────

/** 負荷生成の実行状態の表示用データ（要件 11.6 / 11.11） */
export interface LoadTestProgressView {
  status: ExecutionStatus;
  statusLabel: string;
  /** 継続時間に対する経過の割合（0〜100 の整数）。算出できなければ null */
  progressPercent: number | null;
  submittedCount: number;
  submitErrorCount: number;
  /** 投入を試みた総数（成功 + 失敗）。エラー率の分母 */
  attemptedCount: number;
  /** 投入エラー率（0〜1）。試行 0 件なら null */
  submitErrorRate: number | null;
  /** 目標投入レート（件/分）。カーブではピーク値 */
  targetOrdersPerMinute: number;
  /** この実行条件で期待される平均レート（件/分） */
  expectedOrdersPerMinute: number;
  /** 実行レコードに記録された実測レート（件/分）。完了まで null（要件 11.11） */
  actualOrdersPerMinute: number | null;
  /**
   * 実行中の暫定レート（件/分）。投入件数 ÷ 経過時間。
   *
   * 記録された実測レートとは別に持つ。完了前に「目標に届いていない」ことに
   * 気づけるようにするためだが、実行レコードの値ではないので
   * §2.4 の算術には使わない（Property 11）。
   */
  interimOrdersPerMinute: number | null;
  /** 期待レートに対する達成率（0〜1）。実測レートが無ければ null */
  rateAchievement: number | null;
  /** 目標との乖離警告（要件 11.11）。未評価（実行中・失敗）は null */
  rateDeviationWarning: boolean | null;
}

/**
 * 負荷生成の実行レコードから表示用データを組み立てる（要件 11.6 / 11.11）。
 *
 * 実測レート（`actualOrdersPerMinute`）と乖離警告
 * （`rateDeviationWarning`）は `null` のまま持ち回る。実行中は
 * まだ評価されていない（`execution-record.ts` の注記）ため、
 * 0 や false に丸めると「乖離が無かった」と読めてしまう。
 */
export function deriveLoadTestProgress(
  execution: LoadTestStatusResponse
): LoadTestProgressView {
  const attemptedCount = execution.submittedCount + execution.submitErrorCount;
  const expectedOrdersPerMinute = execution.useRampCurve
    ? execution.targetOrdersPerMinute * AVERAGE_RAMP_FACTOR
    : execution.targetOrdersPerMinute;

  return {
    status: execution.status,
    statusLabel: EXECUTION_STATUS_LABELS[execution.status],
    progressPercent: deriveProgressPercent(execution.elapsedMs, execution.durationSeconds),
    submittedCount: execution.submittedCount,
    submitErrorCount: execution.submitErrorCount,
    attemptedCount,
    submitErrorRate: attemptedCount === 0 ? null : execution.submitErrorCount / attemptedCount,
    targetOrdersPerMinute: execution.targetOrdersPerMinute,
    expectedOrdersPerMinute: roundTo(expectedOrdersPerMinute, 1),
    actualOrdersPerMinute: execution.actualOrdersPerMinute,
    interimOrdersPerMinute: derivePerMinute(execution.submittedCount, execution.elapsedMs),
    rateAchievement:
      execution.actualOrdersPerMinute === null || expectedOrdersPerMinute <= 0
        ? null
        : execution.actualOrdersPerMinute / expectedOrdersPerMinute,
    rateDeviationWarning: execution.rateDeviationWarning,
  };
}

/** 並行計測の結果の表示用データ（要件 12.2 / 12.3 / 12.5） */
export interface QueryImpactProgressView {
  status: ExecutionStatus;
  statusLabel: string;
  progressPercent: number | null;
  concurrency: number;
  /** 送信したリクエスト総数。エラー率の分母（開始直後は 0） */
  requestCount: number;
  /** スロットル（429 / `TooManyRequestsException`。要件 12.2） */
  throttleCount: number;
  otherErrorCount: number;
  /** スロットルとその他の合計 */
  errorCount: number;
  successCount: number;
  /** エラー率（0〜1）。リクエスト 0 件なら null */
  errorRate: number | null;
  /** スロットル率（0〜1）。リクエスト 0 件なら null */
  throttleRate: number | null;
  /** 実測スループット（件/秒）。算出できなければ null */
  requestsPerSecond: number | null;
}

/**
 * 並行計測の実行レコードから表示用データを組み立てる。
 *
 * エラー率の分母を `requestCount` に固定しているのは、要件 12.2 の
 * 「スロットルを他のエラーと区別する」を率でも保つためである。
 * スロットル率とその他のエラー率を別に出さないと、
 * 429 が 1 件も出ていない実行と 429 だけで埋まった実行が
 * 同じ「エラー率 10%」として並ぶ。
 */
export function deriveQueryImpactProgress(
  execution: QueryImpactStatusResponse
): QueryImpactProgressView {
  const errorCount = execution.throttleCount + execution.otherErrorCount;
  const hasRequests = execution.requestCount > 0;

  return {
    status: execution.status,
    statusLabel: EXECUTION_STATUS_LABELS[execution.status],
    progressPercent: deriveProgressPercent(execution.elapsedMs, execution.durationSeconds),
    concurrency: execution.concurrency,
    requestCount: execution.requestCount,
    throttleCount: execution.throttleCount,
    otherErrorCount: execution.otherErrorCount,
    errorCount,
    // エラー件数が総数を超える応答は想定しないが、負の成功件数は出さない
    successCount: Math.max(0, execution.requestCount - errorCount),
    errorRate: hasRequests ? errorCount / execution.requestCount : null,
    throttleRate: hasRequests ? execution.throttleCount / execution.requestCount : null,
    requestsPerSecond: derivePerSecond(execution.requestCount, execution.elapsedMs),
  };
}

/** 継続時間に対する経過の割合（0〜100 の整数）。`aria-valuenow` に使う */
function deriveProgressPercent(
  elapsedMs: number | null,
  durationSeconds: number
): number | null {
  if (elapsedMs === null || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return null;
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return null;
  }
  // 実行は継続時間をわずかに超えて終わる（最後のループ分）。100 で止める
  const ratio = elapsedMs / (durationSeconds * 1_000);
  return Math.min(100, Math.round(ratio * 100));
}

/** 件数と経過ミリ秒から毎分レートを求める。算出できなければ null */
function derivePerMinute(count: number, elapsedMs: number | null): number | null {
  if (elapsedMs === null || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return null;
  }
  if (!Number.isFinite(count) || count < 0) {
    return null;
  }
  return roundTo((count * 60_000) / elapsedMs, 1);
}

/** 件数と経過ミリ秒から毎秒レートを求める。算出できなければ null */
function derivePerSecond(count: number, elapsedMs: number | null): number | null {
  if (elapsedMs === null || !Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return null;
  }
  if (!Number.isFinite(count) || count < 0) {
    return null;
  }
  return roundTo((count * 1_000) / elapsedMs, 1);
}

/** 小数桁を丸める（浮動小数の桁を画面に出さないため） */
function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ─── 書式 ────────────────────────────────────────────────────────

/**
 * レートを「件/分」で表示する。
 *
 * 小数第 1 位まで出すのは、低レート（2 件/分）のシナリオで整数に丸めると
 * 意味のある差が消えるためである（Lambda 側の `roundRate` と同じ理由）。
 */
export function formatRatePerMinute(value: number | null | undefined): string {
  const formatted = formatDecimal(value, 1);
  return formatted === EMPTY_VALUE ? EMPTY_VALUE : `${formatted} 件/分`;
}

/** スループットを「件/秒」で表示する */
export function formatRatePerSecond(value: number | null | undefined): string {
  const formatted = formatDecimal(value, 1);
  return formatted === EMPTY_VALUE ? EMPTY_VALUE : `${formatted} 件/秒`;
}

/** 秒数を「N 秒」で表示する（設定値としての継続時間） */
export function formatSeconds(value: number | null | undefined): string {
  const formatted = formatCount(value);
  return formatted === EMPTY_VALUE ? EMPTY_VALUE : `${formatted} 秒`;
}

/**
 * 比率を百分率で表示する（0.1234 → `12.3%`）。
 *
 * エラー率とレートの達成率に使う。`null`（分母が 0 で算出できない）は
 * `0%` に丸めない。「エラーが無かった」と「まだ 1 件も送っていない」は違う。
 */
export function formatPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) {
    return EMPTY_VALUE;
  }
  const formatted = formatDecimal(ratio * 100, 1);
  return formatted === EMPTY_VALUE ? EMPTY_VALUE : `${formatted}%`;
}

/** 小数を 3 桁区切りで表示する（`formatCount` の小数版） */
function formatDecimal(value: number | null | undefined, digits: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return EMPTY_VALUE;
  }
  const fixed = Math.abs(value).toFixed(digits);
  const [integerPart, fractionPart] = fixed.split(".");
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = value < 0 ? "-" : "";
  return fractionPart === undefined ? `${sign}${grouped}` : `${sign}${grouped}.${fractionPart}`;
}
