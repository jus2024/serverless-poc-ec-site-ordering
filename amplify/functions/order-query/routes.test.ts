import type { APIGatewayProxyEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../shared/http.js';
import { MAX_ID_LENGTH } from '../shared/order-keys.js';
import {
  DEFAULT_ORDER_LIST_LIMIT,
  MAX_NEXT_TOKEN_LENGTH,
  MAX_ORDER_LIST_LIMIT,
  ORDER_QUERY_RESOURCES,
  UnroutableRequestError,
  resolveRoute,
} from './routes.js';

/**
 * ルート判定とクエリパラメータ検証の単体テスト（要件 2.1 / 2.3 / 2.4、design §5.8）。
 *
 * 1 つの Lambda が 4 ルートを持つ構成なので、**取り違えが起きないこと**が最優先の検査対象。
 * DynamoDB へのアクセスは含めない（`views.test.ts` / ハンドラ側の責務）。
 */

/** テスト用のイベント。必要なフィールドだけを渡す */
function buildEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    resource: ORDER_QUERY_RESOURCES.config,
    path: '/config',
    pathParameters: null,
    queryStringParameters: null,
    ...overrides,
  } as APIGatewayProxyEvent;
}

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

describe('resolveRoute: resource テンプレートからの判定（design §5.8）', () => {
  it('GET /config', () => {
    const route = resolveRoute(
      buildEvent({ resource: ORDER_QUERY_RESOURCES.config, path: '/config' })
    );
    expect(route).toEqual({ kind: 'CONFIG' });
  });

  it('GET /catalog', () => {
    const route = resolveRoute(
      buildEvent({ resource: ORDER_QUERY_RESOURCES.catalog, path: '/catalog' })
    );
    expect(route).toEqual({ kind: 'CATALOG' });
  });

  it('GET /orders/{orderId} はパスパラメータから注文 ID を取る', () => {
    const route = resolveRoute(
      buildEvent({
        resource: ORDER_QUERY_RESOURCES.orderDetail,
        path: '/orders/ORD%2301J000000000000000000000',
        pathParameters: { orderId: 'ORD#01J000000000000000000000' },
      })
    );

    expect(route).toEqual({
      kind: 'ORDER_DETAIL',
      orderId: 'ORD#01J000000000000000000000',
    });
  });

  /**
   * タスク 13 で実測した API Gateway の実挙動。
   * REST API は `pathParameters` を**デコードせずに**渡すため、
   * ここをデコードしないと正常な注文が常に 404 になる。
   */
  it('pathParameters が percent-encode されたまま届いてもデコードする', () => {
    const route = resolveRoute(
      buildEvent({
        resource: ORDER_QUERY_RESOURCES.orderDetail,
        path: '/orders/ORD%2301J000000000000000000000',
        pathParameters: { orderId: 'ORD%2301J000000000000000000000' },
      })
    );

    expect(route).toEqual({
      kind: 'ORDER_DETAIL',
      orderId: 'ORD#01J000000000000000000000',
    });
  });

  it('GET /orders?customerId= は一覧として扱う（同じ /orders で分岐しない）', () => {
    const route = resolveRoute(
      buildEvent({
        resource: ORDER_QUERY_RESOURCES.orderList,
        path: '/orders',
        queryStringParameters: { customerId: 'CUST#test-0001' },
      })
    );

    expect(route).toEqual({
      kind: 'ORDER_LIST',
      customerId: 'CUST#test-0001',
      limit: DEFAULT_ORDER_LIST_LIMIT,
    });
  });
});

describe('resolveRoute: 具体パスからの判定（resource が無い経路）', () => {
  it('/config', () => {
    expect(resolveRoute(buildEvent({ resource: undefined, path: '/config' }))).toEqual({
      kind: 'CONFIG',
    });
  });

  it('末尾スラッシュとステージ風の前後スラッシュを無視する', () => {
    expect(resolveRoute(buildEvent({ resource: undefined, path: '/catalog/' }))).toEqual({
      kind: 'CATALOG',
    });
  });

  it('percent-encode された注文 ID をデコードする', () => {
    const route = resolveRoute(
      buildEvent({
        resource: undefined,
        path: '/orders/ORD%2301J000000000000000000000',
      })
    );

    expect(route).toEqual({
      kind: 'ORDER_DETAIL',
      orderId: 'ORD#01J000000000000000000000',
    });
  });

  it('デコードできないパスはそのまま扱う（照会が 404 で返る）', () => {
    const route = resolveRoute(
      buildEvent({ resource: undefined, path: '/orders/ORD%ZZ' })
    );

    expect(route).toEqual({ kind: 'ORDER_DETAIL', orderId: 'ORD%ZZ' });
  });
});

describe('resolveRoute: 配線の誤り（500 に落とす。design §E-1）', () => {
  it('GET 以外は受け付けない（読み取り専用の関数。要件 2.8）', () => {
    expect(() =>
      resolveRoute(buildEvent({ httpMethod: 'POST', resource: '/orders', path: '/orders' }))
    ).toThrow(UnroutableRequestError);
  });

  it('定義外のパスは UnroutableRequestError', () => {
    expect(() =>
      resolveRoute(
        buildEvent({ resource: '/load-test/start', path: '/load-test/start' })
      )
    ).toThrow(UnroutableRequestError);
  });

  it('/orders 配下でも階層が深ければ受け付けない', () => {
    expect(() =>
      resolveRoute(buildEvent({ resource: undefined, path: '/orders/ORD%23001/stages' }))
    ).toThrow(UnroutableRequestError);
  });

  it('ルートパスは受け付けない', () => {
    expect(() => resolveRoute(buildEvent({ resource: undefined, path: '/' }))).toThrow(
      UnroutableRequestError
    );
  });
});

describe('resolveRoute: 注文 ID の検証', () => {
  it('パスパラメータが空なら 400 INVALID_REQUEST', () => {
    expectApiError(
      () =>
        resolveRoute(
          buildEvent({
            resource: ORDER_QUERY_RESOURCES.orderDetail,
            path: '/orders/ ',
            pathParameters: { orderId: '  ' },
          })
        ),
      'INVALID_REQUEST'
    );
  });

  it('テンプレートが素通りしてきたら 400 INVALID_REQUEST（マッピング漏れ）', () => {
    expectApiError(
      () =>
        resolveRoute(
          buildEvent({
            resource: ORDER_QUERY_RESOURCES.orderDetail,
            path: '/orders/{orderId}',
            pathParameters: { orderId: '{orderId}' },
          })
        ),
      'INVALID_REQUEST'
    );
  });

  it('長すぎる注文 ID は 400 INVALID_REQUEST', () => {
    expectApiError(
      () =>
        resolveRoute(
          buildEvent({
            resource: ORDER_QUERY_RESOURCES.orderDetail,
            path: '/orders/x',
            pathParameters: { orderId: 'O'.repeat(MAX_ID_LENGTH + 1) },
          })
        ),
      'INVALID_REQUEST'
    );
  });
});

describe('resolveRoute: 顧客別一覧のパラメータ（要件 2.3）', () => {
  /** 一覧ルートのイベントを作る */
  function listEvent(query: Record<string, string>): APIGatewayProxyEvent {
    return buildEvent({
      resource: ORDER_QUERY_RESOURCES.orderList,
      path: '/orders',
      queryStringParameters: query,
    });
  }

  it('customerId は必須（省略すると 400。Scan に落とさない）', () => {
    expectApiError(() => resolveRoute(listEvent({})), 'INVALID_REQUEST');
  });

  it('空文字の customerId も 400', () => {
    expectApiError(() => resolveRoute(listEvent({ customerId: '  ' })), 'INVALID_REQUEST');
  });

  it('CUST# が無ければ補う（order-accept の正規化と同じ規則）', () => {
    const route = resolveRoute(listEvent({ customerId: 'test-0001' }));
    expect(route).toMatchObject({ kind: 'ORDER_LIST', customerId: 'CUST#test-0001' });
  });

  it('長すぎる customerId は 400', () => {
    expectApiError(
      () => resolveRoute(listEvent({ customerId: 'c'.repeat(MAX_ID_LENGTH + 1) })),
      'INVALID_REQUEST'
    );
  });

  it('limit を指定できる', () => {
    expect(resolveRoute(listEvent({ customerId: 'test-0001', limit: '50' }))).toMatchObject({
      limit: 50,
    });
  });

  it('limit が空文字なら既定値', () => {
    expect(resolveRoute(listEvent({ customerId: 'test-0001', limit: '' }))).toMatchObject({
      limit: DEFAULT_ORDER_LIST_LIMIT,
    });
  });

  it.each(['0', '-1', '1.5', 'abc', String(MAX_ORDER_LIST_LIMIT + 1)])(
    'limit が %s なら 400',
    (limit) => {
      expectApiError(
        () => resolveRoute(listEvent({ customerId: 'test-0001', limit })),
        'INVALID_REQUEST'
      );
    }
  );

  it('nextToken はそのまま渡す（デコードは views 側の責務）', () => {
    expect(
      resolveRoute(listEvent({ customerId: 'test-0001', nextToken: 'abc123' }))
    ).toMatchObject({ nextToken: 'abc123' });
  });

  it('nextToken が空文字ならキー自体を持たない', () => {
    const route = resolveRoute(listEvent({ customerId: 'test-0001', nextToken: '' }));
    expect(route).not.toHaveProperty('nextToken');
  });

  it('長すぎる nextToken は 400（base64 デコードの前に弾く）', () => {
    expectApiError(
      () =>
        resolveRoute(
          listEvent({
            customerId: 'test-0001',
            nextToken: 'a'.repeat(MAX_NEXT_TOKEN_LENGTH + 1),
          })
        ),
      'INVALID_REQUEST'
    );
  });
});
