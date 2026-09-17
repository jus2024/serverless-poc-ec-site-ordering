/**
 * 計測結果の永続化（`localStorage`。design §11.4。要件 14.6）。
 *
 * ## なぜ保存するのか
 *
 * 比較の対象はシナリオ A0〜A8 / B0〜B4（design §10.2）であり、
 * **シナリオ間の差が本 Spec の成果物**である（要件 14.6）。
 * ところがシナリオの一部は PF や擬似処理時間を変えて**再デプロイ**を伴い、
 * 軸 B では warm throughput の引き上げも挟む。1 回の画面セッションで
 * 全シナリオを流し切ることはできないので、実行レコードのスナップショットを
 * ブラウザ側に残さないと比較表が成立しない。
 *
 * 保存するのは実行レコード（`GET /executions/{id}`）のスナップショットであり、
 * 算出値は保存しない。滞留の増加率や猶予時間は `capacity.ts` の式で
 * 表示時に導出する（`measurement-comparison.ts`）。式を直したときに
 * 保存済みの行が古い値のまま残らないようにするためである。
 *
 * ## 容量超過時は軽量版で再試行する（design §11.4）
 *
 * `localStorage` の上限（多くのブラウザで 5 MB 前後）に達すると
 * `setItem` が `QuotaExceededError` を投げる。このとき**保存を諦めない**。
 * 生データ（実行レコードの完全なスナップショット）を落とし、
 * 比較表が必要とする列（design §11.2）だけに削った軽量版で書き直す。
 * 併せて保持件数を {@link LIGHT_MAX_STORED_RUNS} 件まで絞る。
 *
 * 軽量版で落ちるのは次のもので、いずれも比較表の列ではない。
 *
 * | 落ちるもの | 影響 |
 * |-----------|------|
 * | 実行の開始/終了時刻、経過時間 | 保存時刻（`savedAt`）は残るので並び順は保たれる |
 * | `errorMessage` | 失敗した実行の理由が読めなくなる。状態（`FAILED`）は残る |
 * | 投入件数 / 投入エラー件数 | 実測レートは残るので §2.4 の算術には影響しない |
 * | 上限を超えた古い実行 | 新しいものから {@link LIGHT_MAX_STORED_RUNS} 件を残す |
 *
 * 逆に軽量版でも必ず残すのは design §11.2 の列、すなわち S / P / D /
 * 算出した消費能力 / 目標・実測投入レート / 乖離警告 / レイテンシ分位点 /
 * スロットル件数である。**乖離警告（要件 11.11）を落とすと、
 * 算術に使えない行を使えるものとして並べてしまう**（Property 11）。
 *
 * ## `localStorage` が使えない環境を壊れた状態にしない
 *
 * サーバ側描画（`localStorage` が存在しない）、プライベートモード、
 * Cookie をブロックした設定では、参照そのものが例外を投げることがある。
 * この層は例外を外に漏らさず「保存できない」という状態として返し、
 * 画面は比較表をメモリ上だけで動かす（`resolveMeasurementStorage`）。
 *
 * DOM に触らないため単体テストの対象にできる（`vitest.config.ts`）。
 * テストからは素のオブジェクトで `StorageLike` を差し替える。
 */

import type {
  ExecutionStatus,
  ExecutionStatusResponse,
  ExecutionType,
  LatencyPercentiles,
  StageDelaysMs,
} from "../../lib/orders/types";
import { EXECUTION_TYPES } from "../../lib/orders/types";

// ─── 保存先と上限 ─────────────────────────────────────────────────

/**
 * `localStorage` のキー。
 *
 * スキーマ版をキーに含める。形を変えたときに古い値を読もうとして
 * 壊れるより、別のキーとして無視されたほうが被害が小さい。
 */
export const MEASUREMENT_STORAGE_KEY = "kiro-roasters.order-pipeline.measurements.v1";

/** 保存形式の版。読み込み時に一致しなければ捨てる */
export const MEASUREMENT_SCHEMA_VERSION = 1;

/**
 * 保存する実行の上限件数。
 *
 * 軸 A（9 シナリオ）+ 軸 B（5 シナリオ）+ 並行計測を各シナリオに 1 回で
 * 30 件弱。再実行の余裕を含めて 50 件にしている。
 */
export const MAX_STORED_RUNS = 50;

/** 軽量版で残す件数（容量超過時。design §11.4） */
export const LIGHT_MAX_STORED_RUNS = 10;

/**
 * ラベル（シナリオ名）の最大長。
 *
 * `A3: PF=10 / D=3.6s` のような短い識別を想定している。
 * 長文を貼られると保存容量を無駄に食う。
 */
export const MAX_RUN_LABEL_LENGTH = 60;

// ─── 保存する値 ───────────────────────────────────────────────────

/**
 * 比較表（design §11.2）が必要とする値だけを実行レコードから写したもの。
 *
 * 種別ごとにしか存在しない値は `null` を取る（負荷生成に分位点は無く、
 * 並行計測に投入レートは無い）。`executionType` で分岐せずに
 * 1 つの表へ並べるための形である。
 */
export interface MeasurementSummary {
  executionId: string;
  executionType: ExecutionType;
  status: ExecutionStatus;
  durationSeconds: number;

  // ── 実行条件（design §11.2 の S / P / D / 消費能力）
  /** S: オープンシャード数。取得に失敗した実行は null（要件 19.5） */
  openShardCount: number | null;
  shardCountError: string | null;
  /** P: 並列化係数 */
  parallelizationFactor: number;
  /** D の内訳（擬似待機を持つのは決済と通知のみ） */
  stageDelaysMs: StageDelaysMs;
  /** `S × P ÷ D` の算出値（件/分）。S が取れなかった実行は null（要件 19.3） */
  estimatedCapacityPerMinute: number | null;
  warmThroughputWrite: number | null;

  // ── 負荷生成のみ
  /** 目標投入レート（件/分）。カーブではピーク値 */
  targetOrdersPerMinute: number | null;
  /** 実測投入レート（件/分）。完了まで null（要件 11.11） */
  actualOrdersPerMinute: number | null;
  /** 目標との乖離警告（要件 11.11）。未評価は null。**軽量版でも必ず残す** */
  rateDeviationWarning: boolean | null;
  useRampCurve: boolean | null;

  // ── 並行計測のみ
  concurrency: number | null;
  latencyPercentiles: LatencyPercentiles | null;
  /** スロットル件数（429 / `TooManyRequestsException`。要件 12.2） */
  throttleCount: number | null;
  otherErrorCount: number | null;
  requestCount: number | null;
  /** 並行して走っていた負荷生成の実行 ID（要件 12.5） */
  loadTestId: string | null;
}

/**
 * 比較表に並べる 1 実行分。
 *
 * `execution` は生データ（実行レコードの完全なスナップショット）で、
 * 軽量版として保存された行、あるいは軽量版から読み込んだ行では `null` になる。
 * 比較表の列は `summary` だけで揃うため、`execution` は
 * 失敗理由や時刻の詳細表示にのみ使う。
 */
export interface MeasurementRun {
  /** 保存時刻（ISO 8601）。表の並び順の基準 */
  savedAt: string;
  /** シナリオ名。未入力なら null */
  label: string | null;
  summary: MeasurementSummary;
  /** 生データ。軽量版では null（design §11.4） */
  execution: ExecutionStatusResponse | null;
}

// ─── 保存形式（JSON）──────────────────────────────────────────────

/**
 * `localStorage` に書く 1 件の形。
 *
 * `execution` と `summary` はどちらか一方だけを書く。両方書くと
 * 同じ値を二重に持つことになり、容量を守るという目的に反する。
 * 読み込み時は `execution` があればそこから `summary` を導出し、
 * 無ければ書かれている `summary` を使う。
 */
interface PersistedRun {
  savedAt: string;
  label: string | null;
  /** 完全な実行レコード（生データ）。軽量版では書かない */
  execution?: ExecutionStatusResponse;
  /** design §11.2 の列だけ。軽量版で `execution` の代わりに書く */
  summary?: MeasurementSummary;
}

/** `localStorage` に書く全体の形 */
interface PersistedStore {
  version: number;
  /** 軽量版で書かれたか（読み込み側の案内に使う） */
  light: boolean;
  runs: PersistedRun[];
}

// ─── 実行レコードから写す ──────────────────────────────────────────

/**
 * 実行レコードから比較表用の値を写す。
 *
 * 種別ごとの値は `executionType` で分岐して取る。ここで
 * `rateDeviationWarning` を落とさないことが要件 11.11 の要点である。
 */
export function summarizeExecution(execution: ExecutionStatusResponse): MeasurementSummary {
  const { conditions } = execution;
  const base = {
    executionId: execution.executionId,
    executionType: execution.executionType,
    status: execution.status,
    durationSeconds: execution.durationSeconds,
    openShardCount: conditions.openShardCount,
    shardCountError: conditions.shardCountError,
    parallelizationFactor: conditions.parallelizationFactor,
    stageDelaysMs: conditions.stageDelaysMs,
    estimatedCapacityPerMinute: conditions.estimatedCapacityPerMinute,
    warmThroughputWrite: conditions.warmThroughputWrite,
  };

  if (execution.executionType === "LOAD_TEST") {
    return {
      ...base,
      targetOrdersPerMinute: execution.targetOrdersPerMinute,
      actualOrdersPerMinute: execution.actualOrdersPerMinute,
      rateDeviationWarning: execution.rateDeviationWarning,
      useRampCurve: execution.useRampCurve,
      concurrency: null,
      latencyPercentiles: null,
      throttleCount: null,
      otherErrorCount: null,
      requestCount: null,
      loadTestId: null,
    };
  }

  return {
    ...base,
    targetOrdersPerMinute: null,
    actualOrdersPerMinute: null,
    rateDeviationWarning: null,
    useRampCurve: null,
    concurrency: execution.concurrency,
    latencyPercentiles: execution.latencyPercentiles,
    throttleCount: execution.throttleCount,
    otherErrorCount: execution.otherErrorCount,
    requestCount: execution.requestCount,
    loadTestId: execution.loadTestId,
  };
}

/** ラベル（シナリオ名）の入力を整える。空欄は `null` */
export function normalizeRunLabel(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  return trimmed.length > MAX_RUN_LABEL_LENGTH
    ? trimmed.slice(0, MAX_RUN_LABEL_LENGTH)
    : trimmed;
}

/** 実行レコードから保存対象を組み立てる */
export function createMeasurementRun(input: {
  execution: ExecutionStatusResponse;
  label?: string | null;
  /** 保存時刻。省略時は現在時刻 */
  savedAt?: string;
}): MeasurementRun {
  return {
    savedAt: input.savedAt ?? new Date().toISOString(),
    label: normalizeRunLabel(input.label),
    summary: summarizeExecution(input.execution),
    execution: input.execution,
  };
}

// ─── 一覧の操作 ───────────────────────────────────────────────────

/**
 * 実行を一覧に加える（同じ実行 ID は差し替える）。
 *
 * 実行中に追加した行は実測レートと乖離警告を持たない
 * （`execution-record.ts` は完了時に書く）。完了後に同じ実行 ID を
 * 追加し直せば行が更新されるよう、追加ではなく差し替えにしている。
 *
 * 並びは保存時刻の新しい順。差し替えた行は先頭に移る（今見た行が上に来る）。
 * 上限を超えた分は古いものから落とす。
 */
export function upsertMeasurementRun(
  runs: readonly MeasurementRun[],
  run: MeasurementRun
): MeasurementRun[] {
  const others = runs.filter((entry) => entry.summary.executionId !== run.summary.executionId);
  return [run, ...others].slice(0, MAX_STORED_RUNS);
}

/** 実行を一覧から外す */
export function removeMeasurementRun(
  runs: readonly MeasurementRun[],
  executionId: string
): MeasurementRun[] {
  return runs.filter((entry) => entry.summary.executionId !== executionId);
}

// ─── `localStorage` の入出力 ───────────────────────────────────────

/** `localStorage` のうちこの層が使う操作だけ（テストから差し替えるため） */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * 利用可能な `localStorage` を返す。使えなければ `null`。
 *
 * 参照そのものが例外になる環境（Cookie ブロック時の Chrome など）が
 * あるため `try` で囲む。書き込めるかどうかはここでは判定しない。
 * プローブ用のダミー書き込みは、それ自体が容量を消費するうえ、
 * 「読めるが書けない」状態（プライベートモードの Safari）は
 * 保存時の `QuotaExceededError` として自然に現れる。
 */
export function resolveMeasurementStorage(): StorageLike | null {
  try {
    const candidate = (globalThis as { localStorage?: StorageLike | null }).localStorage;
    if (candidate === null || candidate === undefined) {
      return null;
    }
    // 最低限の形だけ確かめる（差し替えられた実装でも通るように）
    if (typeof candidate.getItem !== "function" || typeof candidate.setItem !== "function") {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

/**
 * 容量超過の例外かどうか。
 *
 * `DOMException` を直接参照しない。この層は Node（Vitest）でも動くし、
 * ブラウザ間で名前もコードも揃っていない。
 *
 * | ブラウザ | `name` | `code` |
 * |---------|--------|--------|
 * | Chrome / Safari | `QuotaExceededError` | 22 |
 * | Firefox | `NS_ERROR_DOM_QUOTA_REACHED` | 1014 |
 */
export function isQuotaExceededError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { name, code } = error as { name?: unknown; code?: unknown };
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") {
    return true;
  }
  return code === 22 || code === 1014;
}

/** 保存の結果 */
export type MeasurementSaveResult =
  /** 保存できた */
  | {
      kind: "SAVED";
      /** `LIGHT` なら生データを落とした軽量版（design §11.4） */
      mode: "FULL" | "LIGHT";
      /** 保存した件数 */
      storedCount: number;
      /** 上限を超えて保存されなかった件数（軽量版で発生する） */
      droppedCount: number;
    }
  /** `localStorage` が使えない（SSR / プライベートモード） */
  | { kind: "UNAVAILABLE" }
  /** 軽量版でも書けなかった */
  | { kind: "FAILED"; reason: "QUOTA" | "ERROR"; message: string };

/**
 * 一覧を保存する。容量超過なら軽量版で再試行する（design §11.4）。
 *
 * 例外は外に出さない。保存に失敗しても比較表はメモリ上で動き続ける
 * （次の再読み込みで消えることを画面が案内する）。
 */
export function saveMeasurementRuns(
  storage: StorageLike | null,
  runs: readonly MeasurementRun[]
): MeasurementSaveResult {
  if (storage === null) {
    return { kind: "UNAVAILABLE" };
  }

  // 空になったらキーを消す。空配列を書き残す意味がない
  if (runs.length === 0) {
    try {
      storage.removeItem(MEASUREMENT_STORAGE_KEY);
      return { kind: "SAVED", mode: "FULL", storedCount: 0, droppedCount: 0 };
    } catch (error) {
      return { kind: "FAILED", reason: "ERROR", message: describeError(error) };
    }
  }

  try {
    storage.setItem(MEASUREMENT_STORAGE_KEY, JSON.stringify(serialize(runs, false)));
    return { kind: "SAVED", mode: "FULL", storedCount: runs.length, droppedCount: 0 };
  } catch (error) {
    if (!isQuotaExceededError(error)) {
      return { kind: "FAILED", reason: "ERROR", message: describeError(error) };
    }
  }

  // 生データを落とし、件数も絞って書き直す
  const light = runs.slice(0, LIGHT_MAX_STORED_RUNS);
  try {
    storage.setItem(MEASUREMENT_STORAGE_KEY, JSON.stringify(serialize(light, true)));
    return {
      kind: "SAVED",
      mode: "LIGHT",
      storedCount: light.length,
      droppedCount: runs.length - light.length,
    };
  } catch (error) {
    return {
      kind: "FAILED",
      reason: isQuotaExceededError(error) ? "QUOTA" : "ERROR",
      message: describeError(error),
    };
  }
}

/** 読み込みの結果 */
export interface MeasurementLoadResult {
  runs: MeasurementRun[];
  /**
   * 読み込めなかった理由。正常なら null。
   *
   * | 値 | 状況 |
   * |----|------|
   * | `UNAVAILABLE` | `localStorage` が使えない（SSR / プライベートモード） |
   * | `CORRUPT` | JSON として読めない、または版が違う。捨てて空から始める |
   */
  problem: "UNAVAILABLE" | "CORRUPT" | null;
  /** 形が合わず読み飛ばした件数 */
  skippedCount: number;
  /** 軽量版として書かれていたか（生データが無い） */
  light: boolean;
}

/**
 * 保存済みの一覧を読み込む。
 *
 * 壊れた値は捨てて空の一覧を返す。例外を投げないのは、
 * 比較表の初期化が失敗して画面全体が描けなくなるのを避けるためである。
 * 1 件単位で形が合わないものは読み飛ばし、件数を返す。
 */
export function loadMeasurementRuns(storage: StorageLike | null): MeasurementLoadResult {
  if (storage === null) {
    return { runs: [], problem: "UNAVAILABLE", skippedCount: 0, light: false };
  }

  let raw: string | null;
  try {
    raw = storage.getItem(MEASUREMENT_STORAGE_KEY);
  } catch {
    return { runs: [], problem: "UNAVAILABLE", skippedCount: 0, light: false };
  }
  if (raw === null || raw.trim() === "") {
    return { runs: [], problem: null, skippedCount: 0, light: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { runs: [], problem: "CORRUPT", skippedCount: 0, light: false };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { runs: [], problem: "CORRUPT", skippedCount: 0, light: false };
  }
  const store = parsed as Partial<PersistedStore>;
  if (store.version !== MEASUREMENT_SCHEMA_VERSION || !Array.isArray(store.runs)) {
    return { runs: [], problem: "CORRUPT", skippedCount: 0, light: false };
  }

  const runs: MeasurementRun[] = [];
  let skippedCount = 0;
  for (const entry of store.runs) {
    const run = reviveRun(entry);
    if (run === null) {
      skippedCount += 1;
      continue;
    }
    runs.push(run);
  }

  return {
    // 保存時に並べ替えてあるが、手で編集された値でも並び順を保証する
    runs: sortBySavedAtDesc(runs).slice(0, MAX_STORED_RUNS),
    problem: null,
    skippedCount,
    light: store.light === true,
  };
}

// ─── 直列化と復元 ─────────────────────────────────────────────────

/**
 * 保存形式に変換する。
 *
 * `light` のとき生データ（`execution`）を落とす。読み込んだ時点で
 * すでに生データを持たない行（軽量版から復元した行）は、
 * `light` が false でも `summary` 側で書く。
 */
function serialize(runs: readonly MeasurementRun[], light: boolean): PersistedStore {
  return {
    version: MEASUREMENT_SCHEMA_VERSION,
    light,
    runs: sortBySavedAtDesc(runs).map((run) => {
      const head = { savedAt: run.savedAt, label: run.label };
      if (light || run.execution === null) {
        return { ...head, summary: run.summary };
      }
      return { ...head, execution: run.execution };
    }),
  };
}

/** 保存されていた 1 件を復元する。形が合わなければ `null` */
function reviveRun(value: unknown): MeasurementRun | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const entry = value as Partial<PersistedRun>;
  if (typeof entry.savedAt !== "string" || entry.savedAt.trim() === "") {
    return null;
  }
  const label = typeof entry.label === "string" ? normalizeRunLabel(entry.label) : null;

  // 生データがあればそれを出典にする（`summary` は導出できる）
  if (isExecutionSnapshot(entry.execution)) {
    return {
      savedAt: entry.savedAt,
      label,
      summary: summarizeExecution(entry.execution),
      execution: entry.execution,
    };
  }
  if (isMeasurementSummary(entry.summary)) {
    return { savedAt: entry.savedAt, label, summary: entry.summary, execution: null };
  }
  return null;
}

/**
 * 実行レコードのスナップショットとして扱える形か。
 *
 * 全属性は検査しない。`localStorage` の内容は自分が書いたものであり、
 * 想定するのは「手で編集された」「古い版が残っている」程度である。
 * 判別に使う `executionType` と、比較表の要である `conditions` の
 * 有無だけを見る。
 */
function isExecutionSnapshot(value: unknown): value is ExecutionStatusResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<ExecutionStatusResponse>;
  return (
    typeof candidate.executionId === "string" &&
    isExecutionType(candidate.executionType) &&
    typeof candidate.conditions === "object" &&
    candidate.conditions !== null
  );
}

/** 軽量版で書かれた `summary` として扱える形か */
function isMeasurementSummary(value: unknown): value is MeasurementSummary {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<MeasurementSummary>;
  return (
    typeof candidate.executionId === "string" &&
    isExecutionType(candidate.executionType) &&
    typeof candidate.parallelizationFactor === "number" &&
    typeof candidate.stageDelaysMs === "object" &&
    candidate.stageDelaysMs !== null
  );
}

function isExecutionType(value: unknown): value is ExecutionType {
  return typeof value === "string" && (EXECUTION_TYPES as readonly string[]).includes(value);
}

/**
 * 保存時刻の新しい順に並べる。
 *
 * 解釈できない時刻は末尾に置く（切り捨てるほどではない）。
 */
function sortBySavedAtDesc(runs: readonly MeasurementRun[]): MeasurementRun[] {
  return [...runs].sort((left, right) => savedAtValue(right) - savedAtValue(left));
}

function savedAtValue(run: MeasurementRun): number {
  const time = new Date(run.savedAt).getTime();
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** 例外を 1 行の説明にする（画面の案内に添える） */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
