import { describe, expect, it } from 'vitest';
import {
  ORDER_API_BASE_URL_ENV,
  OrderApiBaseUrlError,
  buildQueryTargetUrl,
  describeQueryTarget,
  normalizeApiBaseUrl,
  requireOrderApiBaseUrl,
} from './query-target.js';

/**
 * 計測対象 URL の組み立ての単体テスト（design 論点 3、要件 12.1 / 12.4）。
 *
 * とくに確かめたいのは注文 ID の `#` のエンコードである。
 * エンコードを落とすと `#` 以降がフラグメント扱いになり、
 * `GET /orders/ORD#01J...` が `GET /orders` に化けて計測が全件エラーになる。
 */

const BASE = 'https://abc123.execute-api.ap-northeast-1.amazonaws.com/prod';

describe('normalizeApiBaseUrl', () => {
  it('末尾のスラッシュを落とす（RestApi.url は / で終わる）', () => {
    expect(normalizeApiBaseUrl(`${BASE}/`)).toBe(BASE);
    expect(normalizeApiBaseUrl(`${BASE}///`)).toBe(BASE);
  });

  it('前後の空白を落とす', () => {
    expect(normalizeApiBaseUrl(`  ${BASE}  `)).toBe(BASE);
  });

  it('http も許可する（ローカルの代替エンドポイント）', () => {
    expect(normalizeApiBaseUrl('http://localhost:3000/api')).toBe(
      'http://localhost:3000/api'
    );
  });

  it.each([
    ['空文字', ''],
    ['空白のみ', '   '],
    ['スキームなし', 'abc123.execute-api.ap-northeast-1.amazonaws.com/prod'],
    ['相対パス', '/prod'],
    ['別スキーム', 'ftp://example.com/prod'],
  ])('%s は OrderApiBaseUrlError', (_label, value) => {
    expect(() => normalizeApiBaseUrl(value)).toThrow(OrderApiBaseUrlError);
  });
});

describe('requireOrderApiBaseUrl', () => {
  it('環境変数から読む', () => {
    expect(requireOrderApiBaseUrl({ [ORDER_API_BASE_URL_ENV]: `${BASE}/` })).toBe(BASE);
  });

  it('未設定なら OrderApiBaseUrlError（配線漏れを名前で分かるようにする）', () => {
    expect(() => requireOrderApiBaseUrl({})).toThrow(OrderApiBaseUrlError);
  });
});

describe('buildQueryTargetUrl', () => {
  it('注文 1 件照会は注文 ID をエンコードする（# をフラグメントにしない）', () => {
    const url = buildQueryTargetUrl(BASE, {
      kind: 'ORDER_DETAIL',
      orderId: 'ORD#01JABCDEFGHJKMNPQRSTVWXYZ',
    });
    expect(url).toBe(`${BASE}/orders/ORD%2301JABCDEFGHJKMNPQRSTVWXYZ`);
    expect(url).not.toContain('#');
    // URL として解釈してもフラグメントが生まれないこと
    expect(new URL(url).hash).toBe('');
    expect(new URL(url).pathname.endsWith('/orders/ORD%2301JABCDEFGHJKMNPQRSTVWXYZ')).toBe(
      true
    );
  });

  it('顧客別一覧は customerId をクエリに載せる', () => {
    expect(buildQueryTargetUrl(BASE, { kind: 'ORDER_LIST', customerId: 'test-0001' })).toBe(
      `${BASE}/orders?customerId=test-0001`
    );
  });

  it('CUST# 付きの顧客 ID もエンコードする', () => {
    const url = buildQueryTargetUrl(BASE, {
      kind: 'ORDER_LIST',
      customerId: 'CUST#test-0001',
    });
    expect(url).toBe(`${BASE}/orders?customerId=CUST%23test-0001`);
    expect(new URL(url).searchParams.get('customerId')).toBe('CUST#test-0001');
  });

  it('末尾スラッシュ付きのベース URL でもパスが二重にならない', () => {
    expect(
      buildQueryTargetUrl(`${BASE}/`, { kind: 'ORDER_LIST', customerId: 'test-0001' })
    ).toBe(`${BASE}/orders?customerId=test-0001`);
  });

  it('不正なベース URL は OrderApiBaseUrlError', () => {
    expect(() =>
      buildQueryTargetUrl('not-a-url', { kind: 'ORDER_LIST', customerId: 'test-0001' })
    ).toThrow(OrderApiBaseUrlError);
  });
});

describe('describeQueryTarget', () => {
  it('ログ用にベース URL を含めない 1 行を返す', () => {
    expect(describeQueryTarget({ kind: 'ORDER_DETAIL', orderId: 'ORD#01J' })).toBe(
      'GET /orders/ORD#01J'
    );
    expect(describeQueryTarget({ kind: 'ORDER_LIST', customerId: 'test-0001' })).toBe(
      'GET /orders?customerId=test-0001'
    );
  });
});
