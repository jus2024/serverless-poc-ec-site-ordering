/**
 * Powertools 冪等性の共通設定（design 論点 7 / §E-5、要件 16.1 / 16.4 / 16.5 / 16.6）。
 *
 * ## 冪等キーは段階ごとに独立させる
 *
 * 4 段階を包む単一の冪等キーにすると、通知で失敗して再試行されたときに
 * 決済からやり直しになり、外部決済 API の二重呼び出しを招く（design 論点 7）。
 * そのため段階関数ごとに `makeIdempotent` を適用し、キーを `{stage}#{order_id}` にする。
 *
 * ## 実際に保存されるキーの形（Powertools の仕様との差）
 *
 * Powertools は常に `{接頭辞}#{ペイロードのハッシュ}` をキーにする。
 * 接頭辞に段階名（`keyPrefix`）、ハッシュ対象に `orderId` だけ（`eventKeyJmesPath`）を
 * 指定することで、**論理的には** design 論点 7 の `{stage}#{order_id}` と等価になる。
 * 実際にテーブルの `id` 属性へ入るのは `payment#<orderId の md5>` のような値である。
 * 注文 ID から直接キーを引きたい場合は `stageIdempotencyKeyLabel()` ではなく
 * この差を踏まえてハッシュを計算する必要がある。ログには論理キーを出す前提でいる。
 *
 * `eventKeyJmesPath` でハッシュ対象を絞るのは、段階関数の引数に
 * 注文レコード全体（`updated_at` を含む）を渡しても冪等キーが変わらないようにするため。
 * 引数全体をハッシュすると、同じ注文の再実行なのに「別の入力」と見なされてしまう。
 *
 * ## 永続化層を段階ごとに分ける理由
 *
 * `BasePersistenceLayer` は初回利用時の `configure()` で `keyPrefix` を確定させ、
 * 以降の設定変更を無視する（ライブラリ側が警告を出す）。
 * 1 インスタンスを共有すると最初に使われた段階の接頭辞が全段階に付いてしまい、
 * 段階ごとの独立が壊れる。段階ごとにインスタンスを持つ。
 */

import { IdempotencyConfig, makeIdempotent } from '@aws-lambda-powertools/idempotency';
import { DynamoDBPersistenceLayer } from '@aws-lambda-powertools/idempotency/dynamodb';
import {
  IdempotencyAlreadyInProgressError,
  IdempotencyInconsistentStateError,
  IdempotencyPersistenceLayerError,
} from '@aws-lambda-powertools/idempotency';
import type { Context } from 'aws-lambda';
import { getDynamoDBClient } from './ddb.js';
import { requireTableName } from './runtime-config.js';
import type { OrderStage } from './types.js';

/**
 * 冪等レコードの有効期間（秒）。
 *
 * 1 時間にしているのは、ESM の再試行（`retryAttempts = 3`、design §5.6）が
 * 数分内に収まるためである。滞留が伸びて 12 時間後に処理される注文があっても、
 * それは「初回実行が遅れた」だけでレコードの有効期間とは無関係。
 *
 * 有効期限が切れた後の再実行に対しては、注文テーブル側の
 * `attribute_not_exists({stage}_status)` 条件が二重加算を防ぐ（design §5.4）。
 * 冪等性の一次防御がここ、二次防御が条件付き更新という二段構えである。
 */
export const IDEMPOTENCY_EXPIRY_SECONDS = 3600;

/** 冪等キーのハッシュ対象を指定する JMESPath。段階関数の引数からこの項目だけを見る */
export const IDEMPOTENCY_KEY_JMES_PATH = 'orderId';

/**
 * 冪等性の共通設定。
 *
 * - `eventKeyJmesPath`: 冪等キーを注文 ID だけで決める
 * - `throwOnNoIdempotencyKey`: 注文 ID が取れないまま処理を進めさせない。
 *   黙って「キー無し」で通すと全レコードが同一キーに衝突する
 * - `useLocalCache`: 無効。`BatchSize = 1` が既定（design §5.6）で
 *   1 回の呼び出しに 1 レコードしか来ないため、ローカルキャッシュは効かない
 */
const idempotencyConfig = new IdempotencyConfig({
  eventKeyJmesPath: IDEMPOTENCY_KEY_JMES_PATH,
  expiresAfterSeconds: IDEMPOTENCY_EXPIRY_SECONDS,
  throwOnNoIdempotencyKey: true,
  useLocalCache: false,
});

/**
 * Lambda のコンテキストを登録する。ハンドラの先頭で 1 回呼ぶ。
 *
 * 登録しないと Powertools が残り実行時間を把握できず、
 * `INPROGRESS` レコードの失効時刻を設定できない（毎回警告が出る）。
 * タイムアウトで落ちた処理の冪等レコードが `INPROGRESS` のまま残ると、
 * 再試行が `IdempotencyAlreadyInProgressError` を繰り返して進めなくなる。
 */
export function registerIdempotencyLambdaContext(context: Context): void {
  idempotencyConfig.registerLambdaContext(context);
}

/** 段階ごとの永続化層。`keyPrefix` を確定させるためインスタンスを分ける */
const persistenceLayers = new Map<OrderStage, DynamoDBPersistenceLayer>();

/**
 * 段階に対応する永続化層を返す（テーブルは冪等性管理テーブル）。
 *
 * 属性名は Powertools の既定（`id` / `status` / `expiration` / `data`）をそのまま使う。
 * `order-tables.ts` の冪等性テーブルが同じスキーマで作られているため、
 * ここで属性名を指定する必要はない（要件 16.6）。
 *
 * @throws {RuntimeConfigError} `ORDER_IDEMPOTENCY_TABLE_NAME` が未設定の場合
 */
export function getStagePersistenceLayer(stage: OrderStage): DynamoDBPersistenceLayer {
  const existing = persistenceLayers.get(stage);
  if (existing) return existing;

  const layer = new DynamoDBPersistenceLayer({
    tableName: requireTableName('idempotencyTableName'),
    // 低レベルクライアントを共有して接続を 1 本に保つ
    awsSdkV3Client: getDynamoDBClient(),
  });
  persistenceLayers.set(stage, layer);
  return layer;
}

/** 段階関数の引数に最低限必要な形。冪等キーはここから決まる */
export interface StageIdempotencyPayload {
  /** 注文 ID（`ORD#{ULID}`）。冪等キーのハッシュ対象 */
  orderId: string;
}

/**
 * 段階の処理を冪等にする（design 論点 7）。
 *
 * 戻り値は冪等レコードの `data` 属性に JSON として保存され、
 * 二重実行時はそれがそのまま返る。**JSON で往復できる値を返すこと**
 * （`Date` や `undefined` を含めると再実行時に別の形で戻ってくる）。
 *
 * @param stage 段階名。冪等キーの接頭辞になる
 * @param execute 段階の本体。第 1 引数に `orderId` を含むオブジェクトを取る
 */
export function makeStageIdempotent<TInput extends StageIdempotencyPayload, TResult>(
  stage: OrderStage,
  execute: (input: TInput) => Promise<TResult>
): (input: TInput) => Promise<TResult> {
  return makeIdempotent(execute, {
    persistenceStore: getStagePersistenceLayer(stage),
    config: idempotencyConfig,
    keyPrefix: stage,
  });
}

/**
 * 冪等キーの論理表現（design 論点 7 の `{stage}#{order_id}`）。
 *
 * ログと X-Ray のアノテーションに出すための文字列であり、
 * テーブルの `id` 属性の値とは一致しない（冒頭の注記を参照）。
 */
export function stageIdempotencyKeyLabel(stage: OrderStage, orderId: string): string {
  return `${stage}#${orderId}`;
}

/**
 * 再試行すべき冪等性エラーか判定する（design §E-5）。
 *
 * - `IdempotencyAlreadyInProgressError`: 同一キーの処理が進行中。
 *   次の再試行では `COMPLETED` を読んで冪等に返るため、再試行に回す
 * - `IdempotencyInconsistentStateError`: 取得と保存の間にレコードが変化した。
 *   一時的な競合なので再試行に回す
 * - `IdempotencyPersistenceLayerError`: 冪等性テーブルへの読み書き失敗
 *   （スロットルを含む）。技術的な失敗として再試行に回す（要件 16.7）
 *
 * これらは `batchItemFailures` に積む対象であり、業務的な失敗ではない。
 */
export function isRetryableIdempotencyError(error: unknown): boolean {
  return (
    error instanceof IdempotencyAlreadyInProgressError ||
    error instanceof IdempotencyInconsistentStateError ||
    error instanceof IdempotencyPersistenceLayerError
  );
}

/** テスト用。段階ごとの永続化層を破棄する */
export function resetIdempotencyPersistenceLayers(): void {
  persistenceLayers.clear();
}
