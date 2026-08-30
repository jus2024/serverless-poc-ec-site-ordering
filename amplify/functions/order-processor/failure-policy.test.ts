import {
  IdempotencyAlreadyInProgressError,
  IdempotencyInconsistentStateError,
  IdempotencyPersistenceLayerError,
} from '@aws-lambda-powertools/idempotency';
import { ProvisionedThroughputExceededException } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { StagePreconditionError } from '../shared/order-status.js';
import { classifyProcessingFailure } from './failure-policy.js';
import { InvalidStreamRecordError } from './stream-record.js';

/**
 * 失敗の扱いの単体テスト（design §E-2 / §E-5、要件 9.8 / 16.7）。
 *
 * この分類が誤ると 2 通りの壊れ方をする。
 *
 * - 再試行すべき失敗を `SKIP` にすると、注文が `PENDING` のまま
 *   レコードは成功扱いでストリームから去る（**静かに消える**）
 * - 再試行すべきでない失敗を `RETRY` にすると、シャードの先頭が塞がり
 *   同一シャードの後続が遅延して `IteratorAge` に現れる（**観測値が汚れる**）
 *
 * どちらも実行時には気づきにくいため、分類は機械的に固定する。
 */

const ORDER_ID = 'ORD#01J000000000000000000000';

describe('classifyProcessingFailure', () => {
  it('レコードの形が不正な失敗は再試行しない（再試行しても同じ理由で失敗する）', () => {
    const error = new InvalidStreamRecordError('NewImage がありません', '100000000000000001');

    expect(classifyProcessingFailure(error)).toEqual({
      disposition: 'SKIP',
      kind: 'INVALID_RECORD',
    });
  });

  it('冪等性の競合は再試行する（次の試行で前回の結果を読んで冪等に返る。design §E-5）', () => {
    for (const error of [
      new IdempotencyAlreadyInProgressError('処理中です'),
      new IdempotencyInconsistentStateError('状態が変化しました'),
      new IdempotencyPersistenceLayerError('冪等性テーブルの読み書きに失敗しました'),
    ]) {
      expect(classifyProcessingFailure(error)).toEqual({
        disposition: 'RETRY',
        kind: 'IDEMPOTENCY',
      });
    }
  });

  it('COMPLETED の前提条件未達は再試行する（記録の取りこぼしにしない）', () => {
    const error = new StagePreconditionError('point', ORDER_ID);

    expect(classifyProcessingFailure(error)).toEqual({
      disposition: 'RETRY',
      kind: 'PRECONDITION',
    });
  });

  it('スロットルは再試行する（技術的な失敗。要件 16.7）', () => {
    const error = new ProvisionedThroughputExceededException({
      message: 'Throughput exceeded',
      $metadata: {},
    });

    expect(classifyProcessingFailure(error).disposition).toBe('RETRY');
  });

  it('判定できない例外は再試行に寄せる（気づける失敗の方を選ぶ）', () => {
    for (const error of [new Error('boom'), 'boom', undefined, null]) {
      expect(classifyProcessingFailure(error)).toEqual({
        disposition: 'RETRY',
        kind: 'UNKNOWN',
      });
    }
  });
});
