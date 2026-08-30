/**
 * レイテンシ分位点の算出（design 論点 3、要件 12.3）。
 *
 * 並行計測 Lambda（`query-impact-measure`）は全リクエストのレイテンシを記録し、
 * p50 / p95 / p99 / 最大を実行レコードに残す。平均値だけでは
 * 後続処理の負荷が照会系に波及したときの「裾」が見えないためである（要件 12.3）。
 *
 * 算出方法を AWS 呼び出しから独立させているのは、記録された数値の意味を
 * 後から検算できるようにするため（design §12）。
 *
 * ## 分位点の定義: 最近順位法（nearest-rank）
 *
 * 昇順に並べた標本を `x[1] … x[n]` とし、分位 `p`（0〜1）に対して
 *
 * ```
 * 順位 = clamp(ceil(p × n), 1, n)
 * 分位点 = x[順位]
 * ```
 *
 * を返す。**補間はしない。** 返す値は必ず実測値のいずれかである。
 *
 * 補間法（CloudWatch の分位統計などが使う）を採らないのは、
 * 実測レイテンシの記録に「一度も観測されなかった値」を混ぜたくないからである。
 * 記録が「その値のリクエストが実際にあった」と読めることを優先する。
 *
 * この定義の帰結として、標本数が少ないときは複数の分位点が同じ値になる。
 * 例: `n = 2` なら p50 は 1 番目、p95 と p99 と最大はいずれも 2 番目を指す。
 * 少数の標本から出た分位点は分布として解釈できないため、
 * 計測は十分な件数を回した上で読むこと。
 *
 * 標本が 0 件の場合は分位点を定義できないため `null` を返す（後述）。
 */

import type { LatencyPercentiles } from './types.js';

/** 算出する分位（要件 12.3） */
export const PERCENTILE_LEVELS = {
  p50: 0.5,
  p95: 0.95,
  p99: 0.99,
} as const;

/**
 * 最近順位法の順位を 0 始まりの添字に変換する。標本数が 1 以上であることを前提とする。
 *
 * 分位 `p` は 0〜1 に丸める。`p = 0` のとき `ceil(0 × n) = 0` になるため、
 * 最小順位 1 に持ち上げてから添字にする。
 */
function nearestRankIndex(sampleCount: number, p: number): number {
  const clampedP = Math.min(Math.max(p, 0), 1);
  const rank = Math.ceil(clampedP * sampleCount);

  return Math.min(Math.max(rank, 1), sampleCount) - 1;
}

/**
 * 昇順に整列済みの標本から、最近順位法で分位点を返す。
 *
 * 呼び出し側で整列済みであることを前提にしている（`calculatePercentiles` が
 * 分位ごとに並べ直すのを避けるため）。整列していない配列を渡すと結果は無意味になる。
 *
 * 空配列に対しては分位点が存在しないため `null` を返す。
 */
export function nearestRankPercentile(sortedValues: readonly number[], p: number): number | null {
  if (sortedValues.length === 0) {
    return null;
  }

  return sortedValues[nearestRankIndex(sortedValues.length, p)];
}

/**
 * レイテンシの標本から p50 / p95 / p99 / 最大を算出する。
 *
 * **標本が 0 件のときは `null` を返す。** 0 を返すと
 * 「レイテンシ 0ms を観測した」と読めてしまい、計測が空振りした事実が消える。
 * 実行レコードの `latency_percentiles` は省略可能な属性なので（design §4.3）、
 * 未算出をそのまま表現できる。
 *
 * 引数の配列は変更しない（整列は複製に対して行う）。
 * 標本数が少ない場合の各分位点の重なりは、この関数のドキュメント冒頭のとおり。
 */
export function calculatePercentiles(values: readonly number[]): LatencyPercentiles | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[nearestRankIndex(sorted.length, p)];

  return {
    p50: at(PERCENTILE_LEVELS.p50),
    p95: at(PERCENTILE_LEVELS.p95),
    p99: at(PERCENTILE_LEVELS.p99),
    max: sorted[sorted.length - 1],
  };
}
