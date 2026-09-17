import { describe, expect, it } from 'vitest';
import { ASSUMED_OPEN_SHARD_COUNT } from '../shared/capacity.js';
import { CATALOG, POINT_RATE } from '../shared/catalog.js';
import { ApiError } from '../shared/http.js';
import type { RuntimeVerificationParams } from '../shared/runtime-config.js';
import type { OrderRecord } from '../shared/types.js';
import {
  buildCatalogResponse,
  buildConfigResponse,
  buildCustomerOrdersQueryInput,
  buildOrderDetailQueryInput,
  decodeNextToken,
  encodeNextToken,
  toOrderListResponse,
  toOrderStatusResponse,
} from './views.js';

/**
 * 照会 API の応答整形とクエリ組み立ての単体テスト
 * （要件 2.1 / 2.3 / 2.5 / 2.6 / 2.8 / 3.5 / 10.6、design §4.2）。
 *
 * AWS への接続は行わない。`Query` の入力が design §4.2 のキー設計どおりか、
 * 応答が段階ごとの経過時間を含むか（要件 2.5 / 2.6）を確かめる。
 */

const CREATED_AT = '2025-01-01T00:00:00.000Z';

/** 未処理（PENDING）の注文レコード */
function pendingOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    order_id: 'ORD#01J000000000000000000000',
    customer_id: 'CUST#test-0001',
    order_status: 'PENDING',
    items: [{ sku: CATALOG[0].sku, qty: 2, price: CATALOG[0].price }],
    total_amount: CATALOG[0].price * 2,
    point_earned: 0,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    stages_done: 0,
    pipeline_mode: 'direct',
    expires_at: 1_800_000_000,
    ...overrides,
  };
}

/** 全 4 段階が完了した注文レコード */
function completedOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return pendingOrder({
    order_status: 'COMPLETED',
    stages_done: 4,
    point_earned: 36,
    updated_at: '2025-01-01T00:00:04.000Z',
    payment_status: 'DONE',
    payment_at: '2025-01-01T00:00:03.000Z',
    allocation_status: 'DONE',
    allocation_at: '2025-01-01T00:00:03.200Z',
    notification_status: 'DONE',
    notification_at: '2025-01-01T00:00:03.800Z',
    point_status: 'DONE',
    point_at: '2025-01-01T00:00:04.000Z',
    ...overrides,
  });
}

describe('buildOrderDetailQueryInput（design §4.2: PK 条件のみの Query）', () => {
  const input = buildOrderDetailQueryInput({
    tableName: 'orders',
    orderId: 'ORD#01J000000000000000000000',
  });

  it('PK のみを条件にする（SK が customer_id なので GetItem できない）', () => {
    expect(input.KeyConditionExpression).toBe('order_id = :orderId');
    expect(input.ExpressionAttributeValues).toEqual({
      ':orderId': 'ORD#01J000000000000000000000',
    });
  });

  it('基表を読む（GSI は使わない）', () => {
    expect(input.TableName).toBe('orders');
    expect(input.IndexName).toBeUndefined();
  });

  it('1 件で打ち切る（注文 ID は一意）', () => {
    expect(input.Limit).toBe(1);
  });

  it('フィルタを使わない（読み捨てる RCU を作らない）', () => {
    expect(input.FilterExpression).toBeUndefined();
  });
});

describe('buildCustomerOrdersQueryInput（要件 2.3）', () => {
  const input = buildCustomerOrdersQueryInput({
    tableName: 'orders',
    indexName: 'customer-orders-index',
    customerId: 'CUST#test-0001',
    limit: 20,
  });

  it('GSI を customer_id で引く', () => {
    expect(input.IndexName).toBe('customer-orders-index');
    expect(input.KeyConditionExpression).toBe('customer_id = :customerId');
    expect(input.ExpressionAttributeValues).toEqual({ ':customerId': 'CUST#test-0001' });
  });

  it('新しい順に返す（SK = created_at の降順）', () => {
    expect(input.ScanIndexForward).toBe(false);
  });

  it('limit をそのまま渡す', () => {
    expect(input.Limit).toBe(20);
  });

  it('継続トークンが無ければ ExclusiveStartKey を付けない', () => {
    expect(input.ExclusiveStartKey).toBeUndefined();
  });

  it('継続トークンを ExclusiveStartKey に戻す', () => {
    const key = { customer_id: 'CUST#test-0001', created_at: CREATED_AT, order_id: 'ORD#1' };
    const withToken = buildCustomerOrdersQueryInput({
      tableName: 'orders',
      indexName: 'customer-orders-index',
      customerId: 'CUST#test-0001',
      limit: 20,
      nextToken: encodeNextToken(key) ?? '',
    });

    expect(withToken.ExclusiveStartKey).toEqual(key);
  });

  it('壊れた継続トークンは 400 INVALID_REQUEST（500 に落とさない）', () => {
    let caught: unknown;
    try {
      buildCustomerOrdersQueryInput({
        tableName: 'orders',
        indexName: 'customer-orders-index',
        customerId: 'CUST#test-0001',
        limit: 20,
        nextToken: 'not-a-token',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('INVALID_REQUEST');
  });
});

describe('継続トークン', () => {
  it('往復して同じキーに戻る', () => {
    const key = { customer_id: 'CUST#test-0001', created_at: CREATED_AT, order_id: 'ORD#1' };
    const token = encodeNextToken(key);

    expect(token).not.toBeNull();
    expect(decodeNextToken(token as string)).toEqual(key);
  });

  it('URL に載せられる文字だけを含む（base64url）', () => {
    const token = encodeNextToken({ order_id: 'ORD#01J+/=' });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('LastEvaluatedKey が無ければ null（続きが無い）', () => {
    expect(encodeNextToken(undefined)).toBeNull();
    expect(encodeNextToken({})).toBeNull();
  });

  it('JSON オブジェクトでないトークンは 400', () => {
    const notObject = Buffer.from('[1,2,3]', 'utf8').toString('base64url');
    expect(() => decodeNextToken(notObject)).toThrow(ApiError);
  });
});

describe('toOrderStatusResponse（要件 2.1 / 2.5 / 2.6）', () => {
  it('未処理の注文は全段階が WAITING で経過時間を持たない', () => {
    const response = toOrderStatusResponse(pendingOrder());

    expect(response.orderStatus).toBe('PENDING');
    expect(response.stagesDone).toBe(0);
    expect(response.stages.map((stage) => stage.status)).toEqual([
      'WAITING',
      'WAITING',
      'WAITING',
      'WAITING',
    ]);
    expect(response.stages.every((stage) => stage.elapsedMs === null)).toBe(true);
    expect(response.endToEndMs).toBeNull();
    expect(response.failureReason).toBeNull();
  });

  it('段階ごとの完了時刻から経過時間を返す（要件 2.5）', () => {
    const response = toOrderStatusResponse(completedOrder());

    expect(response.stages).toEqual([
      {
        stage: 'payment',
        status: 'DONE',
        completedAt: '2025-01-01T00:00:03.000Z',
        elapsedMs: 3_000,
      },
      {
        stage: 'allocation',
        status: 'DONE',
        completedAt: '2025-01-01T00:00:03.200Z',
        elapsedMs: 3_200,
      },
      {
        stage: 'notification',
        status: 'DONE',
        completedAt: '2025-01-01T00:00:03.800Z',
        elapsedMs: 3_800,
      },
      {
        stage: 'point',
        status: 'DONE',
        completedAt: '2025-01-01T00:00:04.000Z',
        elapsedMs: 4_000,
      },
    ]);
  });

  it('全段階完了なら end-to-end の経過時間を返す（要件 2.6）', () => {
    expect(toOrderStatusResponse(completedOrder()).endToEndMs).toBe(4_000);
  });

  it('途中まで完了した注文は end-to-end を null にする（要件 2.6）', () => {
    const order = pendingOrder({
      order_status: 'PAID',
      stages_done: 1,
      payment_status: 'DONE',
      payment_at: '2025-01-01T00:00:03.000Z',
    });

    const response = toOrderStatusResponse(order);
    expect(response.endToEndMs).toBeNull();
    expect(response.stages[0]).toMatchObject({ status: 'DONE', elapsedMs: 3_000 });
    expect(response.stages[1]).toMatchObject({ status: 'WAITING', elapsedMs: null });
  });

  it('失敗した注文は失敗理由と失敗した段階を返す（design §E-2）', () => {
    const order = pendingOrder({
      order_status: 'ALLOCATION_FAILED',
      stages_done: 2,
      payment_status: 'DONE',
      payment_at: '2025-01-01T00:00:03.000Z',
      allocation_status: 'FAILED',
      allocation_at: '2025-01-01T00:00:03.100Z',
      failure_reason: '在庫不足: ITEM#ETH-YIRG-G1-LIGHT-100G',
    });

    const response = toOrderStatusResponse(order);
    expect(response.orderStatus).toBe('ALLOCATION_FAILED');
    expect(response.failureReason).toBe('在庫不足: ITEM#ETH-YIRG-G1-LIGHT-100G');
    expect(response.stages[1]).toMatchObject({ stage: 'allocation', status: 'FAILED' });
    expect(response.endToEndMs).toBeNull();
  });

  it('属性が欠けたレコードでも照会は成功させる（負荷生成の直接書き込み経路）', () => {
    const order = {
      ...pendingOrder(),
      point_earned: undefined,
      stages_done: undefined,
      pipeline_mode: undefined,
    } as unknown as OrderRecord;

    const response = toOrderStatusResponse(order);
    expect(response.pointEarned).toBe(0);
    expect(response.stagesDone).toBe(0);
    expect(response.pipelineMode).toBeNull();
  });
});

describe('toOrderListResponse（要件 2.3）', () => {
  it('取得順（新しい順）を保ち、続きがあればトークンを返す', () => {
    const newer = completedOrder({ order_id: 'ORD#2' });
    const older = pendingOrder({ order_id: 'ORD#1' });
    const lastKey = { customer_id: 'CUST#test-0001', created_at: CREATED_AT };

    const response = toOrderListResponse([newer, older], lastKey);

    expect(response.orders.map((order) => order.orderId)).toEqual(['ORD#2', 'ORD#1']);
    expect(response.nextToken).not.toBeNull();
    expect(decodeNextToken(response.nextToken as string)).toEqual(lastKey);
  });

  it('0 件でも空配列と null を返す（404 にしない）', () => {
    expect(toOrderListResponse([], undefined)).toEqual({ orders: [], nextToken: null });
  });
});

describe('buildConfigResponse（要件 10.6 / 14.7）', () => {
  const params: RuntimeVerificationParams = {
    paymentDelayMs: 3_000,
    notificationDelayMs: 500,
    paymentFailureRate: 0,
    dataTtlDays: 7,
    maxOrdersPerMinute: 20_000,
    maxDurationSeconds: 3_600,
    maxMeasureConcurrency: 200,
    streamBatchSize: 1,
    streamParallelizationFactor: 10,
  };

  it('デプロイ済みの検証パラメータをそのまま返す', () => {
    const response = buildConfigResponse(params);

    expect(response.pipelineMode).toBe('direct');
    expect(response.stream).toEqual({ batchSize: 1, parallelizationFactor: 10 });
    expect(response.stageDelaysMs).toEqual({ payment: 3_000, notification: 500 });
    expect(response.paymentFailureRate).toBe(0);
    expect(response.dataTtlDays).toBe(7);
    expect(response.limits).toEqual({
      maxOrdersPerMinute: 20_000,
      maxDurationSeconds: 3_600,
      maxMeasureConcurrency: 200,
    });
  });

  it('消費能力の見積もりを含める（S は暫定値であることを明示する）', () => {
    const { capacity } = buildConfigResponse(params);

    expect(capacity.shardCountSource).toBe('ASSUMED');
    expect(capacity.openShardCount).toBe(ASSUMED_OPEN_SHARD_COUNT);
    expect(capacity.parallelizationFactor).toBe(10);
    expect(capacity.recordProcessingMs).toBe(3_600);
    // 想定 D（S=4, P=10, D=3.6 秒）→ 約 667/分。
    // design §2.2 の実測 D = 3,652.57ms では 657/分 だが、ここは
    // `ASSUMED_STAGE_OVERHEAD_MS` = 100ms を使う `GET /config` の見積もりを見ている
    expect(Math.round(capacity.estimatedCapacityPerMinute)).toBe(667);
  });

  it('PF を変えると見積もりが追従する（計測条件の取り違えを防ぐ）', () => {
    const { capacity } = buildConfigResponse({ ...params, streamParallelizationFactor: 1 });

    expect(capacity.maxConcurrency).toBe(ASSUMED_OPEN_SHARD_COUNT);
    expect(Math.round(capacity.estimatedCapacityPerMinute)).toBe(67);
  });
});

describe('buildCatalogResponse（要件 3.5）', () => {
  it('商品マスタ全件を件数付きで返す', () => {
    const response = buildCatalogResponse();

    expect(response.count).toBe(CATALOG.length);
    expect(response.products).toHaveLength(CATALOG.length);
    expect(response.pointRate).toBe(POINT_RATE);
  });

  it('SKU・商品名・単価と表示用属性だけを返す（Lambda 内部の構造を漏らさない）', () => {
    const [product] = buildCatalogResponse().products;

    expect(Object.keys(product).sort()).toEqual([
      'name',
      'origin',
      'price',
      'roast',
      'size',
      'sku',
    ]);
    expect(product.sku).toBe(CATALOG[0].sku);
    expect(product.price).toBe(CATALOG[0].price);
  });

  it('表示用属性を商品マスタの値そのままで返す（要件 1.1）', () => {
    const { products } = buildCatalogResponse();

    // 全件を見る。1 件だけの照合では map の取り違え（全商品に同じ値を入れる等）を見逃す
    expect(
      products.map((product) => ({
        origin: product.origin,
        roast: product.roast,
        size: product.size,
      }))
    ).toEqual(
      CATALOG.map((product) => ({
        origin: product.origin,
        roast: product.roast,
        size: product.size,
      }))
    );
  });
});
