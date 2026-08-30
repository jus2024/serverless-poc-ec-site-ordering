import { Stack } from 'aws-cdk-lib';
import {
  AuthorizationType,
  Cors,
  EndpointType,
  LambdaIntegration,
  RestApi,
  type IResource,
} from 'aws-cdk-lib/aws-apigateway';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/**
 * API Gateway REST API とルート定義（design §5.8）。
 *
 * ## 認証を掛けていない（design §8）
 *
 * **この API には認証がない。** 要件のスコープ外定義に従った結果であり、
 * 設計上の割り切りとして design §8 に明記されている。次のリスクを伴う。
 *
 * - URL を知る第三者が注文を投入でき、初期在庫投入も叩ける
 * - 負荷生成 API（`POST /load-test/start`）を第三者が叩けるため、Lambda の
 *   同時実行枠と DynamoDB の書き込み（= 課金）を消費させられる
 *
 * 緩和策は「負荷生成のパラメータに上限を設ける」（`verification-config.ts`）と
 * 「検証していない期間はスタックを削除しておく運用」だけである。
 * **この構成を公開環境に常設してはならない。**
 * 認証を足す場合は `defaultMethodOptions` に `authorizationType` を設定する
 * （API キー / IAM 認証 / WAF はいずれも本 Spec のスコープ外）。
 *
 * ## design §5.8 の 9 ルートすべてを定義する
 *
 * 同期パスの 6 ルートに加えて、計測系の 3 ルート
 * （`POST /load-test/start`、`POST /measure/start`、`GET /executions/{executionId}`）を含む。
 * ルートは `ORDER_API_ROUTES` の表から機械的に生成しており、
 * `order-api.test.ts` が表と design §5.8 の対応を検査する。
 */

/** ルートの割り当て先。`OrderFunctions` がそのまま構造的に適合する */
export interface OrderApiHandlers {
  /** `POST /orders` */
  readonly orderAccept: IFunction;
  /** `GET /orders`、`GET /orders/{orderId}`、`GET /config`、`GET /catalog` */
  readonly orderQuery: IFunction;
  /** `POST /inventory/seed` */
  readonly inventorySeed: IFunction;
  /** `POST /load-test/start`（要件 11.1） */
  readonly loadGenerator: IFunction;
  /** `POST /measure/start`（要件 12.1） */
  readonly queryImpactMeasure: IFunction;
  /** `GET /executions/{executionId}`（要件 11.6 / 12.5） */
  readonly executionStatus: IFunction;
}

export interface OrderApiRoute {
  readonly method: 'GET' | 'POST';
  /** 先頭スラッシュ付きのパス。`{orderId}` などのテンプレートを含む */
  readonly path: string;
  readonly handler: keyof OrderApiHandlers;
}

/**
 * design §5.8 の表そのもの（全 9 ルート）。
 *
 * `GET /catalog` を含めるのは、フロントエンドの手動投入 UI が
 * SKU の選択肢を商品マスタ（`shared/catalog.ts`）と同じ出典から取るためである
 * （要件 3.5。フロントエンド側に商品マスタを複製すると選択肢が食い違う）。
 *
 * 計測系の 2 つの開始ルート（`/load-test/start`、`/measure/start`）は
 * **202 を即座に返して非同期に継続する**（要件 11.9 / 12.1）。
 * API Gateway の統合タイムアウトは上限 29 秒であり、
 * 数分〜1 時間の継続時間を同期で待つ経路は存在し得ない。
 * 進捗の照会先が `GET /executions/{executionId}` である。
 */
export const ORDER_API_ROUTES: readonly OrderApiRoute[] = [
  { method: 'POST', path: '/orders', handler: 'orderAccept' },
  { method: 'GET', path: '/orders', handler: 'orderQuery' },
  { method: 'GET', path: '/orders/{orderId}', handler: 'orderQuery' },
  { method: 'GET', path: '/config', handler: 'orderQuery' },
  { method: 'GET', path: '/catalog', handler: 'orderQuery' },
  { method: 'POST', path: '/inventory/seed', handler: 'inventorySeed' },
  { method: 'POST', path: '/load-test/start', handler: 'loadGenerator' },
  { method: 'POST', path: '/measure/start', handler: 'queryImpactMeasure' },
  { method: 'GET', path: '/executions/{executionId}', handler: 'executionStatus' },
];

/**
 * CORS の許可内容。
 *
 * `shared/http.ts` の `CORS_HEADERS`（実応答に付けるヘッダー）と揃えなければならない。
 * プリフライトで許可したメソッドと実応答が許可するメソッドが食い違うと、
 * ブラウザ側では原因の分からない CORS エラーになる。
 * 一致は `order-api.test.ts` で突き合わせている（実行時の依存は張らない。design §5.3）。
 */
export const ORDER_API_CORS = {
  allowOrigins: Cors.ALL_ORIGINS,
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
} as const;

/**
 * 既定のステージ名。
 *
 * CDK の既定は `prod` だが、この API は検証専用である。
 * `query-impact-measure` に渡すベース URL の組み立て
 * （`urlForLambdaEnvironment`）にも使うため、定数として公開する。
 */
export const ORDER_API_STAGE_NAME = 'poc';

export interface OrderApiProps {
  readonly handlers: OrderApiHandlers;

  /**
   * ステージ名。API のベース URL に含まれる。
   *
   * @default 'poc'（CDK の既定は 'prod' だが、この API は検証専用である）
   */
  readonly stageName?: string;
}

/** REST API とルートを定義する Construct */
export class OrderApi extends Construct {
  readonly api: RestApi;

  /** 実際に使ったステージ名。ベース URL の組み立てで使う */
  readonly stageName: string;

  constructor(scope: Construct, id: string, props: OrderApiProps) {
    super(scope, id);

    this.stageName = props.stageName ?? ORDER_API_STAGE_NAME;

    this.api = new RestApi(this, 'RestApi', {
      description: '注文処理パイプライン PoC の検証用 API（認証なし。design §8）',
      // EDGE（既定）は CloudFront 経由になり、往復に CloudFront 側の遅延と
      // 揺らぎが乗る。本 PoC は同期パスのレイテンシ分位点を測って
      // 波及の有無を判定する（要件 12）ため、測りたい対象以外の要素を挟まない
      endpointConfiguration: { types: [EndpointType.REGIONAL] },
      deployOptions: {
        stageName: this.stageName,
        // 要件 13.4 / design §5.8。API Gateway 側のセグメントを X-Ray に流す
        tracingEnabled: true,
        // 実行ログ（loggingLevel）とアクセスログは有効にしない。
        // アカウント単位の CloudWatch Logs ロール設定が前提になり、
        // 未設定の環境ではデプロイが失敗する。毎分数千リクエストの
        // アクセスログは費用も無視できず、判定に使う指標は
        // 既定のメトリクス（Count / Latency / 4XX / 5XX）で足りる
      },
      // 全応答（エラー応答も）に CORS が必要なため、プリフライトは全リソースに付ける
      defaultCorsPreflightOptions: {
        allowOrigins: [...ORDER_API_CORS.allowOrigins],
        allowMethods: [...ORDER_API_CORS.allowMethods],
        allowHeaders: [...ORDER_API_CORS.allowHeaders],
      },
      defaultMethodOptions: {
        // 認証なし（design §8）。既定値だが、意図した状態であることを明示する
        authorizationType: AuthorizationType.NONE,
      },
    });

    // 統合はハンドラごとに 1 つ作って共有する。`order-query` は 4 ルートを
    // 受けるが、統合を分けても Lambda 側の権限が増えるだけで意味がない
    const integrations = new Map<keyof OrderApiHandlers, LambdaIntegration>();
    const integrationFor = (key: keyof OrderApiHandlers): LambdaIntegration => {
      let integration = integrations.get(key);
      if (integration === undefined) {
        integration = new LambdaIntegration(props.handlers[key], { proxy: true });
        integrations.set(key, integration);
      }
      return integration;
    };

    for (const route of ORDER_API_ROUTES) {
      // `resourceForPath` は中間リソース（`/inventory`）を作り、
      // 同じパスの再取得では既存のリソースを返す
      const resource: IResource = this.api.root.resourceForPath(route.path);
      resource.addMethod(route.method, integrationFor(route.handler));
    }
  }

  /**
   * API のベース URL（末尾はステージのスラッシュまで）。
   * `backend.addOutput` と `NEXT_PUBLIC_ORDER_API_URL` の出典になる（要件 14.10）。
   *
   * **この値を Lambda の環境変数に渡してはならない。**
   * 理由と代替は `urlForLambdaEnvironment` を参照。
   */
  get url(): string {
    return this.api.url;
  }

  /**
   * この API のベース URL のうち、**この API に統合された Lambda の環境変数へ
   * 渡せる形**のもの（末尾のスラッシュは含まない）。
   *
   * `query-impact-measure` は自分が属する API を HTTPS で叩く（design 論点 3）ため、
   * ベース URL を環境変数で受け取る必要がある。ところが `url`（= `api.url`）を
   * 渡すと**循環参照になり、デプロイできないテンプレートになる**。
   *
   * `api.url` は内部で `Stage.urlForPath()` を呼び、そこに埋まる `stageName` は
   * `AWS::ApiGateway::Stage` の `Ref` である（CDK の `Stage` は
   * `this.stageName = resource.ref` としている）。したがって次の循環ができる。
   *
   * ```
   * query-impact-measure（Lambda）
   *   ↓ environment（Ref: Stage）
   * Stage  →  Deployment  →  Method（/measure/start）
   *                              ↓ 統合先（Fn::GetAtt）
   *                        query-impact-measure …（循環）
   * ```
   *
   * そこで `url` を使わず、循環しない部品から URL を組み立てる。
   * `restApiId` は `AWS::ApiGateway::RestApi` 自身の参照であり
   * Method / Deployment / Stage を経由しないため、
   * Lambda → RestApi の一方向で閉じる（Method は Lambda に依存するが、
   * RestApi は Lambda に依存しない）。ステージ名は文字列としてそのまま埋める。
   *
   * この循環は `Ref` で作られるため **`App.synth()` は成功する**。
   * 検出しているのは `Template.fromStack`（undeployable の検査）と
   * `order-backend.test.ts` の参照グラフの検査である。
   */
  get urlForLambdaEnvironment(): string {
    const { region, urlSuffix } = Stack.of(this.api);
    return `https://${this.api.restApiId}.execute-api.${region}.${urlSuffix}/${this.stageName}`;
  }
}
