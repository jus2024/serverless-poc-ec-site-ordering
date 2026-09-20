import { describe, expect, it } from 'vitest';
import { PEAK_FRACTION, RAMP_UP_FRACTION } from '../shared/load-curve.js';
import {
  AVERAGE_RAMP_FACTOR,
  HANDOFF_THRESHOLD_MS,
  RATE_DEVIATION_THRESHOLD,
  TICK_INTERVAL_MS,
  evaluateRate,
  expectedOrdersPerMinute,
  planBackfill,
  planTick,
  resolveTickAction,
  theoreticalTotalOrders,
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

/**
 * ワーカーの投入ループを純粋関数だけで再現するヘルパー。
 *
 * `handler.ts` の `runWorker` を時間と AWS 抜きで写したもの。
 * 1 秒刻みで `planTick` を回して計画件数を `plannedTotal` に積み上げ、
 * 継続時間に達した刻み（FINISH）では `planBackfill` で
 * 「理論総数 − plannedTotal」をまとめて投入する。これが実機のループ
 * （FINISH がループ先頭で判定され、投入前に return する）と同じ順序であることを保証する。
 */
function simulateWorkerFlow(input: {
  targetOrdersPerMinute: number;
  durationSeconds: number;
  useRampCurve: boolean;
}): number {
  let carry = 0;
  let submitted = 0;
  let plannedTotal = 0;
  const durationMs = input.durationSeconds * 1_000;

  for (let tick = 0; ; tick += 1) {
    const elapsedMs = tick * TICK_INTERVAL_MS;

    // resolveTickAction 相当（継続時間の判定を先に行う）
    if (elapsedMs >= durationMs) {
      const backfill = planBackfill({
        targetOrdersPerMinute: input.targetOrdersPerMinute,
        durationSeconds: input.durationSeconds,
        useRampCurve: input.useRampCurve,
        plannedTotal,
      });
      submitted += backfill.orders;
      return submitted;
    }

    // handler.ts のループを忠実に写す。ループ先頭で lastTickAtMs = Date.now()
    // としてから 1 刻み目に入るため、**最初の刻みの tickMs は約 0**になる。
    // この「先頭の刻みが実質 0 秒」というずれが、末尾で取りこぼしていた
    // 元の不具合の実態である（planBackfill で理論総数まで埋め戻す）。
    const tickMs = tick === 0 ? 0 : TICK_INTERVAL_MS;
    const plan = planTick({
      targetOrdersPerMinute: input.targetOrdersPerMinute,
      elapsedMs,
      durationSeconds: input.durationSeconds,
      useRampCurve: input.useRampCurve,
      carry,
      tickMs,
    });
    carry = plan.carry;
    plannedTotal += plan.orders;
    submitted += plan.orders;
  }
}

/**
 * 世代を跨いだワーカーの投入ループを再現するヘルパー（世代引き継ぎの回帰）。
 *
 * `handoffSeconds` ごとに世代を切り替え、`carry` と `plannedTotal` を次世代へ
 * 引き継ぐ（`buildNextWorkerEvent` 相当）。FINISH（最終世代）でのみ
 * `planBackfill` を適用する。`plannedTotal` を引き継がないと最終世代が
 * 実行全体の計画総数を知らず、理論総数との差を誤って過剰投入することを防ぐ。
 */
function simulateWorkerFlowAcrossGenerations(input: {
  targetOrdersPerMinute: number;
  durationSeconds: number;
  useRampCurve: boolean;
  handoffSeconds: number;
}): number {
  let carry = 0;
  let submitted = 0;
  let plannedTotal = 0;
  const durationMs = input.durationSeconds * 1_000;
  const handoffMs = input.handoffSeconds * 1_000;

  for (let tick = 0, ticksThisGeneration = 0; ; tick += 1, ticksThisGeneration += 1) {
    const elapsedMs = tick * TICK_INTERVAL_MS;

    if (elapsedMs >= durationMs) {
      const backfill = planBackfill({
        targetOrdersPerMinute: input.targetOrdersPerMinute,
        durationSeconds: input.durationSeconds,
        useRampCurve: input.useRampCurve,
        plannedTotal,
      });
      submitted += backfill.orders;
      return submitted;
    }

    // 世代の切り替わり（HANDOFF）。carry と plannedTotal は引き継がれ、
    // 次世代の先頭刻みの tickMs は約 0 になる（世代ごとに lastTickAtMs をリセット）
    const isGenerationStart = elapsedMs > 0 && elapsedMs % handoffMs === 0;
    if (isGenerationStart) {
      ticksThisGeneration = 0;
    }
    const tickMs = ticksThisGeneration === 0 ? 0 : TICK_INTERVAL_MS;

    const plan = planTick({
      targetOrdersPerMinute: input.targetOrdersPerMinute,
      elapsedMs,
      durationSeconds: input.durationSeconds,
      useRampCurve: input.useRampCurve,
      carry,
      tickMs,
    });
    carry = plan.carry;
    plannedTotal += plan.orders;
    submitted += plan.orders;
  }
}

/**
 * 末尾処理を入れない旧ロジックの投入総数（回帰の対照用）。
 *
 * FINISH でそのまま完了し、末尾の端数を確定しない。2 件/分 × 60 秒 では
 * これが 1 件になり、実測が目標の半分に落ちていた。
 */
function simulateLegacyWorkerFlow(input: {
  targetOrdersPerMinute: number;
  durationSeconds: number;
  useRampCurve: boolean;
}): number {
  let carry = 0;
  let submitted = 0;
  const durationMs = input.durationSeconds * 1_000;

  for (let tick = 0; ; tick += 1) {
    const elapsedMs = tick * TICK_INTERVAL_MS;
    if (elapsedMs >= durationMs) {
      return submitted;
    }
    const tickMs = tick === 0 ? 0 : TICK_INTERVAL_MS;
    const plan = planTick({
      targetOrdersPerMinute: input.targetOrdersPerMinute,
      elapsedMs,
      durationSeconds: input.durationSeconds,
      useRampCurve: input.useRampCurve,
      carry,
      tickMs,
    });
    carry = plan.carry;
    submitted += plan.orders;
  }
}

describe('theoreticalTotalOrders（理論総数）', () => {
  it('定常負荷は floor(rate * duration / 60)', () => {
    expect(
      theoreticalTotalOrders({
        targetOrdersPerMinute: 2,
        durationSeconds: 60,
        useRampCurve: false,
      })
    ).toBe(2);
    expect(
      theoreticalTotalOrders({
        targetOrdersPerMinute: 60,
        durationSeconds: 60,
        useRampCurve: false,
      })
    ).toBe(60);
    expect(
      theoreticalTotalOrders({
        targetOrdersPerMinute: 2_000,
        durationSeconds: 60,
        useRampCurve: false,
      })
    ).toBe(2_000);
  });

  it('2 件/分 × 30 秒 は floor(2 * 30 / 60) = 1', () => {
    expect(
      theoreticalTotalOrders({
        targetOrdersPerMinute: 2,
        durationSeconds: 30,
        useRampCurve: false,
      })
    ).toBe(1);
  });

  it('カーブは floor(rate * duration / 60 * 0.7)', () => {
    // 1200 * 600 / 60 * 0.7 = 8400
    expect(
      theoreticalTotalOrders({
        targetOrdersPerMinute: 1_200,
        durationSeconds: 600,
        useRampCurve: true,
      })
    ).toBe(8_400);
  });
});

describe('planBackfill（理論総数ベースの末尾補填）', () => {
  it('計画総数が理論総数に満たなければ差を補填する', () => {
    // 2 件/分 × 60 秒 の理論総数は 2。plannedTotal が 1 なら残り 1 件を補填
    expect(
      planBackfill({
        targetOrdersPerMinute: 2,
        durationSeconds: 60,
        useRampCurve: false,
        plannedTotal: 1,
      }).orders
    ).toBe(1);
  });

  it('計画総数が理論総数に達していれば 0（過不足なし）', () => {
    expect(
      planBackfill({
        targetOrdersPerMinute: 60,
        durationSeconds: 60,
        useRampCurve: false,
        plannedTotal: 60,
      }).orders
    ).toBe(0);
  });

  it('計画総数が理論総数を超えていても負にならない（過剰投入しない）', () => {
    expect(
      planBackfill({
        targetOrdersPerMinute: 60,
        durationSeconds: 60,
        useRampCurve: false,
        plannedTotal: 65,
      }).orders
    ).toBe(0);
  });
});

describe('末尾の取りこぼし修正（実行フローの回帰）', () => {
  it('2 件/分 × 60 秒 は理論どおり 2 件になる（実機で 1 件だった回帰の主眼）', () => {
    const config = {
      targetOrdersPerMinute: 2,
      durationSeconds: 60,
      useRampCurve: false,
    } as const;
    // 旧ロジックは末尾を取りこぼして 1 件だった（実測 1.0 件/分・乖離 50%）
    expect(simulateLegacyWorkerFlow(config)).toBe(1);
    // 理論総数ベースの補填で 2 件になる
    expect(simulateWorkerFlow(config)).toBe(2);
  });

  it('2 件/分 × 60 秒 で 3 件以上にはならない（過剰投入しない）', () => {
    expect(
      simulateWorkerFlow({
        targetOrdersPerMinute: 2,
        durationSeconds: 60,
        useRampCurve: false,
      })
    ).toBeLessThanOrEqual(2);
  });

  it('60 件/分 × 60 秒 はちょうど 60 件になる（過不足なし）', () => {
    expect(
      simulateWorkerFlow({
        targetOrdersPerMinute: 60,
        durationSeconds: 60,
        useRampCurve: false,
      })
    ).toBe(60);
  });

  it('2000 件/分 × 60 秒 はちょうど 2000 件で過剰投入しない', () => {
    const config = {
      targetOrdersPerMinute: 2_000,
      durationSeconds: 60,
      useRampCurve: false,
    } as const;
    const fixed = simulateWorkerFlow(config);
    const theoretical = theoreticalTotalOrders(config);
    expect(theoretical).toBe(2_000);
    expect(fixed).toBe(2_000);
    expect(fixed).toBeLessThanOrEqual(theoretical);
    // 末尾処理は取りこぼしを埋め戻す方向にのみ働く（件数を減らさない）
    expect(fixed).toBeGreaterThanOrEqual(simulateLegacyWorkerFlow(config));
  });

  it('2 件/分 × 30 秒 は 1 件になる（floor(2 * 30 / 60) = 1）', () => {
    expect(
      simulateWorkerFlow({
        targetOrdersPerMinute: 2,
        durationSeconds: 30,
        useRampCurve: false,
      })
    ).toBe(1);
  });

  it('補填は理論総数ちょうどに収束させ、継続時間が長いほど埋め戻し量の割合は縮む', () => {
    const target = 2_000;
    for (const durationSeconds of [60, 600, 3_600]) {
      const config = {
        targetOrdersPerMinute: target,
        durationSeconds,
        useRampCurve: false,
      } as const;
      const fixed = simulateWorkerFlow(config);
      const legacy = simulateLegacyWorkerFlow(config);
      const theoretical = theoreticalTotalOrders(config);
      // 修正版は常に理論値ちょうど
      expect(fixed).toBe(theoretical);
      // 埋め戻し量は高々 1 刻み分（rate/60）で頭打ち
      expect(fixed - legacy).toBeLessThanOrEqual(Math.ceil(target / 60));
    }
  });

  it('カーブ 1200 件/分 × 600 秒 は理論総数 8400 を超えない', () => {
    const config = {
      targetOrdersPerMinute: 1_200,
      durationSeconds: 600,
      useRampCurve: true,
    } as const;
    const submitted = simulateWorkerFlow(config);
    const theoretical = theoreticalTotalOrders(config);
    expect(theoretical).toBe(8_400);
    expect(submitted).toBeLessThanOrEqual(theoretical);
    // 取りこぼしが大きくない（末尾 1 件程度）ことも確認
    expect(submitted).toBeGreaterThanOrEqual(theoretical - 1);
  });
});

describe('世代引き継ぎ（plannedTotal を跨いで理論総数ちょうどにする）', () => {
  it('定常 2 件/分 × 60 秒 を複数世代に分割しても 2 件ちょうど（過剰投入しない）', () => {
    // 15 秒ごとに世代を切り替えても、plannedTotal を引き継ぐため最終世代の
    // 補填が実行全体の理論総数に合わせる。引き継がないと最終世代が自分の
    // 計画数（0 件）しか知らず、理論総数 2 との差 2 件を余分に投入してしまう
    const submitted = simulateWorkerFlowAcrossGenerations({
      targetOrdersPerMinute: 2,
      durationSeconds: 60,
      useRampCurve: false,
      handoffSeconds: 15,
    });
    expect(submitted).toBe(2);
  });

  it('大量 2000 件/分 × 60 秒 を複数世代に分割しても 2000 件ちょうど', () => {
    const submitted = simulateWorkerFlowAcrossGenerations({
      targetOrdersPerMinute: 2_000,
      durationSeconds: 60,
      useRampCurve: false,
      handoffSeconds: 20,
    });
    expect(submitted).toBe(2_000);
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
