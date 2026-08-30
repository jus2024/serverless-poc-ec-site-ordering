import { describe, expect, it } from 'vitest';
import type { MeasureParams } from './measure-request.js';
import {
  MEASURE_WORKER_MODE,
  buildMeasureWorkerEvent,
  isMeasureWorkerEvent,
} from './worker-event.js';

/**
 * ワーカー判別の単体テスト（要件 12.1、design §E-6）。
 *
 * 判別を誤ると API Gateway イベントとして処理され、計測の起動が
 * 「呼ばれたが何もしなかった」形で消える（実行レコードは `RUNNING` のまま残る）。
 */

const PARAMS: MeasureParams = {
  concurrency: 60,
  durationSeconds: 120,
  target: { kind: 'ORDER_LIST', customerId: 'test-0001' },
};

const EVENT = buildMeasureWorkerEvent({
  executionId: 'MEASURE#01JABCDE',
  params: PARAMS,
  targetUrl: 'https://example.execute-api.ap-northeast-1.amazonaws.com/prod/orders',
  startedAtMs: 1_700_000_000_000,
});

describe('buildMeasureWorkerEvent', () => {
  it('判別子と不変の情報だけを載せる（引き継がないので累積状態を持たない）', () => {
    expect(EVENT).toEqual({
      mode: MEASURE_WORKER_MODE,
      executionId: 'MEASURE#01JABCDE',
      params: PARAMS,
      targetUrl: 'https://example.execute-api.ap-northeast-1.amazonaws.com/prod/orders',
      startedAtMs: 1_700_000_000_000,
    });
  });

  it('世代を持たない（1 invoke で測り切る。分位点を世代で切らないため）', () => {
    expect(EVENT).not.toHaveProperty('generation');
  });
});

describe('isMeasureWorkerEvent', () => {
  it('組み立てたペイロードを受け付ける', () => {
    expect(isMeasureWorkerEvent(EVENT)).toBe(true);
  });

  it('API Gateway プロキシイベントを受け付けない', () => {
    expect(
      isMeasureWorkerEvent({
        httpMethod: 'POST',
        path: '/measure/start',
        body: '{"concurrency":10,"durationSeconds":60}',
      })
    ).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['文字列', 'MEASURE_WORKER'],
    ['配列', []],
    ['空オブジェクト', {}],
  ])('%s を受け付けない', (_label, event) => {
    expect(isMeasureWorkerEvent(event)).toBe(false);
  });

  it.each([
    ['mode', { ...EVENT, mode: 'LOAD_WORKER' }],
    ['executionId', { ...EVENT, executionId: 123 }],
    ['targetUrl', { ...EVENT, targetUrl: undefined }],
    ['startedAtMs', { ...EVENT, startedAtMs: '1700000000000' }],
    ['params', { ...EVENT, params: undefined }],
    ['params.concurrency', { ...EVENT, params: { ...PARAMS, concurrency: '60' } }],
    ['params.target', { ...EVENT, params: { ...PARAMS, target: null } }],
  ])('%s が壊れていれば受け付けない', (_label, event) => {
    expect(isMeasureWorkerEvent(event)).toBe(false);
  });

  it('負荷生成のワーカーイベントを受け付けない（実行管理テーブルは共用）', () => {
    expect(
      isMeasureWorkerEvent({
        mode: 'LOAD_WORKER',
        executionId: 'LOAD#01JABCDE',
        params: { ordersPerMinute: 100, durationSeconds: 60, useRampCurve: false },
        startedAtMs: 1_700_000_000_000,
        submittedCount: 0,
        submitErrorCount: 0,
        carry: 0,
        generation: 1,
      })
    ).toBe(false);
  });
});
