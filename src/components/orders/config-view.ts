/**
 * 検証パラメータの表示ロジック（純粋関数。要件 14.7 / 10.6）。
 *
 * ## S の出典を必ず添える（design Property 10）
 *
 * `GET /config` が返す消費能力の見積もりは `S × P ÷ D` の算出値だが、
 * **S が実測値か暫定値かで意味が変わる**。オープンシャード数は
 * CloudWatch メトリクスとして提供されず（要件 19 の但し書き）、
 * `DescribeStream` を呼べる関数だけが知りうる。`GET /config` は
 * ストリームを見に行かないため、既定では暫定値（`ASSUMED`）を名乗る。
 *
 * 暫定値に基づく消費能力を「実測した壁の位置」と読み違えると、
 * design §2.2 の壁の候補表の結論が変わる。したがって画面は
 * `shardCountSource` を値と同じ強さで示す。
 *
 * ## 画面側で式を再計算して突き合わせる
 *
 * `capacity.ts` は Lambda 側の `capacity.ts` と**意図的に重複**している
 * （要件 18.6 により import できない）。重複は片方だけを直したときに
 * 気づけないという弱さを持つ。そこで `GET /config` が返した見積もりと、
 * 画面側で同じ式から再計算した値を突き合わせ、食い違いを表示する。
 *
 * これは検証ではなくドリフトの検知である。一致しない場合、
 * 少なくとも「どちらかの式が変わった」ことが画面に出る。
 *
 * DOM に触らないため単体テストの対象にできる（`vitest.config.ts`）。
 */

import {
  estimateCapacityPerMinute,
  resolveRecordProcessingMs,
} from "../../lib/orders/capacity";
import type {
  CapacityEstimate,
  ShardCountSource,
  VerificationConfigResponse,
} from "../../lib/orders/types";

// ─── S の出典 ─────────────────────────────────────────────────────

/** S の出典の日本語表示（design Property 10） */
export const SHARD_COUNT_SOURCE_LABELS: Record<ShardCountSource, string> = {
  ASSUMED: "暫定値（未実測）",
  MEASURED: "実測値",
};

/** S の出典の説明 */
export interface ShardCountSourceView {
  source: ShardCountSource;
  label: string;
  /** 実測値か。false なら消費能力も暫定値である */
  measured: boolean;
  /** 画面に添える注記 */
  note: string;
}

/**
 * S の出典を説明する。
 *
 * `ASSUMED` の注記で「どこを見れば実測値が分かるか」まで書く。
 * 実測値は負荷生成 / 並行計測の実行レコード（`ExecutionConditionsView`）に
 * だけ残るため、設定タブを見ただけでは辿り着けない。
 */
export function describeShardCountSource(source: ShardCountSource): ShardCountSourceView {
  if (source === "MEASURED") {
    return {
      source,
      label: SHARD_COUNT_SOURCE_LABELS.MEASURED,
      measured: true,
      note: "DescribeStream で数えたオープンシャード数に基づく。消費能力の見積もりもこの値による。",
    };
  }
  return {
    source,
    label: SHARD_COUNT_SOURCE_LABELS.ASSUMED,
    measured: false,
    note: "この API はストリームを参照しないため、シャード数は暫定値である。実測値は負荷生成または並行計測を 1 回実行し、その実行レコードの「実行時の観測条件」で確認する。下の消費能力も暫定値に基づく。",
  };
}

// ─── 消費能力の突き合わせ ──────────────────────────────────────────

/**
 * 見積もりの突き合わせに使う許容誤差。
 *
 * Lambda 側は毎分レートを小数第 1 位に丸めて返す（`roundRate`）ため、
 * 絶対値で 0.05 程度の差は式が同じでも生じる。相対誤差 0.1% と
 * 絶対値 0.1 の大きいほうを許容する。
 */
const CAPACITY_MATCH_TOLERANCE_RATIO = 0.001;
const CAPACITY_MATCH_TOLERANCE_ABSOLUTE = 0.1;

/** `GET /config` の見積もりと画面側の再計算の突き合わせ */
export interface CapacityCrossCheck {
  /** API が返した見積もり（件/分） */
  reported: number;
  /** 画面側で `capacity.ts` から再計算した値（件/分）。算出できなければ null */
  recomputed: number | null;
  /** 再計算に使った D（ミリ秒）。算出できなければ null */
  recordProcessingMs: number | null;
  /** 一致するか。再計算できなければ null */
  matches: boolean | null;
  /**
   * 再計算できなかった理由。算出できた場合は null。
   *
   * D が 0 以下だと消費能力が定義できない（`estimateCapacityPerMinute` が
   * `RangeError` を投げる）。設定の検証は合成時に通っているはずなので、
   * ここに来るのは応答が想定外の形をしている場合である。
   */
  problem: string | null;
}

/**
 * 消費能力の見積もりを画面側で再計算して突き合わせる。
 *
 * 例外は外に出さない。設定タブは「今どういう設定でデプロイされているか」を
 * 読む画面であり、式の再計算に失敗したからといって他の値まで
 * 見えなくなるべきではない。
 */
export function deriveCapacityCrossCheck(capacity: CapacityEstimate): CapacityCrossCheck {
  const reported = capacity.estimatedCapacityPerMinute;

  try {
    const recordProcessingMs = resolveRecordProcessingMs({
      // `pseudoDelayMs` は合計値なので、内訳は持たない。
      // D の再計算には内訳が要らない（合計 + オーバーヘッド）ため、
      // 決済側に合計を置いて通知を 0 とみなす
      stageDelaysMs: { payment: capacity.pseudoDelayMs, notification: 0 },
      assumedOverheadMs: capacity.assumedOverheadMs,
    });
    const recomputed = estimateCapacityPerMinute({
      shardCount: capacity.openShardCount,
      parallelizationFactor: capacity.parallelizationFactor,
      recordProcessingMs,
    });

    const tolerance = Math.max(
      CAPACITY_MATCH_TOLERANCE_ABSOLUTE,
      Math.abs(reported) * CAPACITY_MATCH_TOLERANCE_RATIO
    );

    return {
      reported,
      recomputed,
      recordProcessingMs,
      matches: Math.abs(recomputed - reported) <= tolerance,
      problem: null,
    };
  } catch (error) {
    return {
      reported,
      recomputed: null,
      recordProcessingMs: null,
      matches: null,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

// ─── 設定タブの表示データ ──────────────────────────────────────────

/** 設定タブに出す導出値（要件 14.7） */
export interface VerificationConfigView {
  shardCount: ShardCountSourceView;
  capacity: CapacityCrossCheck;
  /**
   * `S × P`。後続処理が到達し得る最大同時実行数（design §2.1）。
   *
   * API も `maxConcurrency` として返すが、画面側でも積を取って
   * 突き合わせる。ここが食い違えば S か P の解釈がずれている。
   */
  maxConcurrency: number;
  maxConcurrencyMatches: boolean;
  /** 擬似待機以外のオーバーヘッドが D に占める割合（0〜1）。D が 0 なら null */
  overheadShare: number | null;
}

/** `GET /config` の応答から設定タブの導出値を組む */
export function deriveVerificationConfigView(
  config: VerificationConfigResponse
): VerificationConfigView {
  const { capacity } = config;
  const crossCheck = deriveCapacityCrossCheck(capacity);
  const maxConcurrency = capacity.openShardCount * capacity.parallelizationFactor;

  return {
    shardCount: describeShardCountSource(capacity.shardCountSource),
    capacity: crossCheck,
    maxConcurrency,
    maxConcurrencyMatches: maxConcurrency === capacity.maxConcurrency,
    overheadShare:
      capacity.recordProcessingMs > 0
        ? capacity.assumedOverheadMs / capacity.recordProcessingMs
        : null,
  };
}
