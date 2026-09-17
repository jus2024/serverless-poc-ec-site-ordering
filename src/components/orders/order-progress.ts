/**
 * 注文の段階進捗と経過時間の表示ロジック（純粋関数。要件 14.4）。
 *
 * ## なぜコンポーネントから切り出すか
 *
 * `.kiro/steering/testing.md` の「最も狭い範囲の検証を最初に実行する」に従う。
 * Vitest は `environment: "node"` のままで、DOM を必要とするテストは持ち込まない
 * （design Testing Strategy）。そのため「段階の並べ方」「経過時間の見せ方」
 * といった判断は DOM に依存しない関数として `OrderStatusPanel` から外に出し、
 * 単体テストで固定する。タスク 22.1 の `tab-navigation.ts` と同じ方針である。
 *
 * ## 時刻を UTC のまま見せている理由
 *
 * `formatTimestamp` はブラウザのタイムゾーンに変換せず、API が返した
 * ISO 8601 の瞬間を UTC で表示する。CloudWatch のグラフ・ログが UTC 基準であり
 * （design §6）、画面の完了時刻と CloudWatch の時刻を突き合わせるのが
 * この画面の主な用途だからである。ローカル時刻に変換すると、
 * 検証者が毎回時差を足し引きすることになる。
 *
 * ## import が相対パスな理由
 *
 * Vitest の設定（`vitest.config.ts`）に `@/` のエイリアスを持たせていないため、
 * テスト対象の純粋関数からは相対パスで参照する。`.tsx` 側は Next.js の
 * 解決に乗るので `@/src/...` を使う（`OrderDashboard.tsx` と同じ）。
 */

import {
  ORDER_STAGES,
  type OrderStage,
  type OrderStatus,
  type StageProgress,
} from "../../lib/orders/types";

/** 段階の総数（design §5.5 の 4 段階） */
export const TOTAL_ORDER_STAGES = ORDER_STAGES.length;

/** 段階の日本語表示（design §5.5 の決済 → 引当 → 通知 → ポイント） */
export const ORDER_STAGE_LABELS: Record<OrderStage, string> = {
  payment: "決済",
  allocation: "在庫引当",
  notification: "注文確認通知",
  point: "ポイント付与",
};

/** 注文ステータスの日本語表示（design §E-2） */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  PENDING: "受付済み",
  PAID: "決済完了",
  ALLOCATED: "引当完了",
  NOTIFIED: "通知完了",
  COMPLETED: "全段階完了",
  PAYMENT_FAILED: "決済失敗",
  ALLOCATION_FAILED: "在庫不足",
};

/** 段階の状態の日本語表示 */
export const STAGE_STATUS_LABELS: Record<StageProgress["status"], string> = {
  WAITING: "未完了",
  DONE: "完了",
  FAILED: "失敗",
};

/** 値が未取得・算出不能であることを表す表示（表の桁を崩さないため文字で埋める） */
export const EMPTY_VALUE = "—";

/**
 * これ以上進まない注文ステータス（design §E-2 の終端）。
 *
 * `COMPLETED` は正常な終端、`*_FAILED` は業務的な失敗で、いずれも
 * 再試行されない（要件 16.7）。画面側はこれを見て自動更新を止める。
 */
const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  "COMPLETED",
  "PAYMENT_FAILED",
  "ALLOCATION_FAILED",
];

/** 終端ステータスかどうか。自動更新を続けるかの判断に使う */
export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return TERMINAL_ORDER_STATUSES.includes(status);
}

/** 注文ステータスに対応するバッジのクラス（`src/app/globals.css` のトークン） */
export function orderStatusBadgeClass(status: OrderStatus): string {
  if (status === "COMPLETED") {
    return "badge badge-completed";
  }
  if (status === "PAYMENT_FAILED" || status === "ALLOCATION_FAILED") {
    return "badge badge-failed";
  }
  // 進行中（PENDING / PAID / ALLOCATED / NOTIFIED）。globals.css は 3 種のみ持つ
  return "badge badge-running";
}

// ─── 書式 ────────────────────────────────────────────────────────

/**
 * 経過時間を表示する。
 *
 * 桁は「ミリ秒 → 秒 → 分」で切り替える。段階ごとの所要時間は
 * 擬似待機（既定 3.6 秒。design §10.1）の前後、全段階の経過時間は
 * 滞留が起きると分の桁に達するため、両方を 1 つの関数で扱う。
 *
 * 端数は四捨五入せず切り捨てる。`59_999ms` を `60.00 秒` と出すと
 * 分の桁に繰り上がったように見え、境界の観測を誤らせる。
 *
 * @param ms ミリ秒。未完了（null）や不正値では `EMPTY_VALUE` を返す
 */
export function formatElapsedMs(ms: number | null | undefined): string {
  const value = normalizeMs(ms);
  if (value === null) {
    return EMPTY_VALUE;
  }
  if (value < 1_000) {
    return `${Math.floor(value)} ms`;
  }
  if (value < 60_000) {
    // 小数第 2 位までを切り捨てで出す
    return `${(Math.floor(value / 10) / 100).toFixed(2)} 秒`;
  }
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor((value % 60_000) / 100) / 10;
  return `${minutes} 分 ${seconds.toFixed(1)} 秒`;
}

/**
 * ISO 8601 の時刻を `YYYY-MM-DD HH:MM:SS.mmm UTC` で表示する。
 *
 * ミリ秒まで出すのは、段階の完了時刻の差が数百ミリ秒の桁になるためである。
 */
export function formatTimestamp(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso.trim() === "") {
    return EMPTY_VALUE;
  }
  const parsed = new Date(iso);
  const time = parsed.getTime();
  if (Number.isNaN(time)) {
    return EMPTY_VALUE;
  }
  // toISOString は常に UTC。ブラウザのタイムゾーンに依存しない
  const [date, clock] = parsed.toISOString().split("T");
  return `${date} ${clock.replace("Z", "")} UTC`;
}

/**
 * 金額を円で表示する。
 *
 * `Intl` に依存せず 3 桁区切りを自前で入れる。表示は税込単価・合計金額の
 * どちらにも使う（商品マスタは税込単価を持つ。要件 3.4）。
 */
export function formatJpy(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) {
    return EMPTY_VALUE;
  }
  const rounded = Math.round(amount);
  const sign = rounded < 0 ? "-" : "";
  const digits = Math.abs(rounded)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}¥${digits}`;
}

/** 整数を 3 桁区切りで表示する（在庫数・件数） */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return EMPTY_VALUE;
  }
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ─── 段階進捗の算出 ────────────────────────────────────────────────

/** 表示する段階 1 行分 */
export interface StageRow {
  stage: OrderStage;
  /** 日本語表示 */
  label: string;
  status: StageProgress["status"];
  /** 完了時刻（ISO 8601）。未完了なら null */
  completedAt: string | null;
  /** 注文受付からこの段階の完了までの経過ミリ秒。未完了なら null */
  elapsedMs: number | null;
  /**
   * 直前の完了時点からこの段階の完了までの所要ミリ秒。
   *
   * 1 段目は注文受付を起点（経過 0）とする。算出できない場合は null。
   */
  stageDurationMs: number | null;
}

/** 段階進捗のまとめ（要件 14.4） */
export interface StageProgressView {
  /** 常に 4 行。API の応答に欠けている段階は未完了として埋める */
  rows: StageRow[];
  /** 完了した段階数（0〜4） */
  stagesDone: number;
  totalStages: number;
  /** 進捗率（0〜100 の整数）。`aria-valuenow` に使う */
  progressPercent: number;
  /** 全段階完了までの経過ミリ秒。未完了なら null（要件 2.6） */
  endToEndMs: number | null;
  /** 打ち切りになった段階。無ければ null */
  failedStage: OrderStage | null;
}

/**
 * 段階進捗の算出に必要な部分だけを受け取る。
 *
 * `OrderStatusResponse` をそのまま渡せる形にしつつ、テストからは
 * 最小限のオブジェクトを組み立てられるようにしている。
 */
export interface StageProgressSource {
  stages?: readonly StageProgress[] | null;
  stagesDone?: number | null;
  endToEndMs?: number | null;
}

/**
 * API の応答から段階進捗の表示用データを組み立てる（要件 14.4）。
 *
 * 段階は API の並び順ではなく `ORDER_STAGES`（決済 → 引当 → 通知 → ポイント）
 * の順に固定する。応答の順序が変わっても表の行が入れ替わらないようにするためで、
 * 「どの段階で止まっているか」を行の位置で読めることを優先している。
 */
export function deriveStageProgress(source: StageProgressSource): StageProgressView {
  const byStage = new Map<OrderStage, StageProgress>();
  for (const entry of source.stages ?? []) {
    // 未知の段階は捨てる。同じ段階が重複したら先に現れたものを採用する
    if (entry != null && isOrderStage(entry.stage) && !byStage.has(entry.stage)) {
      byStage.set(entry.stage, entry);
    }
  }

  const rows: StageRow[] = [];
  // 注文受付を起点にするので 0 から始める
  let previousElapsedMs = 0;

  for (const stage of ORDER_STAGES) {
    const entry = byStage.get(stage);
    const elapsedMs = normalizeMs(entry?.elapsedMs);
    rows.push({
      stage,
      label: ORDER_STAGE_LABELS[stage],
      status: entry?.status ?? "WAITING",
      completedAt: entry?.completedAt ?? null,
      elapsedMs,
      stageDurationMs: deriveStageDuration(previousElapsedMs, elapsedMs),
    });
    if (elapsedMs !== null) {
      previousElapsedMs = elapsedMs;
    }
  }

  const failedRow = rows.find((row) => row.status === "FAILED");
  const stagesDone = resolveStagesDone(source.stagesDone, rows);

  return {
    rows,
    stagesDone,
    totalStages: TOTAL_ORDER_STAGES,
    progressPercent: Math.round((stagesDone / TOTAL_ORDER_STAGES) * 100),
    endToEndMs: normalizeMs(source.endToEndMs),
    failedStage: failedRow === undefined ? null : failedRow.stage,
  };
}

/** 既知の段階かどうか */
function isOrderStage(value: unknown): value is OrderStage {
  return typeof value === "string" && (ORDER_STAGES as readonly string[]).includes(value);
}

/**
 * 経過ミリ秒を検証する。
 *
 * 負の値・非数は「算出できなかった」として null にする。時刻の取り違えを
 * `-3 ms` のような値で画面に出すより、空欄にしたほうが誤読が少ない。
 */
function normalizeMs(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

/** 直前の完了からの所要時間。逆行していれば算出しない */
function deriveStageDuration(previousElapsedMs: number, elapsedMs: number | null): number | null {
  if (elapsedMs === null) {
    return null;
  }
  const duration = elapsedMs - previousElapsedMs;
  return duration < 0 ? null : duration;
}

/**
 * 完了段階数を決める。
 *
 * 出典は API の `stagesDone`（要件 8.2 で加算される値）。範囲外・非整数なら
 * 段階の状態から数え直す。進捗率の分子になる値なので、`5 / 4 = 125%` のような
 * 表示にしない。
 */
function resolveStagesDone(reported: number | null | undefined, rows: readonly StageRow[]): number {
  if (
    typeof reported === "number" &&
    Number.isInteger(reported) &&
    reported >= 0 &&
    reported <= TOTAL_ORDER_STAGES
  ) {
    return reported;
  }
  return rows.filter((row) => row.status === "DONE").length;
}
