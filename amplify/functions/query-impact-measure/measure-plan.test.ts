import { describe, expect, it } from 'vitest';
import {
  FINALIZE_RESERVE_MS,
  MAX_LATENCY_SAMPLES,
  resolveMeasureAction,
} from './measure-plan.js';
import { MAX_MEASURE_DURATION_SECONDS } from './measure-request.js';

/**
 * 計測ループの打ち切り判定の単体テスト（要件 12.1 / 12.3）。
 */

const BASE = {
  elapsedMs: 0,
  durationSeconds: 120,
  remainingInvokeMs: 600_000,
  sampleCount: 0,
};

describe('resolveMeasureAction', () => {
  it('継続時間の途中は CONTINUE', () => {
    expect(resolveMeasureAction({ ...BASE, elapsedMs: 60_000 })).toEqual({
      action: 'CONTINUE',
    });
  });

  it('継続時間に達したら DURATION_REACHED で FINISH', () => {
    expect(resolveMeasureAction({ ...BASE, elapsedMs: 120_000 })).toEqual({
      action: 'FINISH',
      reason: 'DURATION_REACHED',
    });
  });

  it('継続時間の判定を残り時間より先に行う（測り切った実行を budget 切れと記録しない）', () => {
    expect(
      resolveMeasureAction({
        ...BASE,
        elapsedMs: 120_000,
        remainingInvokeMs: FINALIZE_RESERVE_MS,
      })
    ).toEqual({ action: 'FINISH', reason: 'DURATION_REACHED' });
  });

  it('残り時間が確保分を切ったら INVOKE_BUDGET で FINISH（結果を書けずに落ちない）', () => {
    expect(
      resolveMeasureAction({ ...BASE, remainingInvokeMs: FINALIZE_RESERVE_MS })
    ).toEqual({ action: 'FINISH', reason: 'INVOKE_BUDGET' });
    expect(
      resolveMeasureAction({ ...BASE, remainingInvokeMs: FINALIZE_RESERVE_MS - 1 })
    ).toEqual({ action: 'FINISH', reason: 'INVOKE_BUDGET' });
  });

  it('確保分より 1ms 多く残っていれば続ける', () => {
    expect(
      resolveMeasureAction({ ...BASE, remainingInvokeMs: FINALIZE_RESERVE_MS + 1 })
    ).toEqual({ action: 'CONTINUE' });
  });

  it('標本が上限に達したら SAMPLE_LIMIT で FINISH（標本を捨てて続けない）', () => {
    expect(
      resolveMeasureAction({ ...BASE, sampleCount: MAX_LATENCY_SAMPLES })
    ).toEqual({ action: 'FINISH', reason: 'SAMPLE_LIMIT' });
  });

  it('上限の 1 件手前では続ける', () => {
    expect(
      resolveMeasureAction({ ...BASE, sampleCount: MAX_LATENCY_SAMPLES - 1 })
    ).toEqual({ action: 'CONTINUE' });
  });

  it('閾値は引数で上書きできる（テストと検証で値を変えられる）', () => {
    expect(
      resolveMeasureAction({ ...BASE, sampleCount: 10, maxSamples: 10 })
    ).toEqual({ action: 'FINISH', reason: 'SAMPLE_LIMIT' });
    expect(
      resolveMeasureAction({
        ...BASE,
        remainingInvokeMs: 1_000,
        finalizeReserveMs: 500,
      })
    ).toEqual({ action: 'CONTINUE' });
  });
});

describe('打ち切り閾値の整合', () => {
  it('継続時間の上限と結果の書き出し分が Lambda のタイムアウト 15 分に収まる（design §5.2）', () => {
    expect(MAX_MEASURE_DURATION_SECONDS * 1_000 + FINALIZE_RESERVE_MS).toBeLessThanOrEqual(
      15 * 60 * 1_000
    );
  });
});
