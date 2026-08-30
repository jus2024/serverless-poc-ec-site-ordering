import { describe, expect, it } from 'vitest';
import { PEAK_FRACTION, RAMP_UP_FRACTION } from '../shared/load-curve.js';
import {
  AVERAGE_RAMP_FACTOR,
  HANDOFF_THRESHOLD_MS,
  RATE_DEVIATION_THRESHOLD,
  TICK_INTERVAL_MS,
  evaluateRate,
  expectedOrdersPerMinute,
  planTick,
  resolveTickAction,
} from './load-plan.js';

/**
 * 投入ペースと自己再帰判定の単体テスト（要件 11.1〜11.3 / 11.9 / 11.11、design 論点 2 / 論点 10）。
 *
 * 時間も AWS も使わない。確かめるのは 4 点。
 *
 * 1. 目標レートが刻みの投入件数に正しく落ちること（端数の繰り越しを含む）
 * 2. 低レート（2 件/分）が 0 件に潰れないこと（要件 11.7 の下限）
 * 3. 残り実行時間が閾値を切ったら引き継ぐこと（要件 11.9）
 * 4. 乖離の判定が負荷カーブの平均係数を織り込むこと（要件 11.11）
 */

const CONSTANT = {
  durationSeconds: 600,
  useRampCurve: false,
} as const;

describe('planTick（要件 11.1）', () => {
  it('定常負荷では 1 秒あたり 目標 ÷ 60 件を投入する', () => {
    const plan = planTick({
      targetOrdersPerMinute: 1_200,
      elapsedMs: 0,
      carry: 0,
      ...CONSTANT,
    });
    expect(plan.orders).toBe(20);
    expect(plan.factor).toBe(1);
  });

  it('16,000 件/分は 1 刻みで 266 件（+ 端数の繰り越し）になる', () => {
    const plan = planTick({
      targetOrdersPerMinute: 16_000,
      elapsedMs: 0,
      carry: 0,
      ...CONSTANT,
    });
    expect(plan.orders).toBe(266);
    expect(plan.carry).toBeCloseTo(2 / 3, 10);
  });

  it('端数を繰り越して低レート（2 件/分）でも投入できる（要件 11.7 の下限）', () => {
    let carry = 0;
    let submitted = 0;
    // 2 件/分 = 30 秒に 1 件。60 刻み（60 秒）で 2 件になること
    for (let tick = 0; tick < 60; tick += 1) {
      const plan = planTick({
        targetOrdersPerMinute: 2,
        elapsedMs: tick * TICK_INTERVAL_MS,
        carry,
        ...CONSTANT,
      });
      carry = plan.carry;
      submitted += plan.orders;
    }
    expect(submitted).toBe(2);
  });

  it('端数の繰り越しで切り捨て誤差が累積しない（1 分の累積が目標に一致する）', () => {
    let carry = 0;
    let submitted = 0;
    for (let tick = 0; tick < 60; tick += 1) {
      const plan = planTick({
        targetOrdersPerMinute: 16_000,
        elapsedMs: tick * TICK_INTERVAL_MS,
        carry,
        ...CONSTANT,
      });
      carry = plan.carry;
      submitted += plan.orders;
    }
    expect(submitted).toBe(16_000);
  });

  it('繰り越しは 0 以上 1 未満に収まる', () => {
    let carry = 0;
    for (let tick = 0; tick < 100; tick += 1) {
      const plan = planTick({
        targetOrdersPerMinute: 777,
        elapsedMs: tick * TICK_INTERVAL_MS,
        carry,
        ...CONSTANT,
      });
      carry = plan.carry;
      expect(carry).toBeGreaterThanOrEqual(0);
      expect(carry).toBeLessThan(1);
    }
  });

  it('刻みが長引いた場合は実経過時間の分だけ多く投入する（自己補正）', () => {
    const plan = planTick({
      targetOrdersPerMinute: 600,
      elapsedMs: 5_000,
      carry: 0,
      tickMs: 3_000,
      ...CONSTANT,
    });
    // 600 件/分 = 10 件/秒。3 秒分なら 30 件
    expect(plan.orders).toBe(30);
  });

  it('負荷カーブでは漸増区間の投入件数が定常より少ない（要件 11.2）', () => {
    const rampUpMiddle = planTick({
      targetOrdersPerMinute: 1_200,
      elapsedMs: 600 * 1_000 * (RAMP_UP_FRACTION / 2),
      durationSeconds: 600,
      useRampCurve: true,
      carry: 0,
    });
    expect(rampUpMiddle.factor).toBeCloseTo(0.5, 10);
    expect(rampUpMiddle.orders).toBe(10);
  });

  it('負荷カーブのピーク区間は定常と同じ投入件数になる', () => {
    const peak = planTick({
      targetOrdersPerMinute: 1_200,
      elapsedMs: 600 * 1_000 * (RAMP_UP_FRACTION + PEAK_FRACTION / 2),
      durationSeconds: 600,
      useRampCurve: true,
      carry: 0,
    });
    expect(peak.factor).toBe(1);
    expect(peak.orders).toBe(20);
  });
});

describe('resolveTickAction（要件 11.9、design 論点 2）', () => {
  it('残り時間が十分なら投入を続ける', () => {
    expect(
      resolveTickAction({
        elapsedMs: 10_000,
        durationSeconds: 600,
        remainingInvokeMs: 600_000,
      })
    ).toBe('TICK');
  });

  it('残り時間が閾値を切ったら引き継ぐ', () => {
    expect(
      resolveTickAction({
        elapsedMs: 10_000,
        durationSeconds: 600,
        remainingInvokeMs: HANDOFF_THRESHOLD_MS,
      })
    ).toBe('HANDOFF');
  });

  it('継続時間に達したら完了する', () => {
    expect(
      resolveTickAction({
        elapsedMs: 600_000,
        durationSeconds: 600,
        remainingInvokeMs: 600_000,
      })
    ).toBe('FINISH');
  });

  it('継続時間の判定が残り時間の判定より先に効く（空の世代を作らない）', () => {
    expect(
      resolveTickAction({
        elapsedMs: 600_000,
        durationSeconds: 600,
        remainingInvokeMs: 1_000,
      })
    ).toBe('FINISH');
  });

  it('閾値は引数で上書きできる', () => {
    expect(
      resolveTickAction({
        elapsedMs: 0,
        durationSeconds: 600,
        remainingInvokeMs: 40_000,
        handoffThresholdMs: 60_000,
      })
    ).toBe('HANDOFF');
  });
});

describe('expectedOrdersPerMinute（design 論点 2 の区間表）', () => {
  it('定常負荷なら目標そのまま', () => {
    expect(
      expectedOrdersPerMinute({ targetOrdersPerMinute: 1_000, useRampCurve: false })
    ).toBe(1_000);
  });

  it('負荷カーブなら目標 × 0.7（漸増 0.5 + ピーク 1 + 漸減 0.5 の加重平均）', () => {
    expect(AVERAGE_RAMP_FACTOR).toBeCloseTo(0.7, 10);
    expect(
      expectedOrdersPerMinute({ targetOrdersPerMinute: 1_000, useRampCurve: true })
    ).toBeCloseTo(700, 10);
  });
});

describe('evaluateRate（要件 11.11、design 論点 10）', () => {
  it('投入件数と経過時間から実測レートを算出する', () => {
    const rate = evaluateRate({
      targetOrdersPerMinute: 1_200,
      useRampCurve: false,
      submittedCount: 12_000,
      elapsedMs: 600_000,
    });
    expect(rate.actualOrdersPerMinute).toBe(1_200);
    expect(rate.deviationRatio).toBe(0);
    expect(rate.rateDeviationWarning).toBe(false);
  });

  it('乖離が閾値以内なら警告を立てない', () => {
    // 5% 不足
    const rate = evaluateRate({
      targetOrdersPerMinute: 1_000,
      useRampCurve: false,
      submittedCount: 9_500,
      elapsedMs: 600_000,
    });
    expect(rate.deviationRatio).toBeCloseTo(0.05, 10);
    expect(rate.rateDeviationWarning).toBe(false);
  });

  it('乖離が閾値を超えたら警告を立てる（この実行は §2.4 の算術に使わない）', () => {
    // 20% 不足
    const rate = evaluateRate({
      targetOrdersPerMinute: 1_000,
      useRampCurve: false,
      submittedCount: 8_000,
      elapsedMs: 600_000,
    });
    expect(rate.deviationRatio).toBeCloseTo(0.2, 10);
    expect(rate.rateDeviationWarning).toBe(true);
  });

  it('目標を上回った側の乖離も警告になる（絶対値で判定する）', () => {
    const rate = evaluateRate({
      targetOrdersPerMinute: 1_000,
      useRampCurve: false,
      submittedCount: 13_000,
      elapsedMs: 600_000,
    });
    expect(rate.rateDeviationWarning).toBe(true);
  });

  it('負荷カーブでは平均係数を織り込むため、目標の 7 割でも警告にならない', () => {
    const rate = evaluateRate({
      targetOrdersPerMinute: 1_000,
      useRampCurve: true,
      submittedCount: 7_000,
      elapsedMs: 600_000,
    });
    expect(rate.expectedOrdersPerMinute).toBeCloseTo(700, 10);
    expect(rate.actualOrdersPerMinute).toBe(700);
    expect(rate.rateDeviationWarning).toBe(false);
  });

  it('負荷カーブで目標どおりのレートが出ていたら乖離として扱う（3 割の過剰）', () => {
    const rate = evaluateRate({
      targetOrdersPerMinute: 1_000,
      useRampCurve: true,
      submittedCount: 10_000,
      elapsedMs: 600_000,
    });
    expect(rate.rateDeviationWarning).toBe(true);
  });

  it('閾値は既定 10% である', () => {
    expect(RATE_DEVIATION_THRESHOLD).toBe(0.1);
    const justInside = evaluateRate({
      targetOrdersPerMinute: 1_000,
      useRampCurve: false,
      submittedCount: 9_000,
      elapsedMs: 600_000,
    });
    expect(justInside.deviationRatio).toBeCloseTo(0.1, 10);
    expect(justInside.rateDeviationWarning).toBe(false);
  });

  it('経過時間が 0 なら 0 件/分として扱い、警告も立てない', () => {
    const rate = evaluateRate({
      targetOrdersPerMinute: 1_000,
      useRampCurve: false,
      submittedCount: 0,
      elapsedMs: 0,
    });
    expect(rate.actualOrdersPerMinute).toBe(0);
    expect(rate.rateDeviationWarning).toBe(false);
  });

  it('低レートでも小数第 1 位まで残る（2 件/分の実行が 0 に潰れない）', () => {
    const rate = evaluateRate({
      targetOrdersPerMinute: 2,
      useRampCurve: false,
      submittedCount: 3,
      elapsedMs: 90_000,
    });
    expect(rate.actualOrdersPerMinute).toBe(2);
  });
});
