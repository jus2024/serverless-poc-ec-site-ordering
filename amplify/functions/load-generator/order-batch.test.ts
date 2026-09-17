import { describe, expect, it } from 'vitest';
import { CATALOG, calculateTotal } from '../shared/catalog.js';
import { CUSTOMER_ID_PREFIX, ORDER_ID_PREFIX } from '../shared/order-keys.js';
import { buildOrderRecord } from '../shared/order-record.js';
import {
  BATCH_WRITE_MAX_ITEMS,
  buildLoadTestOrders,
  chunkOrderWriteInputs,
  countBatchWriteItems,
  toRetryBatch,
} from './order-batch.js';

/**
 * 負荷生成の注文書き込みの単体テスト（要件 11.4 / 11.5 / 11.10、design 論点 2）。
 *
 * DynamoDB へは接続しない。確かめるのは 3 点。
 *
 * 1. 投入する注文レコードが `order-accept` と同じ形であること
 *    （食い違うと `order-processor` が受け取る `NewImage` が経路によって変わる）
 * 2. 25 件ずつに分割されること（26 件のリクエストはバッチごと失敗する）
 * 3. `UnprocessedItems` を落とさないこと（投入件数の過大計上を防ぐ。要件 11.11）
 */

const TABLE_NAME = 'kiro-roasters-orders-test';
const LOAD_TEST_ID = 'LOAD#01JC0000000000000000000000';
const SKUS = new Set(CATALOG.map((product) => product.sku));

describe('buildLoadTestOrders（要件 11.4 / 11.5）', () => {
  it('指定した件数を生成する', () => {
    expect(
      buildLoadTestOrders({ count: 7, loadTestId: LOAD_TEST_ID, dataTtlDays: 7 })
    ).toHaveLength(7);
  });

  it('0 件の指定では 1 件も生成しない（刻みの投入件数が 0 になり得る）', () => {
    expect(
      buildLoadTestOrders({ count: 0, loadTestId: LOAD_TEST_ID, dataTtlDays: 7 })
    ).toEqual([]);
  });

  it('全レコードに実行 ID が入る（要件 11.5。後から集計できる）', () => {
    const orders = buildLoadTestOrders({
      count: 5,
      loadTestId: LOAD_TEST_ID,
      dataTtlDays: 7,
    });
    for (const order of orders) {
      expect(order.load_test_id).toBe(LOAD_TEST_ID);
    }
  });

  it('注文 ID が重複しない', () => {
    const orders = buildLoadTestOrders({
      count: 200,
      loadTestId: LOAD_TEST_ID,
      dataTtlDays: 7,
    });
    expect(new Set(orders.map((order) => order.order_id)).size).toBe(200);
  });

  it('明細は商品マスタの SKU だけを含む（要件 11.4）', () => {
    const orders = buildLoadTestOrders({
      count: 50,
      loadTestId: LOAD_TEST_ID,
      dataTtlDays: 7,
    });
    for (const order of orders) {
      expect(order.items.length).toBeGreaterThan(0);
      for (const item of order.items) {
        expect(SKUS.has(item.sku)).toBe(true);
        expect(item.qty).toBeGreaterThan(0);
      }
      expect(order.total_amount).toBe(calculateTotal(order.items));
    }
  });

  it('order-accept が書くレコードと同じ初期状態である（`order-processor` が受け取る形を揃える）', () => {
    const nowMs = Date.UTC(2025, 0, 1, 0, 0, 0);
    const [generated] = buildLoadTestOrders({
      count: 1,
      loadTestId: LOAD_TEST_ID,
      dataTtlDays: 7,
      nowMs,
    });
    const accepted = buildOrderRecord({
      request: { loadTestId: LOAD_TEST_ID },
      dataTtlDays: 7,
      nowMs,
    });

    expect(generated.order_status).toBe('PENDING');
    expect(generated.stages_done).toBe(0);
    expect(generated.pipeline_mode).toBe('direct');
    expect(generated.point_earned).toBe(0);
    expect(generated.expires_at).toBe(accepted.expires_at);
    expect(generated.order_id.startsWith(ORDER_ID_PREFIX)).toBe(true);
    expect(generated.customer_id.startsWith(CUSTOMER_ID_PREFIX)).toBe(true);
    // 属性の集合が一致すること（片方だけ属性が増減していないこと）
    expect(Object.keys(generated).sort()).toEqual(Object.keys(accepted).sort());
  });

  it('段階属性を持たない（「存在しないこと」が二重実行の検知条件。design §5.4）', () => {
    const [order] = buildLoadTestOrders({
      count: 1,
      loadTestId: LOAD_TEST_ID,
      dataTtlDays: 7,
    });
    expect(order).not.toHaveProperty('payment_status');
    expect(order).not.toHaveProperty('allocation_status');
    expect(order).not.toHaveProperty('notification_status');
    expect(order).not.toHaveProperty('point_status');
  });
});

describe('chunkOrderWriteInputs', () => {
  it('25 件までは 1 バッチにまとめる', () => {
    const records = buildLoadTestOrders({
      count: BATCH_WRITE_MAX_ITEMS,
      loadTestId: LOAD_TEST_ID,
      dataTtlDays: 7,
    });
    const inputs = chunkOrderWriteInputs(TABLE_NAME, records);
    expect(inputs).toHaveLength(1);
    expect(countBatchWriteItems(inputs[0])).toBe(BATCH_WRITE_MAX_ITEMS);
  });

  it('26 件目からバッチを分ける（上限超過のリクエストを作らない）', () => {
    const records = buildLoadTestOrders({
      count: BATCH_WRITE_MAX_ITEMS + 1,
      loadTestId: LOAD_TEST_ID,
      dataTtlDays: 7,
    });
    const inputs = chunkOrderWriteInputs(TABLE_NAME, records);
    expect(inputs).toHaveLength(2);
    expect(countBatchWriteItems(inputs[1])).toBe(1);
  });

  it('267 件（16,000 件/分の 1 刻み）は 11 バッチになる', () => {
    const records = buildLoadTestOrders({
      count: 267,
      loadTestId: LOAD_TEST_ID,
      dataTtlDays: 7,
    });
    const inputs = chunkOrderWriteInputs(TABLE_NAME, records);
    expect(inputs).toHaveLength(11);
    for (const input of inputs) {
      expect(countBatchWriteItems(input)).toBeLessThanOrEqual(BATCH_WRITE_MAX_ITEMS);
    }
    expect(inputs.reduce((sum, input) => sum + countBatchWriteItems(input), 0)).toBe(267);
  });

  it('0 件ならバッチを作らない（空の RequestItems は DynamoDB が拒否する）', () => {
    expect(chunkOrderWriteInputs(TABLE_NAME, [])).toEqual([]);
  });

  it('全件を PutRequest として指定したテーブルに積む', () => {
    const records = buildLoadTestOrders({
      count: 3,
      loadTestId: LOAD_TEST_ID,
      dataTtlDays: 7,
    });
    const [input] = chunkOrderWriteInputs(TABLE_NAME, records);
    const requests = input.RequestItems?.[TABLE_NAME] ?? [];
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.PutRequest?.Item?.order_id)).toEqual(
      records.map((record) => record.order_id)
    );
  });
});

describe('toRetryBatch（要件 11.11。投入件数を過大に数えない）', () => {
  it('書き残しが無ければ undefined', () => {
    expect(toRetryBatch(undefined)).toBeUndefined();
    expect(toRetryBatch({})).toBeUndefined();
    expect(toRetryBatch({ [TABLE_NAME]: [] })).toBeUndefined();
  });

  it('書き残しをそのまま再送入力にする', () => {
    const unprocessed = {
      [TABLE_NAME]: [{ PutRequest: { Item: { order_id: 'ORD#1', customer_id: 'CUST#a' } } }],
    };
    const retry = toRetryBatch(unprocessed);
    expect(retry).toEqual({ RequestItems: unprocessed });
    expect(countBatchWriteItems(retry!)).toBe(1);
  });

  it('空のテーブルエントリを落とす', () => {
    const retry = toRetryBatch({
      [TABLE_NAME]: [{ PutRequest: { Item: { order_id: 'ORD#1' } } }],
      'other-table': [],
    });
    expect(Object.keys(retry?.RequestItems ?? {})).toEqual([TABLE_NAME]);
  });
});
