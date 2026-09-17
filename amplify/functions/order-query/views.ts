/**
 * `order-query` の DynamoDB コマンド組み立てと応答の整形（design §4.2 / §5.8）。
 *
 * ## 読み取りしかしない（要件 2.8）
 *
 * このモジュールが組み立てるのは `Query` の入力だけである。
 * `Put` / `Update` / `Delete` は**意図的に import していない**。
 * IAM 側も `Query` のみを許可する（design §5.9）が、
 * コード側でも書き込み経路を持たないことでレビューで確認できるようにしている。
 *
 * ## `GetItem` を使えない理由（design §4.2）
 *
 * 注文テーブルは PK `order_id` / SK `customer_id` の複合キーである。
 * 注文 ID だけでは `GetItem` に必要なキーが揃わないため、
 * **PK 条件のみの `Query`** で 1 件を取り出す。
 * 出典のデータモデル（要件のデータモデル表）を尊重してキー設計は変えず、
 * 照会側で対応する方針を design §4.2 で決めている。
 *
 * 消費 RCU は `GetItem` と同等（1 件・4 KB 未満で 0.5 RCU）であり、
 * 照会系のコストや波及の観測に影響しない。
 */

import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { buildCapacityEstimate } from '../shared/capacity.js';
import { CATALOG, POINT_RATE } from '../shared/catalog.js';
import { API_ERROR_CODES, ApiError } from '../shared/http.js';
import { buildStageProgress, resolveEndToEndMs } from '../shared/order-status.js';
import type { RuntimeVerificationParams } from '../shared/runtime-config.js';
import type {
  CatalogResponse,
  OrderListResponse,
  OrderRecord,
  OrderStatusResponse,
  VerificationConfigResponse,
} from '../shared/types.js';

/** 継続トークンの base64 エンコーディング（URL に載せるため base64url を使う） */
const NEXT_TOKEN_ENCODING = 'base64url';

/**
 * 注文 1 件を取得する `Query` の入力を組み立てる（design §4.2）。
 *
 * `Limit: 1` を付けているのは、同一 `order_id` に複数の SK が並ぶ可能性が
 * 設計上ないことを明示するため（注文 ID は ULID で一意。要件 1.4）。
 * 万一重複しても余分なアイテムを読まない。
 */
export function buildOrderDetailQueryInput(input: {
  tableName: string;
  orderId: string;
}): QueryCommandInput {
  return {
    TableName: input.tableName,
    KeyConditionExpression: 'order_id = :orderId',
    ExpressionAttributeValues: { ':orderId': input.orderId },
    Limit: 1,
  };
}

/**
 * 顧客別注文一覧の `Query` の入力を組み立てる（要件 2.3）。
 *
 * GSI `customer-orders-index`（PK `customer_id` / SK `created_at`、射影 ALL）を使い、
 * `ScanIndexForward: false` で**新しい順**に返す。射影が ALL なので
 * 基表への追加読み取りは発生しない（design §4.2）。
 *
 * @throws {ApiError} 400 `INVALID_REQUEST`（継続トークンが壊れている場合）
 */
export function buildCustomerOrdersQueryInput(input: {
  tableName: string;
  indexName: string;
  customerId: string;
  limit: number;
  nextToken?: string;
}): QueryCommandInput {
  const queryInput: QueryCommandInput = {
    TableName: input.tableName,
    IndexName: input.indexName,
    KeyConditionExpression: 'customer_id = :customerId',
    ExpressionAttributeValues: { ':customerId': input.customerId },
    // SK は created_at。降順で読むことが「新しい順」の実現手段（要件 2.3）
    ScanIndexForward: false,
    Limit: input.limit,
  };

  if (input.nextToken !== undefined) {
    queryInput.ExclusiveStartKey = decodeNextToken(input.nextToken);
  }

  return queryInput;
}

/**
 * `LastEvaluatedKey` を継続トークンに変換する。続きが無ければ `null`。
 *
 * キーの構造（`order_id` / `customer_id` / `created_at`）をそのまま
 * クエリ文字列に出すと、後からキー設計を変えたときにトークンの互換性が壊れる。
 * base64 で包んで**不透明な値**として扱う。
 */
export function encodeNextToken(
  lastEvaluatedKey: Record<string, unknown> | undefined
): string | null {
  if (lastEvaluatedKey === undefined || Object.keys(lastEvaluatedKey).length === 0) {
    return null;
  }
  return Buffer.from(JSON.stringify(lastEvaluatedKey), 'utf8').toString(NEXT_TOKEN_ENCODING);
}

/**
 * 継続トークンを `ExclusiveStartKey` に戻す。
 *
 * 壊れたトークンは 400 で返す。500 に落とすと、
 * 検証者が古いトークンを貼り直しただけの操作が
 * 「システム側の異常」に見えてしまう（`Errors` メトリクスを汚す）。
 *
 * @throws {ApiError} 400 `INVALID_REQUEST`
 */
export function decodeNextToken(token: string): QueryCommandInput['ExclusiveStartKey'] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, NEXT_TOKEN_ENCODING).toString('utf8'));
  } catch {
    throw new ApiError(API_ERROR_CODES.INVALID_REQUEST, 'nextToken が不正です');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(API_ERROR_CODES.INVALID_REQUEST, 'nextToken が不正です');
  }

  return parsed as QueryCommandInput['ExclusiveStartKey'];
}

/**
 * 注文レコードを照会レスポンスへ変換する（要件 2.1 / 2.5 / 2.6）。
 *
 * 段階ごとの進捗と経過時間の算出は `shared/order-status.ts` に委ねる
 * （`order-processor` が書いた属性の解釈を 1 箇所に集めるため）。
 *
 * `pipeline_mode` を `?? null` で受けているのは、負荷生成が
 * `BatchWriteItem` で直接書き込む経路（design 論点 2）があり、
 * 属性が欠けたレコードでも照会自体は成功させたいからである。
 */
export function toOrderStatusResponse(order: OrderRecord): OrderStatusResponse {
  return {
    orderId: order.order_id,
    customerId: order.customer_id,
    orderStatus: order.order_status,
    totalAmount: order.total_amount,
    pointEarned: order.point_earned ?? 0,
    items: order.items ?? [],
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    stagesDone: order.stages_done ?? 0,
    stages: buildStageProgress(order),
    failureReason: order.failure_reason ?? null,
    pipelineMode: order.pipeline_mode ?? null,
    endToEndMs: resolveEndToEndMs(order),
  };
}

/** 顧客別一覧のレスポンスを組み立てる（新しい順のまま並べる） */
export function toOrderListResponse(
  orders: readonly OrderRecord[],
  lastEvaluatedKey: Record<string, unknown> | undefined
): OrderListResponse {
  return {
    orders: orders.map(toOrderStatusResponse),
    nextToken: encodeNextToken(lastEvaluatedKey),
  };
}

/**
 * 有効な検証パラメータと消費能力の見積もりを返す（要件 10.6 / 14.7）。
 *
 * 出典は**デプロイ済みの Lambda 環境変数**である（`runtime-config.ts` が解決した値）。
 * 消費能力の S は実行時にしか分からないため暫定値になる。
 * 応答は `capacity.shardCountSource = 'ASSUMED'` でその事実を明示し、
 * 実測値による再計算は `load-generator` の実行レコード（要件 19.3）に委ねる。
 */
export function buildConfigResponse(
  params: RuntimeVerificationParams
): VerificationConfigResponse {
  const stageDelaysMs = {
    payment: params.paymentDelayMs,
    notification: params.notificationDelayMs,
  };

  return {
    pipelineMode: 'direct',
    stream: {
      batchSize: params.streamBatchSize,
      parallelizationFactor: params.streamParallelizationFactor,
    },
    stageDelaysMs,
    paymentFailureRate: params.paymentFailureRate,
    dataTtlDays: params.dataTtlDays,
    limits: {
      maxOrdersPerMinute: params.maxOrdersPerMinute,
      maxDurationSeconds: params.maxDurationSeconds,
      maxMeasureConcurrency: params.maxMeasureConcurrency,
    },
    capacity: buildCapacityEstimate({
      parallelizationFactor: params.streamParallelizationFactor,
      stageDelaysMs,
    }),
  };
}

/**
 * 商品マスタを返す（要件 3.5）。
 *
 * フロントエンドに商品マスタを複製すると、注文生成ロジック（`shared/catalog.ts`）と
 * 投入画面の選択肢が食い違う。`shared/catalog.ts` を唯一の出典にするための API である
 * （design §5.8）。SKU 数は 240 件で応答は約 30 KB。ページングは設けない。
 */
export function buildCatalogResponse(): CatalogResponse {
  return {
    products: CATALOG.map((product) => ({
      sku: product.sku,
      name: product.name,
      price: product.price,
      origin: product.origin,
      roast: product.roast,
      size: product.size,
    })),
    count: CATALOG.length,
    pointRate: POINT_RATE,
  };
}
