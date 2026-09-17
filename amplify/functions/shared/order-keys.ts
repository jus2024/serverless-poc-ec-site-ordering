/**
 * 注文テーブルのキー形式（design §4.2）。
 *
 * 元は `order-accept/order-request.ts` に閉じていたが、照会側（`order-query`）が
 * **同じ正規化規則**を必要とするため共有モジュールへ移した。
 * `GET /orders?customerId=test-0001` と `POST /orders {"customerId":"CUST#test-0001"}` で
 * 接頭辞の扱いが食い違うと、投入した注文が顧客別一覧（要件 2.3）に現れない。
 * 規則が 2 箇所にあると、片方だけ直したときにこの不整合が静かに再発する。
 *
 * `order-accept` 側は後方互換のためここで定義した値を再エクスポートしている。
 */

/** 注文 ID の接頭辞（PK。`ORD#{ULID}`。要件 1.4） */
export const ORDER_ID_PREFIX = 'ORD#';

/** 顧客 ID の接頭辞（SK。`CUST#{customer-id}`。design §4.2） */
export const CUSTOMER_ID_PREFIX = 'CUST#';

/**
 * 顧客 ID・注文 ID・負荷テスト実行 ID の長さ上限。
 *
 * キー属性の暴走を防ぐための上限であり、業務上の意味はない。
 * DynamoDB のキー長上限（PK 2,048 バイト / SK 1,024 バイト）よりはるかに小さく取る。
 */
export const MAX_ID_LENGTH = 128;

/**
 * 顧客 ID に `CUST#` を補う。
 *
 * SK の形を `CUST#{customer-id}`（design §4.2）に揃えるための正規化。
 * 接頭辞の有無で別の顧客として扱われると、GSI での顧客別一覧（要件 2.3）が
 * 同じ顧客の注文を取りこぼす。
 */
export function normalizeCustomerId(customerId: string): string {
  return customerId.startsWith(CUSTOMER_ID_PREFIX)
    ? customerId
    : `${CUSTOMER_ID_PREFIX}${customerId}`;
}
