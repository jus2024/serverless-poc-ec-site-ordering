/**
 * 計測対象の照会 API と、その URL の組み立て（design 論点 3、要件 12.1 / 12.4）。
 *
 * ## API Gateway を経由する（直接 invoke しない）
 *
 * `order-query` を `lambda:InvokeFunction` で直接呼ぶ方が実装は簡単だが、
 * それでは**API Gateway 層のスロットル（429）を見逃す**（design 論点 3）。
 * 本 Spec が測りたいのは「後続処理の高負荷が同期パスに波及するか」であり、
 * 波及は経路のどこに現れるか分からない。したがって検証者のブラウザが辿るのと
 * 同じ経路（API Gateway → Lambda → DynamoDB）を HTTPS で叩く。
 *
 * その代償として、この関数は**自分が属する API のベース URL を知る必要がある**。
 * IAM 権限は要らない（API に認証を掛けていない。design §5.9 / §8）。
 *
 * ## CDK 側の配線（`ORDER_API_BASE_URL`）は循環参照を避けてある
 *
 * `ORDER_API_BASE_URL` に `RestApi.url` をそのまま渡すと**循環参照になり、
 * デプロイできないテンプレートになる**（`api.url` は
 * `AWS::ApiGateway::Stage` の `Ref` を含み、Stage → Deployment → Method →
 * この Lambda → environment → Stage の輪ができる）。
 *
 * そのため IaC 側は `url` を使わず、`restApiId` とステージ名から
 * URL を組み立てている（`amplify/custom/order-api.ts` の
 * `OrderApi.urlForLambdaEnvironment`）。値の形は変わらないので、
 * この実行時モジュールから見た扱いは同じである。
 */

/**
 * 計測対象 API のベース URL を渡す環境変数。
 *
 * `shared/runtime-config.ts` のテーブル名（`RUNTIME_TABLE_ENV_KEYS`）に含めないのは、
 * `load-generator` のストリーム ARN（`ORDERS_STREAM_ARN`）と同じ理由である。
 * これを必要とするのは `query-impact-measure` だけなので、全 Lambda へ配る
 * 環境変数へ混ぜると配線の意図が読み取りにくくなる。
 *
 * 値の形は末尾のステージ名まで含んだ絶対 URL
 * （例: `https://abc123.execute-api.ap-northeast-1.amazonaws.com/prod`）。
 * `environment` への設定は `OrderFunctions.wireApiBaseUrl` が行う（冒頭の注記を参照）。
 */
export const ORDER_API_BASE_URL_ENV = 'ORDER_API_BASE_URL';

/** `GET /orders/{orderId}`（design §4.2 の PK 条件のみの `Query`。要件 2.1） */
export interface OrderDetailTarget {
  kind: 'ORDER_DETAIL';
  /** 照会する注文 ID（`ORD#{ULID}`） */
  orderId: string;
}

/** `GET /orders?customerId=`（GSI での顧客別一覧。要件 2.3） */
export interface OrderListTarget {
  kind: 'ORDER_LIST';
  /** 照会する顧客 ID。`CUST#` の有無は `order-query` 側が正規化する */
  customerId: string;
}

/**
 * 計測対象。
 *
 * `GET /config` と `GET /catalog` は対象にしない。どちらも DynamoDB を触らず
 * （前者は環境変数、後者は商品マスタの定数）、注文テーブルの読み取りが
 * 後続処理の負荷に引きずられるかという観測にならない。
 */
export type QueryTarget = OrderDetailTarget | OrderListTarget;

/** ベース URL が環境変数から解決できない、または URL として解釈できないときの例外 */
export class OrderApiBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderApiBaseUrlError';
  }
}

/**
 * ベース URL を正規化する（末尾のスラッシュを落とす）。
 *
 * `https` または `http` の絶対 URL でなければ例外にする。
 * 空文字やホスト名だけの値を通すと、`http.request` が
 * 「相対 URL を解決できない」という無関係な例外を出し、
 * **配線漏れが実行レコードの `error_message` から読み取れなくなる**。
 *
 * @throws {OrderApiBaseUrlError} URL として解釈できない場合
 */
export function normalizeApiBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new OrderApiBaseUrlError(
      `${ORDER_API_BASE_URL_ENV} が空です（例: https://abc123.execute-api.ap-northeast-1.amazonaws.com/prod）`
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new OrderApiBaseUrlError(
      `${ORDER_API_BASE_URL_ENV} が URL として解釈できません（受け取った値: "${raw}"）`
    );
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new OrderApiBaseUrlError(
      `${ORDER_API_BASE_URL_ENV} は http(s) の絶対 URL で指定してください（受け取った値: "${raw}"）`
    );
  }

  return trimmed.replace(/\/+$/, '');
}

/**
 * 環境変数からベース URL を読む。
 *
 * @throws {OrderApiBaseUrlError} 未設定・空文字・URL として不正な場合
 */
export function requireOrderApiBaseUrl(
  env: Record<string, string | undefined> = process.env
): string {
  const raw = env[ORDER_API_BASE_URL_ENV];
  if (raw === undefined) {
    throw new OrderApiBaseUrlError(
      `${ORDER_API_BASE_URL_ENV} が未設定です（OrderFunctions.wireApiBaseUrl が呼ばれていない可能性があります）`
    );
  }
  return normalizeApiBaseUrl(raw);
}

/**
 * 計測対象の URL を組み立てる。
 *
 * 注文 ID は `ORD#{ULID}` で `#` を含む。**エンコードを省略すると
 * `#` 以降がフラグメントとして扱われ、`GET /orders` （顧客別一覧）に化ける。**
 * 化けた先は `customerId` 必須なので 400 が返り、計測は
 * 「全リクエストがエラー」という結果になる（`order-query/routes.ts` の注記も同旨）。
 */
export function buildQueryTargetUrl(baseUrl: string, target: QueryTarget): string {
  const base = normalizeApiBaseUrl(baseUrl);

  switch (target.kind) {
    case 'ORDER_DETAIL':
      return `${base}/orders/${encodeURIComponent(target.orderId)}`;
    case 'ORDER_LIST':
      return `${base}/orders?customerId=${encodeURIComponent(target.customerId)}`;
  }
}

/** 計測対象を 1 行で表す（ログ用。ベース URL を含めない） */
export function describeQueryTarget(target: QueryTarget): string {
  switch (target.kind) {
    case 'ORDER_DETAIL':
      return `GET /orders/${target.orderId}`;
    case 'ORDER_LIST':
      return `GET /orders?customerId=${target.customerId}`;
  }
}
