/**
 * `POST /orders` のリクエスト検証と注文レコードの組み立て（要件 1、design §E-1）。
 *
 * ハンドラ（`handler.ts`）から純粋関数として切り出しているのは、
 * 検証規則と注文レコードの形を AWS クライアント抜きで単体テストするためである
 * （design §12「最も狭い範囲の検証を最初に実行する」）。
 * この層は DynamoDB を知らず、副作用は ULID と現在時刻の生成だけに留める。
 *
 * ## 単価は商品マスタを正とする（呼び出し側の `price` は採用しない）
 *
 * `CreateOrderRequest.items` は `OrderItem`（`sku` / `qty` / `price`）の形だが、
 * `price` は**受け取っても無視し、`shared/catalog.ts` の値で置き換える**。
 * 呼び出し側の単価を信じると `total_amount` が商品マスタと無関係な値になり、
 * Property 6（`total_amount` は明細の `qty × price` の総和、
 * `point_earned` は `floor(total_amount × 0.01)`）が
 * 「どの単価に対して成り立つのか」を言えなくなる。
 * 検証用の API であり値引きも税計算もないため、単価の出典は 1 つに固定する。
 *
 * 不一致をエラーにしない理由は、フロントエンドが `GET /catalog` で取得した単価を
 * そのまま送り返す構成（design §5.8）にしており、商品マスタを更新した直後に
 * 古い単価を持った画面から投入されるだけで 400 になるのを避けたいからである。
 * 応答には採用した単価を含めるので、呼び出し側は結果から差分を確認できる。
 *
 * ## 明細の重複を弾く理由
 *
 * 引当は全明細を 1 回の `TransactWriteItems` にまとめる（design 論点 1）。
 * DynamoDB のトランザクションは同一アイテムへの複数操作を許さないため、
 * 同じ SKU が 2 行ある注文は**引当段階で必ず技術的な失敗になる**。
 * 受付時点で弾けば、再試行を繰り返して滞留の観測を汚すことがなくなる（要件 16.7 の趣旨）。
 */

import { findProduct } from '../shared/catalog.js';
import { API_ERROR_CODES, ApiError } from '../shared/http.js';
import {
  CUSTOMER_ID_PREFIX,
  MAX_ID_LENGTH,
  ORDER_ID_PREFIX,
  normalizeCustomerId,
} from '../shared/order-keys.js';
import {
  type BuildOrderRecordInput,
  buildOrderRecord,
  newOrderId,
} from '../shared/order-record.js';
import type {
  CreateOrderRequest,
  CreateOrderResponse,
  OrderItem,
  OrderRecord,
} from '../shared/types.js';

/**
 * キー形式は `shared/order-keys.ts` を出典とする（照会側と規則を共有するため）。
 * 呼び出し側の import 経路を変えないよう、ここから再エクスポートしている。
 */
export { CUSTOMER_ID_PREFIX, MAX_ID_LENGTH, ORDER_ID_PREFIX, normalizeCustomerId };

/**
 * 注文レコードの組み立ては `shared/order-record.ts` を出典とする。
 *
 * 負荷生成（`load-generator`）は `order-accept` を経由せず注文テーブルへ直接書き込む
 * （要件 11.10、design 論点 2）ため、レコードの形が 2 箇所に分かれると
 * `order-processor` が受け取る `NewImage` が経路によって変わってしまう。
 * ここでは再エクスポートだけを行い、実装は共有モジュールに 1 つだけ置く。
 */
export { type BuildOrderRecordInput, buildOrderRecord, newOrderId };

/**
 * 1 注文に含められる明細数の上限。
 *
 * 引当は全明細を 1 トランザクションにまとめる（design 論点 1）ため、
 * `TransactWriteItems` の 100 アクション制限がそのまま明細数の上限になる。
 * 上限を超える注文を受け付けると引当段階で必ず失敗するので、受付で弾く。
 */
export const MAX_ORDER_ITEMS = 100;

/**
 * 明細 1 行あたりの数量の上限。
 *
 * 業務上の意味（EC の少量多品目。`randomOrderItems` は 1〜2 個）からは過大だが、
 * 手動投入で在庫不足を試す余地は残す。桁を打ち間違えた投入が
 * 初期在庫（既定 10,000,000 個。design 論点 6）を一撃で削り、
 * 以降の実行が全て `ALLOCATION_FAILED` になるのを防ぐための上限である。
 */
export const MAX_ITEM_QTY = 100;

/**
 * リクエスト本文を検証済みの `CreateOrderRequest` に変換する。
 *
 * 返す `items` は**商品マスタの単価で置き換え済み**であり、未指定なら `undefined`
 * （ランダム生成は `buildOrderRecord` が行う。要件 1.5）。
 *
 * @param body `parseJsonBody` が返した JSON オブジェクト
 * @throws {ApiError} 400 `INVALID_REQUEST`（形が不正）/ 400 `UNKNOWN_SKU`（要件 1.8）
 */
export function parseCreateOrderRequest(body: Record<string, unknown>): CreateOrderRequest {
  const request: CreateOrderRequest = {};

  const customerId = readOptionalId(body.customerId, 'customerId');
  if (customerId !== undefined) {
    request.customerId = customerId;
  }

  const loadTestId = readOptionalId(body.loadTestId, 'loadTestId');
  if (loadTestId !== undefined) {
    request.loadTestId = loadTestId;
  }

  const items = parseItems(body.items);
  if (items !== undefined) {
    request.items = items;
  }

  return request;
}

/**
 * 注文レコードを受付レスポンスへ変換する。
 *
 * `acceptLatencyMs` は受付 API 自身の処理時間（要件 1.10）。
 * 後続処理の負荷が同期パスへ波及していないかの判断材料であり、
 * 呼び出し側の往復時間（API Gateway とネットワークを含む）とは別物である。
 */
export function toCreateOrderResponse(
  record: OrderRecord,
  acceptLatencyMs: number
): CreateOrderResponse {
  return {
    orderId: record.order_id,
    customerId: record.customer_id,
    orderStatus: record.order_status,
    totalAmount: record.total_amount,
    items: record.items,
    createdAt: record.created_at,
    acceptLatencyMs,
  };
}

/**
 * 省略可能な ID 文字列を読む。空文字・空白のみは「未指定」ではなく誤りとして扱う。
 *
 * `customerId: ""` を未指定と解釈してランダム顧客を割り当てると、
 * 呼び出し側は指定したつもりの顧客 ID で照会できず原因が分かりにくい。
 */
function readOptionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      `${field} は文字列で指定してください`
    );
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      `${field} が空です（省略するとシステムが割り当てます）`
    );
  }
  if (trimmed.length > MAX_ID_LENGTH) {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      `${field} が長すぎます（上限 ${MAX_ID_LENGTH} 文字）`
    );
  }
  return field === 'customerId' ? normalizeCustomerId(trimmed) : trimmed;
}

/**
 * 明細を検証し、商品マスタの単価で組み直す。
 *
 * 検査の順序は「形 → 未知の SKU → 重複」。未知の SKU は 1 件目で打ち切らず
 * **全件を集めて返す**（`details.unknownSkus`）。フロントエンドの投入画面が
 * 複数行を直すのに何往復も必要にならないようにするためである。
 */
function parseItems(value: unknown): OrderItem[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ApiError(API_ERROR_CODES.INVALID_REQUEST, 'items は配列で指定してください');
  }
  if (value.length === 0) {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      'items が空です（省略すると商品マスタからランダムに生成します）'
    );
  }
  if (value.length > MAX_ORDER_ITEMS) {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      `items の明細数が上限を超えています（上限 ${MAX_ORDER_ITEMS} 件）`,
      { itemCount: value.length, maxItems: MAX_ORDER_ITEMS }
    );
  }

  const items: OrderItem[] = [];
  const unknownSkus: string[] = [];

  value.forEach((entry, index) => {
    const { sku, qty } = parseItemEntry(entry, index);
    const product = findProduct(sku);
    if (product === undefined) {
      unknownSkus.push(sku);
      return;
    }
    // 単価は商品マスタを正とする（冒頭の注記）
    items.push({ sku, qty, price: product.price });
  });

  // 要件 1.8: 商品マスタに無い SKU が 1 つでもあれば注文を作らない
  if (unknownSkus.length > 0) {
    throw new ApiError(
      API_ERROR_CODES.UNKNOWN_SKU,
      '商品マスタに存在しない SKU が含まれています',
      { unknownSkus }
    );
  }

  const duplicated = findDuplicatedSkus(items);
  if (duplicated.length > 0) {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      '同一 SKU の明細が重複しています（1 SKU につき 1 行にまとめてください）',
      { duplicatedSkus: duplicated }
    );
  }

  return items;
}

/** 明細 1 行を検証する。`price` は受け取っても採用しない（冒頭の注記） */
function parseItemEntry(entry: unknown, index: number): { sku: string; qty: number } {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      `items[${index}] はオブジェクトで指定してください`
    );
  }

  const { sku, qty } = entry as { sku?: unknown; qty?: unknown };

  if (typeof sku !== 'string' || sku.trim() === '') {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      `items[${index}].sku は空でない文字列で指定してください`
    );
  }

  if (typeof qty !== 'number' || !Number.isInteger(qty)) {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      `items[${index}].qty は整数で指定してください`
    );
  }
  if (qty < 1 || qty > MAX_ITEM_QTY) {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      `items[${index}].qty が範囲外です（範囲: 1〜${MAX_ITEM_QTY}）`,
      { qty, maxQty: MAX_ITEM_QTY }
    );
  }

  return { sku: sku.trim(), qty };
}

/** 重複している SKU を列挙する（出現順、重複は 1 度だけ） */
function findDuplicatedSkus(items: readonly OrderItem[]): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const item of items) {
    if (seen.has(item.sku)) {
      duplicated.add(item.sku);
    }
    seen.add(item.sku);
  }
  return [...duplicated];
}
