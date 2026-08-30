import type { AttributeValue, DynamoDBRecord } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import {
  InvalidStreamRecordError,
  PROCESSED_EVENT_NAME,
  buildBatchItemFailures,
  isProcessedEvent,
  sequenceNumberOf,
  toStreamOrder,
} from './stream-record.js';

/**
 * ストリームレコードの読み取りと部分バッチ応答の単体テスト
 * （design §5.5、要件 4.1 / 9.7 / 9.8、Property 8）。
 *
 * 検証の主眼は 3 点。
 *
 * 1. `NewImage` だけで 4 段階が回る情報が揃うこと（注文テーブルを読み直さない）
 * 2. `INSERT` 以外を処理しないこと（フィルタ設定漏れによる無限ループを止める）
 * 3. 最初に失敗したレコード**以降**が再試行対象になること（順序保証との整合）
 */

const ORDER_ID = 'ORD#01J000000000000000000000';
const CUSTOMER_ID = 'CUST#test-0001';
const SKU = 'ITEM#ETH-YIRG-G1-MEDIUM-200G';

/** 注文レコードの `NewImage`（DynamoDB の属性値表現） */
function newImage(
  overrides: Record<string, AttributeValue> = {}
): Record<string, AttributeValue> {
  return {
    order_id: { S: ORDER_ID },
    customer_id: { S: CUSTOMER_ID },
    order_status: { S: 'PENDING' },
    total_amount: { N: '3600' },
    items: {
      L: [{ M: { sku: { S: SKU }, qty: { N: '2' }, price: { N: '1800' } } }],
    },
    ...overrides,
  };
}

/**
 * ストリームレコードを組み立てる。
 *
 * `NewImage` を持たないレコードは `null` で表す（`undefined` を渡すと
 * 既定引数が効いて `newImage()` に戻ってしまう）。
 */
function record(
  image: Record<string, AttributeValue> | null = newImage(),
  options: { eventName?: DynamoDBRecord['eventName']; sequenceNumber?: string } = {}
): DynamoDBRecord {
  return {
    eventName: options.eventName ?? PROCESSED_EVENT_NAME,
    dynamodb: {
      SequenceNumber: options.sequenceNumber ?? '100000000000000001',
      NewImage: image ?? undefined,
    },
  };
}

describe('isProcessedEvent（要件 9.7 / Property 8）', () => {
  it('INSERT のみを処理対象にする', () => {
    expect(isProcessedEvent(record())).toBe(true);
  });

  it('MODIFY と REMOVE を処理対象にしない（自身の更新で再帰しない）', () => {
    expect(isProcessedEvent(record(newImage(), { eventName: 'MODIFY' }))).toBe(false);
    expect(isProcessedEvent(record(newImage(), { eventName: 'REMOVE' }))).toBe(false);
  });

  it('イベント種別が無いレコードを処理対象にしない', () => {
    expect(isProcessedEvent({})).toBe(false);
  });
});

describe('toStreamOrder（要件 4.1、design §5.5）', () => {
  it('NewImage から 4 段階に必要な情報を取り出す（テーブルを読み直さない）', () => {
    expect(toStreamOrder(record())).toEqual({
      orderId: ORDER_ID,
      customerId: CUSTOMER_ID,
      items: [{ sku: SKU, qty: 2, price: 1800 }],
      totalAmount: 3600,
      loadTestId: null,
    });
  });

  it('負荷テスト実行 ID があれば取り出す（ログの相関に使う）', () => {
    const order = toStreamOrder(record(newImage({ load_test_id: { S: 'EXEC#001' } })));
    expect(order.loadTestId).toBe('EXEC#001');
  });

  it('NewImage が無ければ処理できないレコードとして扱う', () => {
    expect(() => toStreamOrder(record(null))).toThrow(InvalidStreamRecordError);
  });

  it('必須属性が欠けていれば処理できないレコードとして扱う', () => {
    for (const key of ['order_id', 'customer_id', 'total_amount', 'items']) {
      const image = newImage();
      delete image[key];
      expect(() => toStreamOrder(record(image))).toThrow(InvalidStreamRecordError);
    }
  });

  it('明細が空の注文を通さない（アクションを持たない TransactWriteItems を作らない）', () => {
    expect(() => toStreamOrder(record(newImage({ items: { L: [] } })))).toThrow(
      InvalidStreamRecordError
    );
  });

  it('明細の数量が 1 以上の整数でなければ処理できないレコードとして扱う', () => {
    for (const qty of ['0', '-1', '1.5']) {
      const image = newImage({
        items: { L: [{ M: { sku: { S: SKU }, qty: { N: qty }, price: { N: '1800' } } }] },
      });
      expect(() => toStreamOrder(record(image))).toThrow(InvalidStreamRecordError);
    }
  });

  it('例外にシーケンス番号を添える（どのレコードが壊れているか特定できる）', () => {
    try {
      toStreamOrder(record(null, { sequenceNumber: '999' }));
      expect.unreachable('InvalidStreamRecordError が投げられていない');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidStreamRecordError);
      expect((error as InvalidStreamRecordError).sequenceNumber).toBe('999');
    }
  });
});

describe('sequenceNumberOf', () => {
  it('シーケンス番号を取り出す', () => {
    expect(sequenceNumberOf(record(newImage(), { sequenceNumber: '42' }))).toBe('42');
  });

  it('持たないレコードでは null を返す', () => {
    expect(sequenceNumberOf({})).toBeNull();
  });
});

describe('buildBatchItemFailures（design §5.5、要件 9.8）', () => {
  const records = ['1', '2', '3'].map((sequenceNumber) =>
    record(newImage(), { sequenceNumber })
  );

  it('最初に失敗したレコード以降をまとめて再試行対象にする（順序保証）', () => {
    expect(buildBatchItemFailures(records, 1)).toEqual([
      { itemIdentifier: '2' },
      { itemIdentifier: '3' },
    ]);
  });

  it('先頭で失敗した場合はバッチ全体が再試行対象になる', () => {
    expect(buildBatchItemFailures(records, 0)).toHaveLength(3);
  });

  it('末尾で失敗した場合は 1 件だけ再試行対象になる', () => {
    expect(buildBatchItemFailures(records, 2)).toEqual([{ itemIdentifier: '3' }]);
  });

  it('シーケンス番号を持たないレコードが含まれる場合は null を返す（部分報告しない）', () => {
    const withMissing = [records[0], {}, records[2]];
    expect(buildBatchItemFailures(withMissing, 0)).toBeNull();
  });
});
