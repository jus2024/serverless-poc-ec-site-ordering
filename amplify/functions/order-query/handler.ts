/**
 * 注文照会 Lambda（要件 2 / 3.5 / 10.6、design §5.2 / §5.8）。
 *
 * 4 つの GET ルートを 1 関数で処理する。
 *
 * | ルート | 返すもの | 対応要件 |
 * |-------|---------|---------|
 * | `GET /orders/{orderId}` | 注文 1 件のステータスと段階ごとの進捗・経過時間 | 2.1 / 2.4 / 2.5 / 2.6 |
 * | `GET /orders?customerId=` | 顧客別の注文一覧（新しい順） | 2.3 |
 * | `GET /config` | デプロイ済みの検証パラメータと消費能力の見積もり | 10.6 / 14.7 |
 * | `GET /catalog` | 商品マスタ | 3.5 |
 *
 * ## この関数が観測対象である（要件 2.7）
 *
 * 本 PoC の問いの 1 つは「後続処理の高負荷が同期パスに波及するか」である。
 * `order-query` は**波及を受ける側**として `order-processor` と別関数に分けており
 * （要件 2.7）、この関数の `Throttles` と `ConcurrentExecutions` が
 * 波及の判定そのものになる（design §6.1 でウィジェットを分けている理由）。
 *
 * したがってこの関数は「速いこと」より「余計な仕事をしないこと」を優先する。
 * 1 リクエストにつき `Query` は 1 回だけで、テーブルを二度読みしない。
 * 予約枠も設定しない（枠の奪い合いを観測するため。design §5.2）。
 *
 * ## 読み取り専用（要件 2.8）
 *
 * 書き込み系のコマンドを import していない。IAM も `Query` のみ（design §5.9）。
 * 照会が注文レコードを書き換えると、Streams に `MODIFY` が流れて
 * ESM のイベントフィルタ（要件 9.7 / Property 8）の前提を崩す。
 * 「照会は読むだけ」は最小権限であると同時に、無限ループを避ける構造でもある。
 *
 * ## X-Ray アノテーション（design §6.3）
 *
 * `GET /orders/{orderId}` では `order_id` をアノテーションに付ける。
 * `order-accept` / `order-processor` と同じキーを使うことで、
 * 「受付 → 後続処理 → 照会」を注文 ID で突き合わせられる
 * （Streams はトレースコンテキストを伝播しないため、連結は ID 突き合わせに頼る）。
 *
 * 注釈は `shared/tracing.ts` の `withOrderSubsegment` で付ける。Lambda 実行環境の
 * 主セグメント（ファサードセグメント）に直接付けても Powertools が黙って捨てるため、
 * 自分でサブセグメントを開く必要がある（理由は同モジュールの注記）。
 *
 * **注釈するのは注文 1 件を引くルートだけである。** 残る 3 ルート
 * （一覧・`GET /config`・`GET /catalog`）には注釈すべき注文 ID が存在しない。
 * 一覧は複数注文にまたがるため、どれか 1 件を代表として注釈すると
 * フィルタ式で引いたときに誤解を招く。これらのルートではサブセグメントを開かない。
 *
 * 囲む範囲は `Query` だけにする。存在しない注文（404、要件 2.4）は照会としては
 * 正常な結果であり、サブセグメントにエラーとして残すと X-Ray 上で
 * 本当の障害と区別できなくなる。
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDocumentClient } from '../shared/ddb.js';
import { API_ERROR_CODES, ApiError, ok, toErrorResponse } from '../shared/http.js';
import { getVerificationParams, requireTableName } from '../shared/runtime-config.js';
import { withOrderSubsegment } from '../shared/tracing.js';
import type {
  CatalogResponse,
  OrderListResponse,
  OrderRecord,
  OrderStatusResponse,
  VerificationConfigResponse,
} from '../shared/types.js';
import {
  UnroutableRequestError,
  resolveRoute,
  type OrderListRoute,
  type OrderQueryRoute,
} from './routes.js';
import {
  buildCatalogResponse,
  buildConfigResponse,
  buildCustomerOrdersQueryInput,
  buildOrderDetailQueryInput,
  toOrderListResponse,
  toOrderStatusResponse,
} from './views.js';

const SERVICE_NAME = 'order-query';

const logger = new Logger({ serviceName: SERVICE_NAME });
const tracer = new Tracer({ serviceName: SERVICE_NAME });

/** 注文 1 件の照会を表すサブセグメントの名前（design §6.3） */
export const ORDER_SUBSEGMENT_NAME = '## getOrder';

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    return ok(await dispatch(resolveRoute(event)));
  } catch (error) {
    if (error instanceof ApiError) {
      // 呼び出し側の入力ミス（400 / 404）は warn に留める。負荷生成中の
      // ERROR ログ件数を「システム側の異常」の指標として使えるようにするため
      // （order-accept と同じ方針）
      logger.warn('注文の照会を拒否しました', {
        errorCode: error.code,
        message: error.message,
        details: error.details,
      });
    } else if (error instanceof UnroutableRequestError) {
      // 配線の誤り。呼び出し側では直せないので 500 に落として気づけるようにする
      logger.error('未定義のルートが order-query に届きました', {
        httpMethod: error.httpMethod,
        resourcePath: error.resourcePath,
      });
    } else {
      logger.error('注文の照会に失敗しました', { error });
    }
    return toErrorResponse(error);
  }
};

/** ルートごとの処理。網羅性は型（`OrderQueryRoute`）で保証する */
async function dispatch(
  route: OrderQueryRoute
): Promise<
  OrderStatusResponse | OrderListResponse | VerificationConfigResponse | CatalogResponse
> {
  switch (route.kind) {
    case 'ORDER_DETAIL':
      return getOrder(route.orderId);
    case 'ORDER_LIST':
      return listCustomerOrders(route);
    case 'CONFIG':
      // デプロイ済みの環境変数が出典。DynamoDB は読まない（要件 10.6）
      return buildConfigResponse(getVerificationParams());
    case 'CATALOG':
      return buildCatalogResponse();
  }
}

/**
 * 注文 1 件を返す（要件 2.1）。存在しなければ 404（要件 2.4）。
 *
 * PK 条件のみの `Query` を使う。SK が `customer_id` のため
 * 注文 ID だけでは `GetItem` できない（design §4.2）。
 */
async function getOrder(orderId: string): Promise<OrderStatusResponse> {
  // 囲むのは Query だけにする。存在しない注文（404）は照会としては正常な結果であり、
  // サブセグメントにエラーとして記録すると X-Ray 上で障害と区別できなくなる
  const output = await withOrderSubsegment(
    { tracer, name: ORDER_SUBSEGMENT_NAME, orderId },
    () =>
      getDocumentClient().send(
        new QueryCommand(
          buildOrderDetailQueryInput({
            tableName: requireTableName('ordersTableName'),
            orderId,
          })
        )
      )
  );

  const order = output.Items?.[0] as OrderRecord | undefined;
  if (order === undefined) {
    throw new ApiError(API_ERROR_CODES.ORDER_NOT_FOUND, '指定された注文は存在しません', {
      orderId,
    });
  }

  return toOrderStatusResponse(order);
}

/** 顧客別の注文一覧を新しい順に返す（要件 2.3） */
async function listCustomerOrders(route: OrderListRoute): Promise<OrderListResponse> {
  const output = await getDocumentClient().send(
    new QueryCommand(
      buildCustomerOrdersQueryInput({
        tableName: requireTableName('ordersTableName'),
        indexName: requireTableName('ordersCustomerIndexName'),
        customerId: route.customerId,
        limit: route.limit,
        nextToken: route.nextToken,
      })
    )
  );

  return toOrderListResponse(
    (output.Items ?? []) as OrderRecord[],
    output.LastEvaluatedKey
  );
}
