import { describe, expect, it } from 'vitest';
import {
  PERCENTILE_LEVELS,
  calculatePercentiles,
  nearestRankPercentile,
} from './percentiles.js';

/**
 * レイテンシ分位点の単体テスト（design 論点 3 / §12、要件 12.3）。
 *
 * 検証の主眼は 2 点。
 *
 * 1. 最近順位法の定義どおりの順位を選ぶこと（補間しないこと）
 * 2. 標本数が 0 件・1 件・少数のときの振る舞いが定義されていること
 *
 * 分位点は計測結果の解釈の土台になるため、
 * 「その値が実測値のどれなのか」が一意に決まることを確かめる。
 */

describe('分位の定義（要件 12.3）', () => {
  it('p50 / p95 / p99 を算出する', () => {
    expect(PERCENTILE_LEVELS).toEqual({ p50: 0.5, p95: 0.95, p99: 0.99 });
  });
});

describe('nearestRankPercentile: 順位の選び方', () => {
  // x[1] = 10 … x[10] = 100
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  it('rank = ceil(p × n) 番目の実測値を返す', () => {
    // ceil(0.5 × 10) = 5 → x[5]
    expect(nearestRankPercentile(sorted, 0.5)).toBe(50);
    // ceil(0.95 × 10) = 10 → x[10]
    expect(nearestRankPercentile(sorted, 0.95)).toBe(100);
    // ceil(0.25 × 10) = 3 → x[3]
    expect(nearestRankPercentile(sorted, 0.25)).toBe(30);
    // ceil(0.21 × 10) = 3 → x[3]（切り上げるので x[2] にはならない）
    expect(nearestRankPercentile(sorted, 0.21)).toBe(30);
  });

  it('補間せず、必ず標本に含まれる値を返す', () => {
    for (let p = 0; p <= 1; p += 0.01) {
      expect(sorted).toContain(nearestRankPercentile(sorted, p));
    }
  });

  it('p = 0 は最小値、p = 1 は最大値を返す', () => {
    expect(nearestRankPercentile(sorted, 0)).toBe(10);
    expect(nearestRankPercentile(sorted, 1)).toBe(100);
  });

  it('0〜1 の外側の分位は端に丸める', () => {
    expect(nearestRankPercentile(sorted, -0.5)).toBe(10);
    expect(nearestRankPercentile(sorted, 1.5)).toBe(100);
  });

  it('空の標本では分位点が存在しないため null を返す', () => {
    expect(nearestRankPercentile([], 0.5)).toBeNull();
    expect(nearestRankPercentile([], 0)).toBeNull();
    expect(nearestRankPercentile([], 1)).toBeNull();
  });
});

describe('calculatePercentiles: 標本数 0 件の境界', () => {
  it('null を返す（0ms を観測したと読めてしまうため 0 は返さない）', () => {
    expect(calculatePercentiles([])).toBeNull();
  });
});

describe('calculatePercentiles: 標本数が少ない場合の境界', () => {
  it('1 件なら全分位点と最大がその 1 件になる', () => {
    expect(calculatePercentiles([42])).toEqual({ p50: 42, p95: 42, p99: 42, max: 42 });
  });

  it('2 件なら p50 は 1 番目、p95 / p99 / 最大は 2 番目になる', () => {
    // ceil(0.5 × 2) = 1、ceil(0.95 × 2) = 2、ceil(0.99 × 2) = 2
    expect(calculatePercentiles([10, 20])).toEqual({ p50: 10, p95: 20, p99: 20, max: 20 });
  });

  it('3 件なら p50 は中央、p95 / p99 / 最大は最大値になる', () => {
    // ceil(0.5 × 3) = 2、ceil(0.95 × 3) = 3、ceil(0.99 × 3) = 3
    expect(calculatePercentiles([10, 20, 30])).toEqual({ p50: 20, p95: 30, p99: 30, max: 30 });
  });

  it('4 件なら p50 は 2 番目、p95 / p99 / 最大は 4 番目になる', () => {
    expect(calculatePercentiles([1, 2, 3, 4])).toEqual({ p50: 2, p95: 4, p99: 4, max: 4 });
  });

  it('標本が 100 件未満だと p95 と p99 が最大値に一致しうる（分布として読めない）', () => {
    const result = calculatePercentiles([5, 15, 25, 35, 45]);

    expect(result).not.toBeNull();
    expect(result?.p95).toBe(result?.max);
    expect(result?.p99).toBe(result?.max);
  });
});

describe('calculatePercentiles: 十分な件数がある場合', () => {
  it('1〜100 の 100 件で p50 = 50 / p95 = 95 / p99 = 99 / max = 100 になる', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);

    expect(calculatePercentiles(values)).toEqual({ p50: 50, p95: 95, p99: 99, max: 100 });
  });

  it('1〜200 の 200 件で p50 = 100 / p95 = 190 / p99 = 198 / max = 200 になる', () => {
    const values = Array.from({ length: 200 }, (_, i) => i + 1);

    expect(calculatePercentiles(values)).toEqual({ p50: 100, p95: 190, p99: 198, max: 200 });
  });

  it('裾の外れ値が p99 と最大に現れる（波及の観測。要件 12.3）', () => {
    // 通常 20ms の応答が 990 件、スロットル待ちで遅れた応答が 10 件
    const values = [...Array.from({ length: 990 }, () => 20), ...Array.from({ length: 10 }, () => 3000)];
    const result = calculatePercentiles(values);

    expect(result?.p50).toBe(20);
    expect(result?.p95).toBe(20);
    // ceil(0.99 × 1000) = 990 → まだ 20ms 側の最後の 1 件
    expect(result?.p99).toBe(20);
    // 平均では埋もれる裾が最大値に残る
    expect(result?.max).toBe(3000);
  });
});

describe('calculatePercentiles: 入力の扱い', () => {
  it('未整列の標本でも整列済みと同じ結果になる', () => {
    const sorted = [10, 20, 30, 40, 50];
    const shuffled = [30, 50, 10, 40, 20];

    expect(calculatePercentiles(shuffled)).toEqual(calculatePercentiles(sorted));
  });

  it('数値として整列する（文字列比較にならない）', () => {
    // 既定の Array#sort は文字列比較のため 100 < 20 になってしまう
    expect(calculatePercentiles([100, 20, 3])).toEqual({ p50: 20, p95: 100, p99: 100, max: 100 });
  });

  it('引数の配列を変更しない', () => {
    const values = [30, 10, 20];

    calculatePercentiles(values);

    expect(values).toEqual([30, 10, 20]);
  });

  it('同じ値だけの標本では全分位点がその値になる', () => {
    expect(calculatePercentiles([7, 7, 7, 7])).toEqual({ p50: 7, p95: 7, p99: 7, max: 7 });
  });

  it('小数のレイテンシをそのまま保持する（丸めない）', () => {
    expect(calculatePercentiles([12.5])).toEqual({ p50: 12.5, p95: 12.5, p99: 12.5, max: 12.5 });
  });

  it('p50 ≤ p95 ≤ p99 ≤ max が常に成り立つ', () => {
    const samples: number[][] = [
      [1],
      [2, 1],
      [5, 3, 9, 1],
      Array.from({ length: 37 }, (_, i) => (i * 17) % 41),
      Array.from({ length: 500 }, (_, i) => (i * 7919) % 1000),
    ];

    for (const values of samples) {
      const result = calculatePercentiles(values);

      expect(result).not.toBeNull();
      expect(result!.p50).toBeLessThanOrEqual(result!.p95);
      expect(result!.p95).toBeLessThanOrEqual(result!.p99);
      expect(result!.p99).toBeLessThanOrEqual(result!.max);
    }
  });
});
