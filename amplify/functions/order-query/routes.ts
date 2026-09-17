/**
 * `order-query` のルート判定とクエリパラメータの検証（design §5.8）。
 *
 * ## 1 つの Lambda が 4 ルートを持つ理由
 *
 * `GET /orders/{orderId}` / `GET /orders` / `GET /config` / `GET /catalog` を
 * 1 関数に相乗りさせている（design §5.8）。関数を増やすと
 * 「照会系の同時実行とスロットル」（要件 2.7 / 13.5）を見るときに
 * ウィジェットを分けて足し合わせる必要が生じ、波及の判定が読みにくくなる。
 * `GET /config` を同居させるのは、`.env.local` ではなく
 * **実際にデプロイされている環境変数**を出典にできるからでもある。
 *
 * ## 判定は `resource` を優先し、`path` で代替する
 *
 * API Gateway の REST API はルートごとに統合を張るため、
 * `event.resource` にはテンプレート（`/orders/{orderId}`）が入る。
 * ただしローカルでの手動実行やプロキシ統合では `resource` が無いこともあるため、
 * 具体パス（`/orders/ORD%23...`）からも同じ判定ができるようにしている。
 * どちらもパスセグメントに分解して同一の規則で判定する。
 *
 * ## ここに置かないもの
 *
 * DynamoDB のコマンド組み立てと応答の整形は `views.ts` にある。
 * この層は AWS SDK を知らず、`APIGatewayProxyEvent` から
 * 「何を返すべきか」を決めるところまでで終わる（単体テストのため。design §12）。
 */

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { API_ERROR_CODES, ApiError } from '../shared/http.js';
import { MAX_ID_LENGTH, normalizeCustomerId } from '../shared/order-keys.js';

/** design §5.8 の表のうち `order-query` が担うルート（API Gateway 側の定義と対応させる） */
export const ORDER_QUERY_RESOURCES = {
  orderDetail: '/orders/{orderId}',
  orderList: '/orders',
  config: '/config',
  catalog: '/catalog',
} as const;

/** 顧客別一覧の既定件数 */
export const DEFAULT_ORDER_LIST_LIMIT = 20;

/**
 * 顧客別一覧の最大件数。
 *
 * DynamoDB の `Query` は 1 回で最大 1 MB を返す。射影 ALL の GSI（design §4.2）から
 * 注文レコードを 100 件返すと応答が数十 KB になる。それ以上は
 * API Gateway の応答上限（10 MB）より先に画面の可読性が破綻するため、上限を切る。
 */
export const MAX_ORDER_LIST_LIMIT = 100;

/**
 * 継続トークンの長さ上限。
 *
 * トークンは `LastEvaluatedKey`（`order_id` + `customer_id` + GSI キー）を
 * base64 化したものなので数百バイトに収まる。桁違いの入力を
 * base64 デコードにかける前に弾くためだけの上限である。
 */
export const MAX_NEXT_TOKEN_LENGTH = 2_048;

/** 注文 ID 照会（要件 2.1 / 2.4） */
export interface OrderDetailRoute {
  kind: 'ORDER_DETAIL';
  orderId: string;
}

/** 顧客別一覧（要件 2.3） */
export interface OrderListRoute {
  kind: 'ORDER_LIST';
  /** `CUST#` を補った顧客 ID */
  customerId: string;
  limit: number;
  /** 継続トークン。デコードは `views.ts` が行う */
  nextToken?: string;
}

/** 検証パラメータ照会（要件 10.6 / 14.7） */
export interface ConfigRoute {
  kind: 'CONFIG';
}

/** 商品マスタ照会（要件 3.5） */
export interface CatalogRoute {
  kind: 'CATALOG';
}

export type OrderQueryRoute = OrderDetailRoute | OrderListRoute | ConfigRoute | CatalogRoute;

/**
 * どのルートにも当てはまらないリクエスト。
 *
 * `ApiError` にしていないのは、**呼び出し側の誤りではなく配線の誤り**だからである。
 * API Gateway は定義されていないパスやメソッドを Lambda に渡す前に自分で弾く
 * （403 / 404 を返す）。それでもここに到達したなら、
 * `order-api.ts`（タスク 10）が意図しないルートをこの関数に向けている。
 * 400 を返して呼び出し側にリクエストを直させるのは誤った案内なので、
 * 500 `INTERNAL_ERROR` に落として ERROR ログで気づけるようにする（design §E-1）。
 */
export class UnroutableRequestError extends Error {
  readonly httpMethod: string;
  readonly resourcePath: string;

  constructor(httpMethod: string, resourcePath: string) {
    super(
      `order-query が扱えないルートです（配線の誤り。design §5.8 を確認してください）: ${httpMethod} ${resourcePath}`
    );
    this.name = 'UnroutableRequestError';
    this.httpMethod = httpMethod;
    this.resourcePath = resourcePath;
  }
}

/**
 * イベントからルートを決める。
 *
 * @throws {UnroutableRequestError} 定義外のパス・メソッド（配線の誤り）
 * @throws {ApiError} 400 `INVALID_REQUEST`（クエリパラメータの誤り）
 */
export function resolveRoute(event: APIGatewayProxyEvent): OrderQueryRoute {
  const httpMethod = (event.httpMethod ?? '').toUpperCase();
  const resourcePath = event.resource ?? event.path ?? '';
  const segments = splitPath(resourcePath);

  // 読み取り専用の関数なので GET 以外は受け付けない（要件 2.8）
  if (httpMethod !== 'GET') {
    throw new UnroutableRequestError(httpMethod, resourcePath);
  }

  if (segments.length === 1 && segments[0] === 'config') {
    return { kind: 'CONFIG' };
  }
  if (segments.length === 1 && segments[0] === 'catalog') {
    return { kind: 'CATALOG' };
  }
  if (segments.length === 1 && segments[0] === 'orders') {
    return resolveOrderListRoute(event);
  }
  if (segments.length === 2 && segments[0] === 'orders') {
    return { kind: 'ORDER_DETAIL', orderId: resolveOrderId(event, segments[1]) };
  }

  throw new UnroutableRequestError(httpMethod, resourcePath);
}

/**
 * 注文 ID を取り出す。
 *
 * 注文 ID は `ORD#{ULID}`（要件 1.4）で `#` を含むため、URL では
 * `/orders/ORD%2301J...` と percent-encode されて届く。
 *
 * ## API Gateway はパスパラメータをデコードしない（タスク 13 の実測で判明）
 *
 * 当初は「API Gateway がデコード済みの値を渡す」前提で
 * `pathParameters` をそのまま使い、`resource` が無い経路のみ
 * 自前でデコードしていた。しかし REST API の `pathParameters.orderId` には
 * **percent-encode されたまま**の `ORD%2301J...` が入る。
 * その結果 `order_id = "ORD%2301J..."` で Query して 0 件になり、
 * **正常に処理された注文が常に 404 になった**
 * （`GET /orders?customerId=` は同じ注文を返せるため、
 * 「一覧には出るのに個別照会だけ 404」という分かりにくい壊れ方になる）。
 *
 * よって出典に関係なく必ず 1 回デコードする。二重デコードの心配は無い:
 * 注文 ID は `ORD#` + ULID（Crockford Base32）であり `%` を含まないため、
 * デコード後の文字列に解ける encode は残らない。
 */
function resolveOrderId(event: APIGatewayProxyEvent, pathSegment: string): string {
  const raw = decodePathSegment(event.pathParameters?.orderId ?? pathSegment);
  const orderId = raw.trim();

  if (orderId === '' || orderId === '{orderId}') {
    // `{orderId}` が素通りしてくるのは API Gateway 側のマッピング漏れ
    throw new ApiError(API_ERROR_CODES.INVALID_REQUEST, '注文 ID が指定されていません');
  }
  if (orderId.length > MAX_ID_LENGTH) {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      `注文 ID が長すぎます（上限 ${MAX_ID_LENGTH} 文字）`
    );
  }
  return orderId;
}

/**
 * 顧客別一覧のクエリパラメータを検証する。
 *
 * `customerId` は必須にする（要件 2.3）。省略時に全件走査へ落とすと
 * `Scan` が必要になり、照会系が注文テーブルの読み取り容量を大量に消費して
 * 「後続処理の負荷が照会系に波及するか」という観測を自ら汚す。
 */
function resolveOrderListRoute(event: APIGatewayProxyEvent): OrderListRoute {
  const query = event.queryStringParameters ?? {};

  const rawCustomerId = (query.customerId ?? '').trim();
  if (rawCustomerId === '') {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      'customerId を指定してください（例: ?customerId=test-0001）'
    );
  }
  if (rawCustomerId.length > MAX_ID_LENGTH) {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      `customerId が長すぎます（上限 ${MAX_ID_LENGTH} 文字）`
    );
  }

  const route: OrderListRoute = {
    kind: 'ORDER_LIST',
    customerId: normalizeCustomerId(rawCustomerId),
    limit: parseLimit(query.limit),
  };

  const nextToken = (query.nextToken ?? '').trim();
  if (nextToken !== '') {
    if (nextToken.length > MAX_NEXT_TOKEN_LENGTH) {
      throw new ApiError(API_ERROR_CODES.INVALID_REQUEST, 'nextToken が不正です');
    }
    route.nextToken = nextToken;
  }

  return route;
}

/** `limit` を検証する。未指定・空文字は既定値 */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_ORDER_LIST_LIMIT;
  }

  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1 || value > MAX_ORDER_LIST_LIMIT) {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      `limit は 1〜${MAX_ORDER_LIST_LIMIT} の整数で指定してください`,
      { limit: raw, maxLimit: MAX_ORDER_LIST_LIMIT }
    );
  }
  return value;
}

/** パスをセグメントに分解する（空要素は落とすので前後のスラッシュを気にしなくてよい） */
function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/** percent-encode を解く。不正なエンコードは元の文字列のまま扱う（404 で返る） */
function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
