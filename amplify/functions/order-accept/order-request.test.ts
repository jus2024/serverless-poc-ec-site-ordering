import { describe, expect, it } from 'vitest';
import { CATALOG, calculatePoints } from '../shared/catalog.js';
import { ApiError } from '../shared/http.js';
import {
  buildOrderRecord,
  CUSTOMER_ID_PREFIX,
  MAX_ITEM_QTY,
  MAX_ORDER_ITEMS,
  newOrderId,
  normalizeCustomerId,
  ORDER_ID_PREFIX,
  parseCreateOrderRequest,
  toCreateOrderResponse,
} from './order-request.js';

/**
 * 注文受付の検証規則とレコード組み立ての単体テスト（要件 1、design §12 の段階 2）。
 *
 * DynamoDB への書き込みは対象にしない（ハンドラ側の責務）。
 * ここで確かめるのは「不正な入力で注文を作らないこと」と
 * 「作った注文レコードが design §4.2 の形を満たすこと」に絞る。
 */

const SAMPLE_SKUS = [CATALOG[0].sku, CATALOG[1].sku, CATALOG[2].sku];

/** 例外が期待したエラーコードの ApiError であることを確かめる */
function expectApiError(execute: () => unknown, code: string): ApiError {
  let caught: unknown;
  try {
    execute();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApiError);
  const apiError = caught as ApiError;
  expect(apiError.code).toBe(code);
  return apiError;
}

describe('newOrderId（要件 1.4）', () => {
  it('ORD#{ULID} 形式である', () => {
    expect(newOrderId()).toMatch(/^ORD#[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('生成順に辞書順でソートできる（同一ミリ秒に連続生成しても崩れない）', () => {
    // 素の ulid() は乱数部を引き直すためこの検査に落ちる。単調増加版を使う根拠
    const ids = Array.from({ length: 500 }, () => newOrderId());
    expect([...ids].sort()).toEqual(ids);
  });

  it('重複しない', () => {
    const ids = Array.from({ length: 500 }, () => newOrderId());
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('parseCreateOrderRequest: 省略時の扱い（要件 1.5 / 1.6）', () => {
  it('本文が空オブジェクトなら何も指定されていないものとして返す', () => {
    expect(parseCreateOrderRequest({})).toEqual({});
  });

  it('null は未指定として扱う（JSON で明示的に null を送られても落ちない）', () => {
    expect(parseCreateOrderRequest({ customerId: null, items: null })).toEqual({});
  });
});

describe('parseCreateOrderRequest: 顧客 ID', () => {
  it('CUST# が無ければ補う（GSI の顧客別一覧が取りこぼさないようにする）', () => {
    expect(parseCreateOrderRequest({ customerId: 'test-0001' }).customerId).toBe(
      'CUST#test-0001'
    );
  });

  it('CUST# 付きはそのまま使う', () => {
    expect(parseCreateOrderRequest({ customerId: 'CUST#test-0001' }).customerId).toBe(
      'CUST#test-0001'
    );
  });

  it('空文字は未指定に読み替えず 400 INVALID_REQUEST にする', () => {
    expectApiError(() => parseCreateOrderRequest({ customerId: '   ' }), 'INVALID_REQUEST');
  });

  it('文字列以外は 400 INVALID_REQUEST', () => {
    expectApiError(() => parseCreateOrderRequest({ customerId: 42 }), 'INVALID_REQUEST');
  });

  it('長すぎる ID は 400 INVALID_REQUEST', () => {
    expectApiError(
      () => parseCreateOrderRequest({ customerId: 'x'.repeat(200) }),
      'INVALID_REQUEST'
    );
  });
});

describe('parseCreateOrderRequest: 明細の単価は商品マスタを正とする', () => {
  it('呼び出し側の price は採用せず商品マスタの単価に置き換える', () => {
    const product = CATALOG[0];
    const request = parseCreateOrderRequest({
      items: [{ sku: product.sku, qty: 2, price: 1 }],
    });
    expect(request.items).toEqual([{ sku: product.sku, qty: 2, price: product.price }]);
  });

  it('price を省略しても受け付ける', () => {
    const product = CATALOG[5];
    const request = parseCreateOrderRequest({ items: [{ sku: product.sku, qty: 1 }] });
    expect(request.items).toEqual([{ sku: product.sku, qty: 1, price: product.price }]);
  });
});

describe('parseCreateOrderRequest: 未知の SKU（要件 1.8）', () => {
  it('商品マスタに無い SKU は 400 UNKNOWN_SKU', () => {
    const error = expectApiError(
      () => parseCreateOrderRequest({ items: [{ sku: 'ITEM#UNKNOWN', qty: 1 }] }),
      'UNKNOWN_SKU'
    );
    expect(error.statusCode).toBe(400);
  });

  it('未知の SKU を全件まとめて details に返す（何往復も直させない）', () => {
    const error = expectApiError(
      () =>
        parseCreateOrderRequest({
          items: [
            { sku: 'ITEM#UNKNOWN-1', qty: 1 },
            { sku: SAMPLE_SKUS[0], qty: 1 },
            { sku: 'ITEM#UNKNOWN-2', qty: 1 },
          ],
        }),
      'UNKNOWN_SKU'
    );
    expect(error.details).toEqual({ unknownSkus: ['ITEM#UNKNOWN-1', 'ITEM#UNKNOWN-2'] });
  });
});

describe('parseCreateOrderRequest: 明細の形', () => {
  it('配列でなければ 400 INVALID_REQUEST', () => {
    expectApiError(() => parseCreateOrderRequest({ items: 'x' }), 'INVALID_REQUEST');
  });

  it('空配列は 400 INVALID_REQUEST（省略とは区別する）', () => {
    expectApiError(() => parseCreateOrderRequest({ items: [] }), 'INVALID_REQUEST');
  });

  it('明細数の上限を超えたら 400 INVALID_REQUEST（引当のトランザクション制限）', () => {
    const items = CATALOG.slice(0, MAX_ORDER_ITEMS + 1).map((product) => ({
      sku: product.sku,
      qty: 1,
    }));
    expectApiError(() => parseCreateOrderRequest({ items }), 'INVALID_REQUEST');
  });

  it('上限ちょうどは受け付ける', () => {
    const items = CATALOG.slice(0, MAX_ORDER_ITEMS).map((product) => ({
      sku: product.sku,
      qty: 1,
    }));
    expect(parseCreateOrderRequest({ items }).items).toHaveLength(MAX_ORDER_ITEMS);
  });

  it('同一 SKU の重複は 400 INVALID_REQUEST（引当が必ず失敗するため）', () => {
    const error = expectApiError(
      () =>
        parseCreateOrderRequest({
          items: [
            { sku: SAMPLE_SKUS[0], qty: 1 },
            { sku: SAMPLE_SKUS[0], qty: 2 },
          ],
        }),
      'INVALID_REQUEST'
    );
    expect(error.details).toEqual({ duplicatedSkus: [SAMPLE_SKUS[0]] });
  });

  it.each([
    { label: '小数', qty: 1.5 },
    { label: '0 個', qty: 0 },
    { label: '負数', qty: -1 },
    { label: '上限超過', qty: MAX_ITEM_QTY + 1 },
    { label: '文字列', qty: '1' },
  ])('qty が $label なら 400 INVALID_REQUEST', ({ qty }) => {
    expectApiError(
      () => parseCreateOrderRequest({ items: [{ sku: SAMPLE_SKUS[0], qty }] }),
      'INVALID_REQUEST'
    );
  });

  it('sku が空文字なら 400 INVALID_REQUEST', () => {
    expectApiError(
      () => parseCreateOrderRequest({ items: [{ sku: '  ', qty: 1 }] }),
      'INVALID_REQUEST'
    );
  });

  it('明細がオブジェクトでなければ 400 INVALID_REQUEST', () => {
    expectApiError(() => parseCreateOrderRequest({ items: ['x'] }), 'INVALID_REQUEST');
  });
});

describe('buildOrderRecord（要件 1.2 / 1.3 / 1.9、design §4.2）', () => {
  const nowMs = Date.parse('2025-01-01T00:00:00.000Z');
  /** ULID は 26 文字。値そのものに意味はなく、レコードの形を固定するために使う */
  const orderId = `${ORDER_ID_PREFIX}${'01JH'.padEnd(26, '0')}`;

  it('初期状態は PENDING / stages_done = 0 / pipeline_mode = direct', () => {
    const record = buildOrderRecord({
      request: { customerId: 'CUST#test-0001', items: [{ sku: SAMPLE_SKUS[0], qty: 1, price: 100 }] },
      dataTtlDays: 7,
      nowMs,
      orderId,
    });

    expect(record.order_status).toBe('PENDING');
    expect(record.stages_done).toBe(0);
    expect(record.pipeline_mode).toBe('direct');
    expect(record.point_earned).toBe(0);
    expect(record.created_at).toBe('2025-01-01T00:00:00.000Z');
    expect(record.updated_at).toBe(record.created_at);
  });

  it('expires_at を TTL 日数から設定する（design 論点 5）', () => {
    const record = buildOrderRecord({ request: {}, dataTtlDays: 7, nowMs, orderId });
    expect(record.expires_at).toBe(Math.floor(nowMs / 1000) + 7 * 24 * 60 * 60);
  });

  it('段階属性を一切設定しない（存在しないことが二重実行の検知条件。design §5.4）', () => {
    const record = buildOrderRecord({ request: {}, dataTtlDays: 7, nowMs, orderId });
    const stageAttributes = [
      'payment_status',
      'payment_at',
      'allocation_status',
      'allocation_at',
      'notification_status',
      'notification_at',
      'point_status',
      'point_at',
      'failure_reason',
    ];
    expect(stageAttributes.filter((key) => key in record)).toEqual([]);
  });

  it('total_amount は明細の qty × price の総和（Property 6 / 要件 1.9）', () => {
    const items = [
      { sku: SAMPLE_SKUS[0], qty: 2, price: 1800 },
      { sku: SAMPLE_SKUS[1], qty: 3, price: 1200 },
    ];
    const record = buildOrderRecord({ request: { items }, dataTtlDays: 7, nowMs, orderId });
    expect(record.total_amount).toBe(2 * 1800 + 3 * 1200);
    // ポイントは付与段階で入るが、金額から一意に決まることを確認しておく
    expect(calculatePoints(record.total_amount)).toBe(Math.floor(record.total_amount * 0.01));
  });

  it('明細が未指定なら商品マスタから生成する（要件 1.5）', () => {
    const record = buildOrderRecord({ request: {}, dataTtlDays: 7, nowMs, orderId });
    expect(record.items.length).toBeGreaterThan(0);
    for (const item of record.items) {
      expect(CATALOG.some((product) => product.sku === item.sku)).toBe(true);
    }
    expect(record.total_amount).toBeGreaterThan(0);
  });

  it('顧客 ID が未指定ならテスト顧客を割り当てる（要件 1.6）', () => {
    const record = buildOrderRecord({ request: {}, dataTtlDays: 7, nowMs, orderId });
    expect(record.customer_id.startsWith(CUSTOMER_ID_PREFIX)).toBe(true);
  });

  it('注文 ID を省略すると ORD# 形式で生成する', () => {
    const record = buildOrderRecord({ request: {}, dataTtlDays: 7, nowMs });
    expect(record.order_id.startsWith(ORDER_ID_PREFIX)).toBe(true);
  });

  it('load_test_id は指定時のみ含める（手動投入の注文には付けない）', () => {
    const withId = buildOrderRecord({
      request: { loadTestId: 'LOAD#001' },
      dataTtlDays: 7,
      nowMs,
      orderId,
    });
    expect(withId.load_test_id).toBe('LOAD#001');

    const withoutId = buildOrderRecord({ request: {}, dataTtlDays: 7, nowMs, orderId });
    expect('load_test_id' in withoutId).toBe(false);
  });
});

describe('toCreateOrderResponse（要件 1.10）', () => {
  it('自身の処理時間を含める', () => {
    const record = buildOrderRecord({
      request: { customerId: 'CUST#test-0001' },
      dataTtlDays: 7,
      nowMs: Date.parse('2025-01-01T00:00:00.000Z'),
      orderId: 'ORD#01JH00000000000000000000',
    });
    const response = toCreateOrderResponse(record, 12);

    expect(response).toEqual({
      orderId: record.order_id,
      customerId: record.customer_id,
      orderStatus: 'PENDING',
      totalAmount: record.total_amount,
      items: record.items,
      createdAt: record.created_at,
      acceptLatencyMs: 12,
    });
  });
});

describe('normalizeCustomerId', () => {
  it('接頭辞の有無で同じ顧客が別扱いにならない', () => {
    expect(normalizeCustomerId('test-0001')).toBe(normalizeCustomerId('CUST#test-0001'));
  });
});
