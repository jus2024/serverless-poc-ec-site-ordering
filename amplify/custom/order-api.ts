import { Stack } from 'aws-cdk-lib';
import {
  AuthorizationType,
  CognitoUserPoolsAuthorizer,
  Cors,
  EndpointType,
  LambdaIntegration,
  RestApi,
  type IResource,
} from 'aws-cdk-lib/aws-apigateway';
import type { IUserPool } from 'aws-cdk-lib/aws-cognito';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/**
 * API Gateway REST API とルート定義（design §5.8）。
 *
 * ## Cognito User Pool 認証を掛ける（方式 A）
 *
 * `userPool` を渡すと、全ルート（OPTIONS プリフライトを除く）に
 * Cognito User Pool オーソライザーを掛ける。API Gateway は既定で
 * **ID トークン**を検証するため、フロントエンドは `Authorization: Bearer <idToken>`
 * を付けて呼ぶ（`src/lib/orders/api.ts` が `fetchAuthSession()` で ID トークンを取得する）。
 * これにより、この PoC を Amplify Hosting にデプロイしても無認証で叩かれない。
 *
 * CORS プリフライト（OPTIONS）には認証を掛けない。ブラウザはプリフライトに
 * `Authorization` ヘッダーを付けないため、ここを認証必須にすると全 CORS
 * リクエストが失敗する。`defaultCorsPreflightOptions` が生成する OPTIONS は
 * MOCK 統合で認証なしのまま残す（`order-api.test.ts` が検査する）。
 *
 * ### 既知の制約: measure の内部呼び出しが一時的に使用不可
 *
 * `query-impact-measure` は自分が属する API の `GET /orders` を HTTPS で叩く
 * （design 論点 3）。認証を掛けたことで、この内部呼び出しは現在 401 になり、
 * **measure（`POST /measure/start`）は一時的に使用できない**。復旧には
 * Lambda 側でのトークン取得（M2M。例: Cognito のクライアントクレデンシャル）が
 * 必要である（方式 A で許容した制約。`query-impact-measure/query-target.ts` の注記も参照）。
 *
 * `userPool` を省略した場合（テストやローカルの合成）は従来どおり
 * `AuthorizationType.NONE` にフォールバックする。ただし `backend.ts` からは
 * 必ず `userPool` を渡すこと。
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
  // `Authorization` は Cognito 認証（方式 A）で全リクエストに付くため許可する。
  // `shared/http.ts` の `CORS_HEADERS` と揃える（`order-api.test.ts` が突き合わせる）
  allowHeaders: ['Content-Type', 'Authorization'],
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
   * Cognito User Pool。指定すると全ルート（OPTIONS を除く）に
   * Cognito User Pool オーソライザーを掛ける（方式 A）。
   *
   * 省略した場合は `AuthorizationType.NONE`（認証なし）にフォールバックする。
   * テストやローカルの合成では省略してよいが、`backend.ts` からは必ず渡すこと。
   */
  readonly userPool?: IUserPool;

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

    // Cognito オーソライザーは userPool が渡されたときだけ作る。
    // 省略時（テスト・ローカル合成）は authorizationType = NONE にフォールバックする
    const authorizer =
      props.userPool === undefined
        ? undefined
        : new CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
            cognitoUserPools: [props.userPool],
          });

    this.api = new RestApi(this, 'RestApi', {
      description:
        authorizer === undefined
          ? '注文処理パイプライン PoC の検証用 API（認証なし。テスト/ローカル合成用のフォールバック）'
          : '注文処理パイプライン PoC の検証用 API（Cognito User Pool 認証。方式 A）',
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
      // `defaultMethodOptions` は `addMethod` で足すルートにのみ適用される。
      // `defaultCorsPreflightOptions` が生成する OPTIONS には波及しないため、
      // プリフライトは認証なし（NONE）のまま残る（`order-api.test.ts` が検査）
      defaultMethodOptions:
        authorizer === undefined
          ? {
              // フォールバック: 認証なし
              authorizationType: AuthorizationType.NONE,
            }
          : {
              // 方式 A: 全ルートに Cognito User Pool 認証を掛ける
              authorizationType: AuthorizationType.COGNITO,
              authorizer,
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
