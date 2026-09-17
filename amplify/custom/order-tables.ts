import { Names, RemovalPolicy } from 'aws-cdk-lib';
import {
  AttributeType,
  Billing,
  ProjectionType,
  StreamViewType,
  TableV2,
  type WarmThroughput,
} from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import {
  getVerificationConfig,
  type VerificationConfig,
} from './verification-config.js';

/**
 * 検証用の DynamoDB テーブル 4 本（design §4.1〜§4.4、要件 17.2 / 17.3 / 17.5 / 17.6 / 10.3 / 2.3 / 16.6）。
 *
 * ## `TableV2` を使う理由
 *
 * 注文テーブルは warm throughput を設定する必要がある（要件 10.3、軸 B の仮説検証）。
 * `warmThroughput` は `TableV2` の props としてのみ提供されているため、
 * 4 本すべてを `TableV2` で揃える（同じ Construct 内で世代が混ざるのを避ける）。
 *
 * ## 物理テーブル名について（design §4.1 からの意図的な逸脱）
 *
 * design §4.1 は `kiro-roasters-orders` などの固定名を挙げているが、
 * 既定では**固定名を使わず一意サフィックスを付ける**。
 *
 * 固定名はこのリポジトリの前提と噛み合わない。
 * `ampx sandbox` は検証者ごとに別スタックを作り、Amplify Hosting は
 * ブランチごとに別スタックを作る。同一アカウントで 2 つ目のデプロイを行うと
 * DynamoDB のテーブル名は衝突し、後から作る側が失敗する。
 * 全テーブルが `RemovalPolicy.DESTROY`（要件 17.5）であることも合わさって、
 * 片方の削除が他方の参照先を消す事故を招きやすい。
 *
 * 固定名でなくても失うものはない。テーブル名を必要とするのは Lambda（環境変数で受け取る）と
 * CloudWatch ダッシュボード（`table.tableName` の参照で解決する）だけであり、
 * 名前の文字列そのものに依存する箇所はない。
 *
 * design §4.1 の名前をそのまま使いたい場合（単一の専用アカウントで検証する場合など）は
 * `tableNameSuffix: ''` を渡す。design §4.1 の「引当在庫テーブルは既存の
 * `kiro-roasters-inventory-good` と衝突させない」という意図は、
 * 接頭辞 `kiro-roasters` と論理名 `order-inventory` の組み合わせで保っている。
 */
export interface OrderTablesProps {
  /**
   * 物理テーブル名の接頭辞。
   *
   * @default 'kiro-roasters'（design §4.1）
   */
  readonly tableNamePrefix?: string;

  /**
   * 物理テーブル名の末尾に付ける一意サフィックス。
   * 空文字を渡すと design §4.1 の固定名そのものになる（衝突の責任は呼び出し側）。
   *
   * @default 構築パスとスタック名から算出した 8 文字
   */
  readonly tableNameSuffix?: string;

  /**
   * 解決済みの検証パラメータ。
   *
   * @default `getVerificationConfig()`（環境変数から解決）
   */
  readonly config?: VerificationConfig;
}

/** 注文テーブルの GSI 名（design §4.2） */
export const ORDER_CUSTOMER_INDEX_NAME = 'customer-orders-index';

/**
 * Lambda へ渡す環境変数のキー（design §5.2 の全関数で共通）。
 * Lambda 側の `shared/runtime-config.ts` が同じキーを読む。
 */
export const ORDER_TABLE_ENV_KEYS = {
  ordersTableName: 'ORDERS_TABLE_NAME',
  inventoryTableName: 'ORDER_INVENTORY_TABLE_NAME',
  idempotencyTableName: 'ORDER_IDEMPOTENCY_TABLE_NAME',
  executionsTableName: 'ORDER_EXECUTIONS_TABLE_NAME',
  ordersCustomerIndexName: 'ORDERS_CUSTOMER_INDEX_NAME',
} as const;

/** DynamoDB テーブル 4 本をまとめて定義する Construct */
export class OrderTables extends Construct {
  /** 注文テーブル。Streams 有効、warm throughput 可変（design §4.2） */
  readonly ordersTable: TableV2;

  /** 引当在庫テーブル（design §4.4） */
  readonly inventoryTable: TableV2;

  /** 冪等性管理テーブル。Powertools Idempotency の既定スキーマに合わせる（要件 16.6） */
  readonly idempotencyTable: TableV2;

  /** 実行管理テーブル。負荷生成と並行計測で共用する（design §4.3） */
  readonly executionsTable: TableV2;

  /** 注文テーブルの GSI 名 */
  readonly ordersCustomerIndexName = ORDER_CUSTOMER_INDEX_NAME;

  constructor(scope: Construct, id: string, props: OrderTablesProps = {}) {
    super(scope, id);

    const config = props.config ?? getVerificationConfig();
    const prefix = props.tableNamePrefix ?? 'kiro-roasters';
    const suffix = props.tableNameSuffix ?? defaultTableNameSuffix(this);
    const name = (logicalName: string) =>
      [prefix, logicalName, suffix].filter((part) => part !== '').join('-');

    this.ordersTable = new TableV2(this, 'OrdersTable', {
      tableName: name('orders'),
      // PK だけでは `GetItem` できないキー設計（design §4.2）。
      // 出典のデータモデルを尊重し、照会側を `Query` で対応させる（要件 2.3）
      partitionKey: { name: 'order_id', type: AttributeType.STRING },
      sortKey: { name: 'customer_id', type: AttributeType.STRING },
      // オンデマンド（要件 17.3）。上限（maxWriteRequestUnits）は設定しない。
      // 上限を設けると DynamoDB 側が先に壁になり、観測したい壁が見えなくなる
      billing: Billing.onDemand(),
      // 後続処理は `NewImage` だけを読むが（design §5.5）、
      // 差分の追跡に備えて OLD も流す
      dynamoStream: StreamViewType.NEW_AND_OLD_IMAGES,
      // 検証データを蓄積し続けない手段（要件 17.6）
      timeToLiveAttribute: 'expires_at',
      warmThroughput: toWarmThroughput(config),
      globalSecondaryIndexes: [
        {
          indexName: ORDER_CUSTOMER_INDEX_NAME,
          partitionKey: { name: 'customer_id', type: AttributeType.STRING },
          sortKey: { name: 'created_at', type: AttributeType.STRING },
          // 射影 ALL のため基表と同量の書き込みが発生する。
          // GSI 側のスロットルも観測対象（要件 13.8、design §4.2）
          projectionType: ProjectionType.ALL,
          // GSI には warm throughput を設定しない。
          // 軸 B の仮説は「基表のパーティション数 = Streams のシャード数」に関するもので
          // （design §2.5）、GSI をウォームしても検証したい量は動かない。
          // 引き下げ不可の課金を必要のない側に負わせない（要件 17.8）。
          //
          // 実測（B1 / B2）でこの判断は裏づけられた。基表の warm write を 40,000 に
          // 引き上げると S は 4 → 64 になり（仮説は成立）、GSI は warm 4,000 のままでも
          // 書き込みスロットル 0 件・使用率 4.17% にとどまった（design §2.5）。
        },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.inventoryTable = new TableV2(this, 'InventoryTable', {
      tableName: name('order-inventory'),
      // 在庫管理編の Good Table を踏襲（design §4.4）
      partitionKey: { name: 'itemId', type: AttributeType.STRING },
      sortKey: { name: 'warehouseId', type: AttributeType.STRING },
      billing: Billing.onDemand(),
      // Streams / TTL なし。在庫は投入したまま検証中ずっと参照する
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.idempotencyTable = new TableV2(this, 'IdempotencyTable', {
      tableName: name('order-idempotency'),
      // Powertools Idempotency の既定スキーマ。属性名を変えると
      // `DynamoDBPersistenceLayer` 側にも同じ設定が必要になるため既定のまま使う
      partitionKey: { name: 'id', type: AttributeType.STRING },
      billing: Billing.onDemand(),
      // 冪等キーの自動失効（要件 16.6）。属性名は Powertools の既定
      timeToLiveAttribute: 'expiration',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.executionsTable = new TableV2(this, 'ExecutionsTable', {
      tableName: name('order-executions'),
      // 負荷生成と並行計測で共用し `execution_type` で判別する（design §4.3）
      partitionKey: { name: 'execution_id', type: AttributeType.STRING },
      billing: Billing.onDemand(),
      timeToLiveAttribute: 'expires_at',
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }

  /**
   * 注文テーブルの Streams ARN。
   * イベントソースマッピング（`order-stream.ts`）と `DescribeStream` の権限付与
   * および `ORDERS_STREAM_ARN` の環境変数（`order-functions.ts`）で使う。
   *
   * @throws {Error} Streams が無効な場合（この Construct では起こらないが、
   *   props の変更で静かに壊れるのを防ぐ）
   */
  get ordersStreamArn(): string {
    const arn = this.ordersTable.tableStreamArn;
    if (!arn) {
      throw new Error(
        '注文テーブルの Streams が無効です（design §4.1 は NEW_AND_OLD_IMAGES を要求します）'
      );
    }
    return arn;
  }

  /**
   * Lambda に渡すテーブル関連の環境変数（タスク 10 / 20 で `environment` に展開する）。
   * 名前は合成時に決まるトークンであり、文字列として比較してはいけない。
   */
  get tableEnvironment(): Record<string, string> {
    return {
      [ORDER_TABLE_ENV_KEYS.ordersTableName]: this.ordersTable.tableName,
      [ORDER_TABLE_ENV_KEYS.inventoryTableName]: this.inventoryTable.tableName,
      [ORDER_TABLE_ENV_KEYS.idempotencyTableName]: this.idempotencyTable.tableName,
      [ORDER_TABLE_ENV_KEYS.executionsTableName]: this.executionsTable.tableName,
      [ORDER_TABLE_ENV_KEYS.ordersCustomerIndexName]: this.ordersCustomerIndexName,
    };
  }
}

/**
 * 検証パラメータの warm throughput を `TableV2` の props へ変換する。
 * 片方だけ設定されている場合は設定された側だけを渡す（未設定側を暗黙に埋めない）。
 *
 * @returns 両方未設定なら `undefined`（warm throughput を構成しない）
 */
export function toWarmThroughput(
  config: Pick<
    VerificationConfig,
    'warmThroughputReadUnitsPerSecond' | 'warmThroughputWriteUnitsPerSecond'
  >
): WarmThroughput | undefined {
  const { warmThroughputReadUnitsPerSecond, warmThroughputWriteUnitsPerSecond } = config;
  if (
    warmThroughputReadUnitsPerSecond === undefined &&
    warmThroughputWriteUnitsPerSecond === undefined
  ) {
    return undefined;
  }
  return {
    ...(warmThroughputReadUnitsPerSecond !== undefined
      ? { readUnitsPerSecond: warmThroughputReadUnitsPerSecond }
      : {}),
    ...(warmThroughputWriteUnitsPerSecond !== undefined
      ? { writeUnitsPerSecond: warmThroughputWriteUnitsPerSecond }
      : {}),
  };
}

/**
 * 物理テーブル名の既定サフィックス。
 *
 * `Names.uniqueResourceName` は「最上位スタック名 + 構築パス + 8 文字のハッシュ」を返す。
 * ここではハッシュ部分だけを使う。スタック名がハッシュの入力に含まれるため、
 * サンドボックスやブランチが違えば別の値になり、名前が衝突しない。
 * 同じスタックを再デプロイする限り値は変わらない（テーブルの作り直しは起きない）。
 */
function defaultTableNameSuffix(scope: Construct): string {
  // maxLength は「4 文字の可読部分 + 8 文字のハッシュ」に収まる最小値
  return Names.uniqueResourceName(scope, { maxLength: 12 }).slice(-8).toLowerCase();
}
