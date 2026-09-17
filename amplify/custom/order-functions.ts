import { fileURLToPath } from 'node:url';
import { ArnFormat, Duration, Names, Stack } from 'aws-cdk-lib';
import type { TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, type BundlingOptions } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import type { OrderApi } from './order-api.js';
import { ORDER_TABLE_ENV_KEYS, type OrderTables } from './order-tables.js';
import { getVerificationConfig, type VerificationConfig } from './verification-config.js';

/**
 * Lambda 関数の定義と IAM 権限（design §5.2 / §5.9）。
 *
 * ## この Construct が作るもの
 *
 * design §5.2 の 7 関数すべてを作る。同期パス（API Gateway から呼ばれる 3 関数）、
 * `order-processor`（Streams コンシューマ）、計測系の 3 関数
 * （`load-generator` / `query-impact-measure` / `execution-status`）である。
 *
 * `order-processor` の**イベントソース（Streams ESM）はここでは作らない**。
 * ESM の設定は消費能力 `S × P ÷ D` の変数 P を含む観測の道具であり
 * （design §2.1 / §5.6）、DLQ とともに `order-stream.ts` が持つ。
 * この Construct は「関数とその権限」だけに責務を絞る。
 * Streams の読み取り権限も `DynamoEventSource` が付与するため、
 * design §5.9 の表どおり**ここには現れない**。
 *
 * ## 予約枠を設定しない（design §5.2）
 *
 * `reservedConcurrentExecutions` を**どの関数にも設定しない**。
 * 本 PoC の問いの 1 つは「後続処理の負荷が同期パスに波及するか」であり
 * （design §2.6）、波及はアカウントの同時実行枠の奪い合いとして現れる。
 * 枠を人為的に区切ると、観測したい現象そのものを設計で消してしまう。
 *
 * ## 環境変数は全関数で同じものを渡す（2 つの例外を除く）
 *
 * テーブル名 5 つと実行時の検証パラメータ 9 つを、必要な関数だけに絞らず
 * 全関数へ一律に渡す。関数ごとに絞ると、ハンドラが新しいテーブルを触り始めたときに
 * **合成は通るのに実行時だけ壊れる**（`RuntimeConfigError` が出る）状態が生まれる。
 * 環境変数は権限ではないので、渡しても触れるようにはならない。
 * 実際に触れる範囲は IAM だけで決める（design §5.9）。
 *
 * 検証パラメータを全関数に渡すのは `GET /config` の要件でもある。
 * 「実際にデプロイされている値」を出典にするため（要件 10.6 / 14.7）、
 * 既定値への暗黙のフォールバックに頼らず 9 項目すべてを明示的に設定する。
 *
 * 例外は計測系だけが読む 2 つである。
 *
 * - `ORDERS_STREAM_ARN`: `load-generator` と `query-impact-measure` のみ。
 *   `DescribeStream` 権限を持つのがこの 2 関数だけであり（design §5.9）、
 *   権限の無い関数に値だけ配ると配線の意図が読み取れなくなる
 *   （`load-generator/shard-count.ts` の注記）
 * - `ORDER_API_BASE_URL`: `query-impact-measure` のみ。
 *   値が API に依存するため、この Construct では設定できない
 *   （`wireApiBaseUrl` を参照）
 */

/** `amplify/functions/` の絶対パス。`tsx` がファイルを直接読むため `import.meta.url` で解決できる */
const FUNCTIONS_ROOT = fileURLToPath(new URL('../functions/', import.meta.url));

/** design §5.2 の表（タイムアウト・メモリ）をそのまま写したもの */
export const ORDER_FUNCTION_SPECS = {
  /** `POST /orders`（要件 1） */
  orderAccept: {
    logicalName: 'order-accept',
    timeout: Duration.seconds(30),
    memorySize: 256,
  },
  /** `GET /orders/{orderId}`、`GET /orders`、`GET /config`、`GET /catalog` */
  orderQuery: {
    logicalName: 'order-query',
    timeout: Duration.seconds(30),
    memorySize: 256,
  },
  /** `POST /inventory/seed`（要件 5.7）。SKU を増やしても切れないよう 15 分取る */
  inventorySeed: {
    logicalName: 'inventory-seed',
    timeout: Duration.minutes(15),
    memorySize: 512,
  },
  /**
   * Streams コンシューマ。4 段階を直列実行する（要件 9.1 / 9.2）。
   *
   * タイムアウト 300s は `BatchSize × D` を超える必要がある（design §5.2）。
   * 既定（`BatchSize = 1`、D 約 3.6 秒）では大幅に余るが、`BatchSize` を
   * 上げる検証で 1 呼び出しが長くなるため余裕を取ってある。
   * ここを詰めると、観測したい滞留ではなく**タイムアウトが先に壁になる**。
   */
  orderProcessor: {
    logicalName: 'order-processor',
    timeout: Duration.minutes(5),
    memorySize: 512,
  },
  /** `POST /load-test/start` + 自己再帰ワーカー。CPU を稼ぐため 1024MB */
  loadGenerator: {
    logicalName: 'load-generator',
    timeout: Duration.minutes(15),
    memorySize: 1024,
  },
  /** `POST /measure/start` + 計測ワーカー */
  queryImpactMeasure: {
    logicalName: 'query-impact-measure',
    timeout: Duration.minutes(15),
    memorySize: 1024,
  },
  /** `GET /executions/{executionId}` */
  executionStatus: {
    logicalName: 'execution-status',
    timeout: Duration.seconds(30),
    memorySize: 256,
  },
} as const;

export type OrderFunctionKey = keyof typeof ORDER_FUNCTION_SPECS;

/**
 * 実行時の検証パラメータを渡す環境変数のキー。
 *
 * 名前は `verification-config.ts`（合成時）と `shared/runtime-config.ts`（実行時）にも
 * 現れる。3 箇所が食い違うと合成は通るのに計測条件がずれるため、
 * `order-functions.test.ts` で突き合わせている。
 */
export const ORDER_PARAM_ENV_KEYS = {
  paymentDelayMs: 'ORDER_PAYMENT_DELAY_MS',
  notificationDelayMs: 'ORDER_NOTIFICATION_DELAY_MS',
  paymentFailureRate: 'ORDER_PAYMENT_FAILURE_RATE',
  dataTtlDays: 'ORDER_DATA_TTL_DAYS',
  maxOrdersPerMinute: 'ORDER_MAX_ORDERS_PER_MINUTE',
  maxDurationSeconds: 'ORDER_MAX_DURATION_SECONDS',
  maxMeasureConcurrency: 'ORDER_MAX_MEASURE_CONCURRENCY',
  streamBatchSize: 'ORDER_STREAM_BATCH_SIZE',
  streamParallelizationFactor: 'ORDER_STREAM_PARALLELIZATION_FACTOR',
} as const satisfies Partial<Record<keyof VerificationConfig, string>>;

type ParamKey = keyof typeof ORDER_PARAM_ENV_KEYS;

/**
 * 計測系だけに渡す環境変数のキー。
 *
 * 実行時側（`load-generator/shard-count.ts` の `ORDERS_STREAM_ARN_ENV` と
 * `query-impact-measure/query-target.ts` の `ORDER_API_BASE_URL_ENV`）にも
 * 同じ文字列がある。**意図的に重複させている**（IaC から Lambda の実行時モジュールを
 * import すると、Powertools や AWS SDK が合成の依存に入る。`order-monitoring.ts` の
 * EMF 定数と同じ判断）。食い違いは `order-functions.test.ts` が突き合わせて検出する。
 */
export const ORDER_MEASUREMENT_ENV_KEYS = {
  /** 注文テーブルのストリーム ARN（`DescribeStream` の対象。要件 19.1） */
  ordersStreamArn: 'ORDERS_STREAM_ARN',
  /** 計測対象 API のベース URL（design 論点 3）。`wireApiBaseUrl` で設定する */
  orderApiBaseUrl: 'ORDER_API_BASE_URL',
} as const;

/**
 * esbuild のバンドル設定（design §5.2 の共通設定）。
 *
 * `externalModules` を明示するのは、AWS SDK を除外するかどうかの既定値が
 * CDK のフィーチャーフラグ次第で変わるためである。
 *
 * ## `@smithy/*` を external にしてはならない（タスク 13 の実測で判明）
 *
 * 当初は `['@aws-sdk/*', '@smithy/*']` としていた。「ランタイム同梱の SDK と
 * バンドルした smithy が混ざるのを避ける」という意図だったが、
 * **Lambda の Node.js 22 ランタイムは `@smithy/*` を `/var/task` から
 * 解決可能な形では同梱していない**。同梱されているのは `@aws-sdk/*` であり、
 * その内部依存としての smithy は `@aws-sdk` パッケージからしか解決できない。
 *
 * その結果、`aws-xray-sdk-core`（Powertools Tracer が内部で使う）の
 * `captureAWSClient` が `require("@smithy/service-error-classification")` を
 * 実行した時点で `Runtime.ImportModuleError` になり、
 * **Tracer を使う 3 関数（`order-accept` / `order-query` / `order-processor`）が
 * 初期化に失敗して全リクエストが 500 になった**。
 * `inventory-seed` など Tracer を使わない関数は動くため、
 * 「一部のルートだけ 500」という分かりにくい壊れ方になる。
 *
 * よって `@smithy/*` はバンドルする（CDK の既定と同じ挙動）。
 * `@aws-sdk/*` はランタイム同梱を使い続ける。smithy の実体が
 * バンドル側とランタイム側で 2 つになるが、
 * `service-error-classification` はエラーオブジェクトを見るだけの
 * 純粋な述語群であり、実害はない。
 *
 * トレードオフとして、ランタイム同梱の SDK バージョンは AWS 側で更新され得る。
 * 計測値（D）の再現性を厳密にしたい場合は `externalModules: []` にして
 * SDK ごとバンドルする選択もあるが、バンドルサイズと初期化時間が増え、
 * 同時実行を伸ばすシナリオ（軸 B）でコールドスタートの影響が大きくなるため
 * ここでは採らない。
 */
const BUNDLING: BundlingOptions = {
  minify: true,
  sourceMap: true,
  target: 'node22',
  externalModules: ['@aws-sdk/*'],
};

export interface OrderFunctionsProps {
  /** テーブル 4 本。環境変数と IAM の対象になる */
  readonly tables: OrderTables;

  /**
   * 解決済みの検証パラメータ。
   *
   * @default `getVerificationConfig()`（環境変数から解決）
   */
  readonly config?: VerificationConfig;

  /**
   * 物理関数名の接頭辞。
   *
   * @default 'kiro'（design §5.2 の `kiro-order-accept` などに合わせる）
   */
  readonly functionNamePrefix?: string;

  /**
   * 物理関数名の末尾に付ける一意サフィックス。
   *
   * 既定で付けるのは `order-tables.ts` と同じ理由である。Lambda の関数名は
   * リージョン内で一意でなければならず、固定名では検証者ごとの sandbox や
   * ブランチごとのスタックが 2 つ目のデプロイで衝突する。
   * 空文字を渡すと design §5.2 の固定名そのものになる。
   *
   * @default 構築パスとスタック名から算出した 8 文字
   */
  readonly functionNameSuffix?: string;
}

/** Lambda 関数と IAM 権限をまとめて定義する Construct */
export class OrderFunctions extends Construct {
  /** `POST /orders`。注文テーブルへの `PutItem` だけを持つ */
  readonly orderAccept: NodejsFunction;

  /** 4 つの GET ルート。書き込み権限を持たない（要件 2.8） */
  readonly orderQuery: NodejsFunction;

  /** `POST /inventory/seed`。引当在庫テーブルへの書き込みだけを持つ */
  readonly inventorySeed: NodejsFunction;

  /**
   * Streams コンシューマ。`order-stream.ts` がイベントソースを繋ぐ。
   * この関数だけは API Gateway から呼ばれない（design §5.8 に対応するルートが無い）。
   */
  readonly orderProcessor: NodejsFunction;

  /** `POST /load-test/start` + 自己再帰ワーカー（要件 11） */
  readonly loadGenerator: NodejsFunction;

  /** `POST /measure/start` + 計測ワーカー（要件 12） */
  readonly queryImpactMeasure: NodejsFunction;

  /** `GET /executions/{executionId}`。実行レコードを読むだけ（要件 11.6 / 12.5） */
  readonly executionStatus: NodejsFunction;

  private readonly tables: OrderTables;
  private readonly environment: Record<string, string>;
  private readonly functionName: (logicalName: string) => string;

  constructor(scope: Construct, id: string, props: OrderFunctionsProps) {
    super(scope, id);

    const config = props.config ?? getVerificationConfig();
    const prefix = props.functionNamePrefix ?? 'kiro';
    const suffix = props.functionNameSuffix ?? defaultNameSuffix(this);

    this.tables = props.tables;
    this.functionName = (logicalName) =>
      [prefix, logicalName, suffix].filter((part) => part !== '').join('-');
    this.environment = {
      ...props.tables.tableEnvironment,
      ...buildParameterEnvironment(config),
      // `sourceMap: true` でバンドルしても、これがないとスタックトレースは
      // minify 後の位置を指す。ソースマップを出す意味を残すために設定する
      NODE_OPTIONS: '--enable-source-maps',
    };

    this.orderAccept = this.defineFunction('orderAccept');
    this.orderQuery = this.defineFunction('orderQuery');
    this.inventorySeed = this.defineFunction('inventorySeed');
    this.orderProcessor = this.defineFunction('orderProcessor');
    this.loadGenerator = this.defineFunction('loadGenerator');
    this.queryImpactMeasure = this.defineFunction('queryImpactMeasure');
    this.executionStatus = this.defineFunction('executionStatus');

    // 計測系だけが読む環境変数（クラスの冒頭の注記を参照）。
    // `ORDER_API_BASE_URL` は API に依存するため `wireApiBaseUrl` で後から設定する
    for (const fn of [this.loadGenerator, this.queryImpactMeasure]) {
      fn.addEnvironment(
        ORDER_MEASUREMENT_ENV_KEYS.ordersStreamArn,
        props.tables.ordersStreamArn
      );
    }

    this.grantSyncPathPermissions();
    this.grantProcessorPermissions();
    this.grantLoadGeneratorPermissions();
    this.grantQueryImpactMeasurePermissions();
    this.grantExecutionStatusPermissions();
  }

  /** すべての関数。ダッシュボードの配線で使う */
  get all(): NodejsFunction[] {
    return [
      this.orderAccept,
      this.orderQuery,
      this.inventorySeed,
      this.orderProcessor,
      this.loadGenerator,
      this.queryImpactMeasure,
      this.executionStatus,
    ];
  }

  /**
   * 計測対象 API のベース URL を `query-impact-measure` に渡す（design 論点 3）。
   *
   * この Construct のコンストラクタで設定できない。API は関数を統合先として
   * 参照するため、関数より後に作られる。`backend.ts` が API を作った直後に
   * これを呼ぶ（呼ばないと `ORDER_API_BASE_URL` が未設定になり、
   * 計測の開始要求が `OrderApiBaseUrlError` で 500 になる）。
   *
   * **`OrderApi` を受け取って `urlForLambdaEnvironment` をここで読む。**
   * URL の文字列を引数にすると `api.url` を渡せてしまい、
   * その場合は循環参照で合成が失敗する（`order-api.ts` の同名の getter を参照）。
   * 呼び出し側に正しい方を選ばせない形にしてある。
   */
  wireApiBaseUrl(api: OrderApi): void {
    this.queryImpactMeasure.addEnvironment(
      ORDER_MEASUREMENT_ENV_KEYS.orderApiBaseUrl,
      api.urlForLambdaEnvironment
    );
  }

  /**
   * design §5.2 の共通設定で 1 関数を定義する。
   * エントリは `amplify/functions/{logicalName}/handler.ts` に固定する。
   */
  private defineFunction(key: OrderFunctionKey): NodejsFunction {
    const spec = ORDER_FUNCTION_SPECS[key];

    return new NodejsFunction(this, capitalize(key), {
      functionName: this.functionName(spec.logicalName),
      entry: `${FUNCTIONS_ROOT}${spec.logicalName}/handler.ts`,
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      // 要件 13.4。API 側と Streams 側のトレースは自動では繋がらないため、
      // ハンドラ側で order_id をアノテーションに付けて突き合わせる（design §6.3）
      tracing: Tracing.ACTIVE,
      timeout: spec.timeout,
      memorySize: spec.memorySize,
      environment: this.environment,
      bundling: BUNDLING,
      // reservedConcurrentExecutions は設定しない（design §5.2）
    });
  }

  /**
   * 同期パス 3 関数の IAM 権限（design §5.9）。
   *
   * `grantWriteData` などのまとめて付与するヘルパーは使わない。
   * あれは `BatchWriteItem` / `UpdateItem` / `DeleteItem` / `DescribeTable` を
   * まとめて許可するため、design §5.9 の表より広くなる。
   * 特に `order-query` に書き込みが混ざると要件 2.8 に反するだけでなく、
   * 照会が注文レコードを更新して Streams に `MODIFY` を流し、
   * ESM のイベントフィルタの前提（Property 8）を崩す事故に繋がる。
   */
  private grantSyncPathPermissions(): void {
    const { ordersTable, inventoryTable, ordersCustomerIndexName } = this.tables;

    this.orderAccept.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:PutItem'],
        resources: [ordersTable.tableArn],
      })
    );

    this.orderQuery.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        // 注文 1 件の照会も `Query` で行う（SK が customer_id のため
        // 注文 ID だけでは GetItem できない。design §4.2）
        actions: ['dynamodb:Query'],
        resources: [
          ordersTable.tableArn,
          // GSI は名前で限定する（`index/*` にしない。GSI は 1 本しかない）
          `${ordersTable.tableArn}/index/${ordersCustomerIndexName}`,
        ],
      })
    );

    this.inventorySeed.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        // 通常は BatchWriteItem のみを使う。PutItem は端数を 1 件ずつ
        // 投入する経路のために design §5.9 が併記している
        actions: ['dynamodb:BatchWriteItem', 'dynamodb:PutItem'],
        resources: [inventoryTable.tableArn],
      })
    );
  }

  /**
   * `order-processor` の IAM 権限（design §5.9）。
   *
   * 3 つのテーブルに触るが、いずれも**必要な 1 操作だけ**に絞る。
   *
   * - 注文テーブル: `UpdateItem` のみ。段階の記録は `UpdateItem` 1 回で完結し
   *   （design §5.4）、注文レコードは Streams の `NewImage` から取るため
   *   読み取り権限を要さない（design §5.5）。`GetItem` を付けると
   *   「読み直しても動く」実装が入り込む余地ができ、その 1 回の読み取りが
   *   処理時間 D に乗って全シナリオの消費能力をずらす
   * - 引当在庫テーブル: `UpdateItem` のみ。`TransactWriteItems` は
   *   トランザクション内の各操作に対応するアクションで認可されるため、
   *   `Update` だけを組み立てている限り（`allocation.ts`）これで足りる
   * - 冪等性テーブル: Powertools の `DynamoDBPersistenceLayer` が使う 4 操作
   *
   * Streams の読み取り権限（`GetRecords` / `GetShardIterator` /
   * `DescribeStream` / `ListStreams`）はここでは付けない。
   * `DynamoEventSource` が `grantStreamRead` で付与する（design §5.9）ため、
   * ここで重ねると同じ許可が 2 つのポリシーに散る。
   */
  private grantProcessorPermissions(): void {
    const { ordersTable, inventoryTable, idempotencyTable } = this.tables;

    this.orderProcessor.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:UpdateItem'],
        resources: [ordersTable.tableArn, inventoryTable.tableArn],
      })
    );

    this.orderProcessor.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        // Powertools Idempotency の永続化層が使う操作。
        // `PutItem`（条件付き作成）/ `GetItem`（前回の結果の取得）/
        // `UpdateItem`（完了時の書き換え）/ `DeleteItem`（例外時の破棄）
        actions: [
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:UpdateItem',
          'dynamodb:DeleteItem',
        ],
        resources: [idempotencyTable.tableArn],
      })
    );
  }

  /**
   * `load-generator` の IAM 権限（design §5.9）。
   *
   * - 注文テーブル: `BatchWriteItem` のみ。`order-accept` を経由せず直接書き込む
   *   （要件 11.10）。`PutItem` を足さないのは `order-batch.ts` が
   *   端数も含めて `BatchWriteItem` だけで投入するためである
   * - 注文テーブル: `DescribeTable`（warm throughput の現在値。design §5.7）
   * - 注文テーブルのストリーム: `DescribeStream`（オープンシャード数 S。要件 19.1）
   * - 実行管理テーブル: 読み書き
   * - 自身への `lambda:InvokeFunction`（15 分を超える継続時間の引き継ぎ。要件 11.9）
   *
   * `DescribeStream` の対象は**テーブル ARN ではなくストリーム ARN**である。
   * テーブル ARN に対して許可しても `DescribeStream` は認可されず、
   * 全実行の `shard_count_error` に `AccessDeniedException` が入る
   * （投入自体は続くため、静かに「消費能力の検証に使えない実行」が量産される）。
   */
  private grantLoadGeneratorPermissions(): void {
    const { ordersTable } = this.tables;

    this.loadGenerator.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:BatchWriteItem'],
        resources: [ordersTable.tableArn],
      })
    );

    this.grantShardObservation(this.loadGenerator);
    this.grantExecutionsReadWrite(this.loadGenerator);
    this.grantSelfInvoke(this.loadGenerator, 'loadGenerator');
  }

  /**
   * `query-impact-measure` の IAM 権限。
   *
   * ## design §5.9 からの意図的な逸脱: シャード数の観測権限を足す
   *
   * design §5.9 の表は `query-impact-measure` に「executions: 読み書き、
   * 自身への `lambda:InvokeFunction`」だけを挙げており、
   * `DescribeStream` / `DescribeTable` は `load-generator` の行にしかない。
   * しかし**要件 12.5 は計測結果を実行条件（シャード数を含む）とともに
   * 記録することを求めており**、`query-impact-measure/handler.ts` は
   * `load-generator` と同じ `observeShardCount` を呼ぶ。
   *
   * 表のとおりに権限を絞ると、`observeShardCount` は例外を投げない設計
   * （要件 19.5 / design §E-8）なので**計測は普通に完走する**。
   * ただし全ての計測結果に `shard_count_error = AccessDeniedException` が付き、
   * `open_shard_count` が空になる。Property 10 / 11 の判定では
   * 「消費能力の検証に使えない実行」として扱われるため、
   * 軸 A / 軸 B のどちらの比較表（design §11.2）も埋まらない。
   * デプロイもテストも通り、シナリオを回し終えた後に気づく類の欠落である。
   *
   * したがって `load-generator` と同じ 2 つを付与する。
   * 最小権限からの逸脱幅は「読み取り専用の 2 API が 1 関数増える」だけで、
   * 対象も注文テーブルとそのストリームに限定される。
   *
   * 計測対象 API（API Gateway）を叩くための IAM 権限は**要らない**
   * （API に認証を掛けていない。design §5.9 / §8）。
   */
  private grantQueryImpactMeasurePermissions(): void {
    this.grantShardObservation(this.queryImpactMeasure);
    this.grantExecutionsReadWrite(this.queryImpactMeasure);
    this.grantSelfInvoke(this.queryImpactMeasure, 'queryImpactMeasure');
  }

  /**
   * `execution-status` の IAM 権限（design §5.9）。
   *
   * `GetItem` のみ。**書き込みを持たせない**のが要点である（`order-query` と同じ判断）。
   * 実行レコードを書けるのは負荷生成と並行計測の当事者だけであり、
   * 照会が触れると投入件数や実測レートの出典が曖昧になる
   * （`execution-status/views.ts` の注記）。
   */
  private grantExecutionStatusPermissions(): void {
    this.executionStatus.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem'],
        resources: [this.tables.executionsTable.tableArn],
      })
    );
  }

  /**
   * シャード数と warm throughput の観測権限（design §5.7）。
   *
   * `DescribeStream` はストリーム ARN、`DescribeTable` はテーブル ARN に対して
   * 与える。対象が違うため 1 つのステートメントにまとめない
   * （まとめると `DescribeTable` をストリーム ARN に対しても許可することになり、
   * 意味の無い許可が残る）。
   */
  private grantShardObservation(fn: NodejsFunction): void {
    const { ordersTable, ordersStreamArn } = this.tables;

    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:DescribeStream'],
        resources: [ordersStreamArn],
      })
    );

    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:DescribeTable'],
        resources: [ordersTable.tableArn],
      })
    );
  }

  /**
   * 実行管理テーブルの読み書き（design §5.9 の「executions: 読み書き」）。
   *
   * 実際に使うのは `PutItem`（開始時のレコード作成）と `UpdateItem`
   * （進捗・完了・失敗）だが、`GetItem` も含める。design §5.9 が
   * 「読み書き」と書いており、`DeleteItem` は含めない
   * （実行レコードの削除は TTL に任せる。design 論点 5）。
   */
  private grantExecutionsReadWrite(fn: NodejsFunction): void {
    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
        resources: [this.tables.executionsTable.tableArn],
      })
    );
  }

  /**
   * 自身への `lambda:InvokeFunction`（design §5.9、要件 11.9 / 12.1）。
   *
   * ## `fn.grantInvoke(fn)` を使わない理由
   *
   * `grantInvoke` は関数 ARN を `Fn::GetAtt` で参照する。その参照が
   * 関数自身のロールに付くポリシー（`ServiceRole/DefaultPolicy`）に入ると、
   * 関数 → ロール → ポリシー → 関数 の循環参照になり得る。
   *
   * 物理関数名はこの Construct が決めている（`this.functionName`）ので、
   * ARN を文字列として組み立てれば関数リソースを参照せずに済む。
   * 循環の余地を作らない側を選ぶ。
   *
   * 対象を `:*` のバージョン修飾子まで広げないのは、
   * `shared/self-invoke.ts` が `AWS_LAMBDA_FUNCTION_NAME`（修飾子なし）を
   * 宛先にするためである。
   */
  private grantSelfInvoke(fn: NodejsFunction, key: OrderFunctionKey): void {
    const functionArn = Stack.of(this).formatArn({
      service: 'lambda',
      resource: 'function',
      resourceName: this.functionName(ORDER_FUNCTION_SPECS[key].logicalName),
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });

    fn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [functionArn],
      })
    );
  }
}

/**
 * 検証パラメータを Lambda の環境変数へ展開する（design §10.1）。
 *
 * 数値をそのまま文字列化する。実行時側（`shared/runtime-config.ts`）が
 * 同じ範囲で再検証するため、ここで値の妥当性は見ない
 * （`VerificationConfig` に入っている時点で合成時の検証を通っている）。
 */
export function buildParameterEnvironment(
  config: Pick<VerificationConfig, ParamKey>
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of Object.keys(ORDER_PARAM_ENV_KEYS) as ParamKey[]) {
    environment[ORDER_PARAM_ENV_KEYS[key]] = String(config[key]);
  }
  return environment;
}

/** 環境変数のキー一覧（テーブル名 + 検証パラメータ）。突き合わせ用 */
export const ORDER_FUNCTION_ENV_KEYS: readonly string[] = [
  ...Object.values(ORDER_TABLE_ENV_KEYS),
  ...Object.values(ORDER_PARAM_ENV_KEYS),
];

/**
 * 物理関数名の既定サフィックス。
 * `order-tables.ts` の `defaultTableNameSuffix` と同じ考え方
 * （スタック名を含むハッシュの下 8 桁。再デプロイでは変わらない）。
 */
function defaultNameSuffix(scope: Construct): string {
  return Names.uniqueResourceName(scope, { maxLength: 12 }).slice(-8).toLowerCase();
}

/** Construct ID 用。`orderAccept` → `OrderAccept` */
function capitalize(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}
