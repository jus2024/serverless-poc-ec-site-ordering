import { describe, expect, it } from 'vitest';
import {
  CONSTANT_LOAD_FACTOR,
  PEAK_FRACTION,
  RAMP_DOWN_FRACTION,
  RAMP_UP_FRACTION,
  loadFactorAt,
  rampCurveFactor,
} from './load-curve.js';

/**
 * 負荷カーブの単体テスト（design 論点 2 / §12、要件 11.2 / 11.3）。
 *
 * 検証の主眼は区間の境目（0%・30%・70%・100%）である。
 * ここがずれると投入レートが目標から乖離し、実測値そのものが信用できなくなる（Property 11）。
 */

describe('区間の割合（design 論点 2）', () => {
  it('漸増 30% / ピーク 40% / 漸減 30% である', () => {
    expect(RAMP_UP_FRACTION).toBe(0.3);
    expect(PEAK_FRACTION).toBe(0.4);
    expect(RAMP_DOWN_FRACTION).toBe(0.3);
  });

  it('3 区間の合計が実行時間の 100% になる', () => {
    expect(RAMP_UP_FRACTION + PEAK_FRACTION + RAMP_DOWN_FRACTION).toBeCloseTo(1);
  });
});

describe('rampCurveFactor: 境界（要件 11.2）', () => {
  it('開始時（0%）は 0 である', () => {
    expect(rampCurveFactor(0)).toBe(0);
  });

  it('漸増とピークの境目（30%）は 1 である', () => {
    expect(rampCurveFactor(0.3)).toBe(1);
  });

  it('ピークと漸減の境目（70%）は 1 である', () => {
    expect(rampCurveFactor(0.7)).toBe(1);
  });

  it('終了時（100%）は 0 である', () => {
    expect(rampCurveFactor(1)).toBe(0);
  });
});

describe('rampCurveFactor: 漸増区間（前半 30%）', () => {
  it('中間点（15%）で 0.5 になる', () => {
    expect(rampCurveFactor(0.15)).toBeCloseTo(0.5);
  });

  it('進捗に対して線形に上昇する', () => {
    expect(rampCurveFactor(0.06)).toBeCloseTo(0.2);
    expect(rampCurveFactor(0.12)).toBeCloseTo(0.4);
    expect(rampCurveFactor(0.24)).toBeCloseTo(0.8);
  });

  it('単調非減少である', () => {
    let previous = -1;
    for (let progress = 0; progress <= 0.3; progress += 0.01) {
      const factor = rampCurveFactor(progress);

      expect(factor).toBeGreaterThanOrEqual(previous);
      previous = factor;
    }
  });
});

describe('rampCurveFactor: ピーク区間（中盤 40%）', () => {
  it('30%〜70% の全域で 1 を維持する', () => {
    for (let progress = 0.3; progress <= 0.7; progress += 0.02) {
      expect(rampCurveFactor(progress)).toBeCloseTo(1);
    }
  });
});

describe('rampCurveFactor: 漸減区間（後半 30%）', () => {
  it('中間点（85%）で 0.5 になる', () => {
    expect(rampCurveFactor(0.85)).toBeCloseTo(0.5);
  });

  it('進捗に対して線形に下降する', () => {
    expect(rampCurveFactor(0.76)).toBeCloseTo(0.8);
    expect(rampCurveFactor(0.82)).toBeCloseTo(0.6);
    expect(rampCurveFactor(0.94)).toBeCloseTo(0.2);
  });

  it('単調非増加である', () => {
    let previous = 2;
    for (let progress = 0.7; progress <= 1; progress += 0.01) {
      const factor = rampCurveFactor(progress);

      expect(factor).toBeLessThanOrEqual(previous);
      previous = factor;
    }
  });
});

describe('rampCurveFactor: 定義域の外', () => {
  it('係数は常に 0〜1 に収まる', () => {
    for (let progress = -0.5; progress <= 1.5; progress += 0.01) {
      const factor = rampCurveFactor(progress);

      expect(factor).toBeGreaterThanOrEqual(0);
      expect(factor).toBeLessThanOrEqual(1);
    }
  });

  it('負の進捗は開始時と同じ 0 として扱う', () => {
    expect(rampCurveFactor(-0.1)).toBe(0);
  });

  it('1 を超える進捗は終了時と同じ 0 として扱う', () => {
    expect(rampCurveFactor(1.5)).toBe(0);
  });
});

describe('loadFactorAt: 定常負荷モード（要件 11.3）', () => {
  it('経過時間に関係なく常に 1 を返す', () => {
    const durationSeconds = 600;

    for (const elapsedSeconds of [0, 1, 180, 420, 599, 600]) {
      expect(loadFactorAt({ elapsedSeconds, durationSeconds, useRampCurve: false })).toBe(
        CONSTANT_LOAD_FACTOR
      );
    }
  });

  it('定常負荷の係数は 1 である', () => {
    expect(CONSTANT_LOAD_FACTOR).toBe(1);
  });

  it('継続時間が 0 でも 1 を返す（カーブの進捗率に依存しない）', () => {
    expect(
      loadFactorAt({ elapsedSeconds: 0, durationSeconds: 0, useRampCurve: false })
    ).toBe(1);
  });
});

describe('loadFactorAt: 負荷カーブモード（要件 11.2）', () => {
  // design §10.2 のシナリオが使う 10 分間の実行を想定する
  const durationSeconds = 600;

  it('経過時間を継続時間で正規化した進捗率で係数を決める', () => {
    expect(loadFactorAt({ elapsedSeconds: 0, durationSeconds, useRampCurve: true })).toBe(0);
    expect(loadFactorAt({ elapsedSeconds: 90, durationSeconds, useRampCurve: true })).toBeCloseTo(
      0.5
    );
    expect(loadFactorAt({ elapsedSeconds: 180, durationSeconds, useRampCurve: true })).toBe(1);
    expect(loadFactorAt({ elapsedSeconds: 420, durationSeconds, useRampCurve: true })).toBe(1);
    expect(loadFactorAt({ elapsedSeconds: 510, durationSeconds, useRampCurve: true })).toBeCloseTo(
      0.5
    );
    expect(loadFactorAt({ elapsedSeconds: 600, durationSeconds, useRampCurve: true })).toBe(0);
  });

  it('目標レートに掛けると想定の投入レートになる', () => {
    const targetOrdersPerMinute = 2000;
    const rateAt = (elapsedSeconds: number) =>
      targetOrdersPerMinute * loadFactorAt({ elapsedSeconds, durationSeconds, useRampCurve: true });

    expect(rateAt(0)).toBe(0);
    expect(rateAt(90)).toBeCloseTo(1000);
    expect(rateAt(300)).toBeCloseTo(2000);
    expect(rateAt(600)).toBe(0);
  });

  it('継続時間を超えた経過時間は 0 を返す（自己再帰の行き過ぎに備える）', () => {
    expect(loadFactorAt({ elapsedSeconds: 601, durationSeconds, useRampCurve: true })).toBe(0);
  });

  it('継続時間が 0 以下なら 0 を返す', () => {
    expect(loadFactorAt({ elapsedSeconds: 0, durationSeconds: 0, useRampCurve: true })).toBe(0);
    expect(loadFactorAt({ elapsedSeconds: 10, durationSeconds: -1, useRampCurve: true })).toBe(0);
  });
});
