import { describe, expect, it } from 'vitest';
import {
  ORDER_ID_ANNOTATION,
  withOrderSubsegment,
  type OrderTracer,
} from './tracing.js';

/**
 * `withOrderSubsegment` の単体テスト（要件 13.4、design §6.3）。
 *
 * ここで確かめたいのは 2 つだけである。
 *
 * 1. **注釈がサブセグメントの中で行われること。** Lambda のファサードセグメントに
 *    直接注釈すると Powertools が黙って捨てるため、この順序が崩れると
 *    「トレースは出るが `order_id` で引けない」という気づきにくい壊れ方をする。
 * 2. **計装の失敗が業務処理に影響しないこと。** 観測の仕組みが
 *    リクエストの成否を左右してはならない。
 *
 * X-Ray への実際の送信はデプロイ後の検証で確かめる（design §12）。
 */

type Call =
  | { kind: 'addNewSubsegment'; name: string }
  | { kind: 'setSegment'; target: string }
  | { kind: 'putAnnotation'; key: string; value: string }
  | { kind: 'addError'; message: string }
  | { kind: 'close' }
  | { kind: 'execute' };

/**
 * 呼び出し順を記録する `Tracer` の代役。
 *
 * 順序そのものが検証対象（注釈はサブセグメントを現在のセグメントにした後）なので、
 * 呼び出しを 1 本の配列に集める。
 */
function createTracerSpy(options: { segment?: 'facade' | 'none' } = {}) {
  const calls: Call[] = [];

  const subsegment = {
    addNewSubsegment: (name: string) => {
      calls.push({ kind: 'addNewSubsegment', name });
      return subsegment;
    },
    addError: (error: Error) => {
      calls.push({ kind: 'addError', message: error.message });
    },
    close: () => {
      calls.push({ kind: 'close' });
    },
  };

  const facade = {
    addNewSubsegment: (name: string) => {
      calls.push({ kind: 'addNewSubsegment', name });
      return subsegment;
    },
  };

  const tracer: OrderTracer = {
    getSegment: () => (options.segment === 'none' ? undefined : facade),
    setSegment: (target) => {
      calls.push({ kind: 'setSegment', target: target === facade ? 'facade' : 'sub' });
    },
    putAnnotation: (key, value) => {
      calls.push({ kind: 'putAnnotation', key, value });
    },
  };

  return { tracer, calls };
}

describe('withOrderSubsegment', () => {
  it('サブセグメントを開き、その中で order_id を注釈する（ファサードセグメントには付けない）', async () => {
    const { tracer, calls } = createTracerSpy();

    const result = await withOrderSubsegment(
      { tracer, name: '## processOrder', orderId: 'ORD#01J000000000000000000000' },
      async () => {
        calls.push({ kind: 'execute' });
        return 'done';
      }
    );

    expect(result).toBe('done');
    expect(calls).toEqual([
      { kind: 'addNewSubsegment', name: '## processOrder' },
      { kind: 'setSegment', target: 'sub' },
      {
        kind: 'putAnnotation',
        key: ORDER_ID_ANNOTATION,
        value: 'ORD#01J000000000000000000000',
      },
      { kind: 'execute' },
      { kind: 'close' },
      { kind: 'setSegment', target: 'facade' },
    ]);
  });

  it('注釈キーは 3 つの関数で共有する order_id である（design §6.3）', () => {
    expect(ORDER_ID_ANNOTATION).toBe('order_id');
  });

  it('例外はサブセグメントに記録してから再送出する', async () => {
    const { tracer, calls } = createTracerSpy();
    const failure = new Error('PutItem に失敗');

    await expect(
      withOrderSubsegment({ tracer, name: '## acceptOrder', orderId: 'ORD#1' }, () =>
        Promise.reject(failure)
      )
    ).rejects.toBe(failure);

    expect(calls).toEqual([
      { kind: 'addNewSubsegment', name: '## acceptOrder' },
      { kind: 'setSegment', target: 'sub' },
      { kind: 'putAnnotation', key: ORDER_ID_ANNOTATION, value: 'ORD#1' },
      { kind: 'addError', message: 'PutItem に失敗' },
      { kind: 'close' },
      { kind: 'setSegment', target: 'facade' },
    ]);
  });

  it('セグメント文脈がない環境でも業務処理はそのまま実行する', async () => {
    const { tracer, calls } = createTracerSpy({ segment: 'none' });

    await expect(
      withOrderSubsegment({ tracer, name: '## getOrder', orderId: 'ORD#1' }, () =>
        Promise.resolve('done')
      )
    ).resolves.toBe('done');

    expect(calls).toEqual([]);
  });

  it('サブセグメントを開けなくても業務処理は成功する（計装は可用性に影響しない）', async () => {
    const tracer: OrderTracer = {
      getSegment: () => ({
        addNewSubsegment: () => {
          throw new Error('X-Ray SDK の失敗');
        },
      }),
      setSegment: () => {},
      putAnnotation: () => {},
    };

    await expect(
      withOrderSubsegment({ tracer, name: '## getOrder', orderId: 'ORD#1' }, () =>
        Promise.resolve('done')
      )
    ).resolves.toBe('done');
  });

  it('サブセグメントを閉じられなくても業務処理の結果を変えない', async () => {
    const tracer: OrderTracer = {
      getSegment: () => ({
        addNewSubsegment: () => ({
          addNewSubsegment: () => {
            throw new Error('使わない');
          },
          addError: () => {},
          close: () => {
            throw new Error('close の失敗');
          },
        }),
      }),
      setSegment: () => {},
      putAnnotation: () => {},
    };

    await expect(
      withOrderSubsegment({ tracer, name: '## processOrder', orderId: 'ORD#1' }, () =>
        Promise.resolve('done')
      )
    ).resolves.toBe('done');
  });
});
