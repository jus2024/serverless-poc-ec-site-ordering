import { describe, expect, it } from 'vitest';
import { MAX_WORKER_GENERATIONS } from './load-plan.js';
import type { LoadTestParams } from './load-test-request.js';
import {
  LOAD_WORKER_MODE,
  assertWorkerGeneration,
  buildFirstWorkerEvent,
  buildNextWorkerEvent,
  isLoadWorkerEvent,
} from './worker-event.js';

/**
 * 自己再帰ワーカーのペイロードの単体テスト（要件 11.9、design 論点 2 / §E-6）。
 *
 * 確かめるのは 3 点。
 *
 * 1. 実行の起点（`startedAtMs`）が世代を跨いで変わらないこと
 *    （変わると負荷カーブの進捗率が巻き戻り、漸増区間を繰り返す）
 * 2. 累積した投入件数と端数が引き継がれること（要件 11.11 の実測レートの分子）
 * 3. API Gateway イベントをワーカー呼び出しと誤認しないこと
 */

const PARAMS: LoadTestParams = {
  ordersPerMinute: 1_000,
  durationSeconds: 1_800,
  useRampCurve: true,
};

const FIRST = buildFirstWorkerEvent({
  executionId: 'LOAD#01JC0000000000000000000000',
  params: PARAMS,
  startedAtMs: 1_700_000_000_000,
});

describe('buildFirstWorkerEvent', () => {
  it('第 1 世代を件数 0 で始める', () => {
    expect(FIRST).toEqual({
      mode: LOAD_WORKER_MODE,
      executionId: 'LOAD#01JC0000000000000000000000',
      params: PARAMS,
      startedAtMs: 1_700_000_000_000,
      submittedCount: 0,
      submitErrorCount: 0,
      carry: 0,
      plannedTotal: 0,
      generation: 1,
    });
  });
});

describe('buildNextWorkerEvent（要件 11.9）', () => {
  const next = buildNextWorkerEvent(FIRST, {
    submittedCount: 12_345,
    submitErrorCount: 7,
    carry: 0.4,
    plannedTotal: 12_352,
  });

  it('世代を 1 つ進める', () => {
    expect(next.generation).toBe(2);
  });

  it('実行の起点を変えない（負荷カーブの進捗率が巻き戻らない）', () => {
    expect(next.startedAtMs).toBe(FIRST.startedAtMs);
  });

  it('実行 ID とパラメータを引き継ぐ（ワーカーで再検証しない）', () => {
    expect(next.executionId).toBe(FIRST.executionId);
    expect(next.params).toEqual(PARAMS);
  });

  it('累積した投入件数と端数と計画総数を引き継ぐ', () => {
    expect(next.submittedCount).toBe(12_345);
    expect(next.submitErrorCount).toBe(7);
    expect(next.carry).toBe(0.4);
    expect(next.plannedTotal).toBe(12_352);
  });

  it('元のペイロードを変更しない', () => {
    expect(FIRST.generation).toBe(1);
    expect(FIRST.submittedCount).toBe(0);
  });
});

describe('assertWorkerGeneration', () => {
  it('上限までは通す', () => {
    expect(() => {
      assertWorkerGeneration(MAX_WORKER_GENERATIONS);
    }).not.toThrow();
  });

  it('上限を超えたら例外にする（暴走した自己 invoke を打ち切る）', () => {
    expect(() => {
      assertWorkerGeneration(MAX_WORKER_GENERATIONS + 1);
    }).toThrow(/世代数が上限/);
  });
});

describe('isLoadWorkerEvent', () => {
  it('ワーカーのペイロードを判別する', () => {
    expect(isLoadWorkerEvent(FIRST)).toBe(true);
  });

  it('JSON を経由しても判別できる（非同期 invoke は直列化される）', () => {
    expect(isLoadWorkerEvent(JSON.parse(JSON.stringify(FIRST)))).toBe(true);
  });

  it('API Gateway イベントを誤認しない', () => {
    expect(
      isLoadWorkerEvent({
        httpMethod: 'POST',
        path: '/load-test/start',
        body: '{"ordersPerMinute":100,"durationSeconds":60}',
      })
    ).toBe(false);
  });

  it.each([
    ['mode が違う', { ...FIRST, mode: 'QUERY_IMPACT_WORKER' }],
    ['実行 ID が無い', { ...FIRST, executionId: undefined }],
    ['params が無い', { ...FIRST, params: undefined }],
    ['params が欠けている', { ...FIRST, params: { ordersPerMinute: 100 } }],
    ['起点時刻が文字列', { ...FIRST, startedAtMs: '1700000000000' }],
    ['計画総数が無い', { ...FIRST, plannedTotal: undefined }],
    ['世代が無い', { ...FIRST, generation: undefined }],
    ['null', null],
    ['配列', []],
    ['文字列', 'LOAD_WORKER'],
  ])('%s なら false', (_label, event) => {
    expect(isLoadWorkerEvent(event)).toBe(false);
  });
});
