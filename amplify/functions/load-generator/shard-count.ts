/**
 * オープンシャード数と warm throughput の観測（要件 19.1 / 19.2 / 19.5 / 19.6、design §5.7）。
 *
 * ## なぜ実行時に測るのか
 *
 * 本 Spec の中心的な問いに対する答えは消費能力 `S × P ÷ D` に依存する（design §2.1）。
 * その S（オープンシャード数）は **CloudWatch メトリクスとして提供されない**
 * （要件 19 の但し書き）。取得手段は `DescribeStream` だけであり、
 * S が記録されていない実行結果は後から解釈できない。
 *
 * 手動のコマンド実行を挟まずに記録することが要件になっている（要件 19.6）ため、
 * `load-generator` が実行開始時にここを通り、結果を実行レコードへ刻む。
 * 実行レコードの属性との対応は `ShardObservation` の各フィールドを参照。
 *
 * ## オープンシャードの定義（要件 19.2）
 *
 * ```
 * オープンシャード = Shards のうち SequenceNumberRange.EndingSequenceNumber が未設定のもの
 * ```
 *
 * DynamoDB Streams のシャードは分割・統合で世代交代する。終端シーケンス番号を持つ
 * シャードは**もう新しいレコードを受け取らない**ため、`S × P` の同時実行数には寄与しない。
 * 全シャードを数えると、テーブルが長く生きているほど S を過大に見積もることになる。
 *
 * ## 取得失敗で検証を止めない（要件 19.5、design §E-8）
 *
 * S が取れないことは残念だが、負荷生成そのものは成立する。
 * `observeShardCount` は例外を投げず、失敗の理由を `shardCountError` に載せて返す。
 * 呼び出し側はそれを `shard_count_error` に記録し、投入を続ける。
 * **その実行結果は §2.4 の算術（消費能力の検証）に使わない**という区別が、
 * `open_shard_count` の有無ではなく `shard_count_error` の有無で表現される。
 *
 * 必要な IAM 権限は `dynamodb:DescribeStream`（ストリーム ARN）と
 * `dynamodb:DescribeTable`（注文テーブル）の 2 つ（design §5.9）。
 * 配線は `amplify/custom/order-functions.ts` の `grantShardObservation`。
 */

import { DescribeTableCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DescribeStreamCommand,
  DynamoDBStreamsClient,
  type Shard,
} from '@aws-sdk/client-dynamodb-streams';
import { getDynamoDBClient } from '../shared/ddb.js';

/**
 * 注文テーブルのストリーム ARN を渡す環境変数。
 *
 * `shared/runtime-config.ts` のテーブル名（`RUNTIME_TABLE_ENV_KEYS`）に含めていないのは、
 * ストリーム ARN を必要とするのが `load-generator` だけだからである
 * （`DescribeStream` 権限を持つのもこの関数だけ。design §5.9）。
 * 全 Lambda に配る環境変数へ混ぜると、権限を持たない関数が
 * 「値はあるが呼べない」状態になり、配線の意図が読み取りにくくなる。
 *
 * 値の出典は `OrderTables.ordersStreamArn`（`amplify/custom/order-tables.ts`）。
 * `load-generator` と `query-impact-measure` の `environment` に設定してある
 * （`order-functions.ts` の `ORDER_MEASUREMENT_ENV_KEYS`）。
 */
export const ORDERS_STREAM_ARN_ENV = 'ORDERS_STREAM_ARN';

/**
 * `DescribeStream` を追うページ数の上限。
 *
 * 1 ページは最大 100 シャードなので、上限に達するのは 10,000 シャードを
 * 超えるストリームである。軸 B（warm throughput でシャードを増やす構成）でも
 * この桁には届かない見込みで、ここに達したら**ページネーションが進んでいない**
 * と判断する方が妥当である。無限ループでタイムアウト（15 分）を使い切らせない。
 */
export const MAX_DESCRIBE_STREAM_PAGES = 100;

/**
 * `shard_count_error` に載せる文字列の長さ上限。
 *
 * 実行レコードは検証者が読むためのものであり、SDK のスタックトレースを
 * 丸ごと持ち込む価値はない。原因の判別に足りる先頭だけを残す。
 */
export const MAX_SHARD_COUNT_ERROR_LENGTH = 512;

/**
 * シャード数観測の結果。実行レコード（design §4.3）の属性と 1 対 1 で対応する。
 *
 * | フィールド | 実行レコードの属性 |
 * |-----------|------------------|
 * | `openShardCount` | `open_shard_count`（要件 19.1） |
 * | `shardCountError` | `shard_count_error`（要件 19.5） |
 * | `warmThroughputWrite` | `warm_throughput_write` |
 *
 * `openShardCount` と `shardCountError` は**排他**である。成功なら前者だけ、
 * 失敗なら後者だけが入る。両方 `undefined` になることはない。
 */
export interface ShardObservation {
  /** S: オープンシャード数。取得に失敗した場合は未設定 */
  openShardCount?: number;
  /** 取得に失敗した理由。成功した場合は未設定 */
  shardCountError?: string;
  /**
   * 注文テーブルの warm throughput（書き込み）の現在値。
   *
   * 未設定のテーブルでは `DescribeTable` が値を返さないため `undefined` になる。
   * warm throughput の取得失敗は `shardCountError` にしない（下記の注記を参照）。
   */
  warmThroughputWrite?: number;
  /**
   * `DescribeStream` を呼んだ回数（ログ用。取得に失敗した場合は 0）。
   *
   * 軸 B では 2 以上になる。1 のまま S が 100 の場合は
   * ページネーションが効いていない疑いがある（100 は 1 ページの上限）。
   */
  pageCount: number;
}

/** `DescribeStream` の結果 */
export interface OpenShardCountResult {
  openShardCount: number;
  pageCount: number;
}

export interface DescribeOpenShardCountInput {
  /** 注文テーブルのストリーム ARN（`latestStreamArn`） */
  streamArn: string;
  /** Streams クライアント。既定はモジュールスコープの共有インスタンス */
  streamsClient?: DynamoDBStreamsClient;
  /** ページ数の上限。既定は `MAX_DESCRIBE_STREAM_PAGES` */
  maxPages?: number;
}

export interface DescribeWarmThroughputWriteInput {
  /** 注文テーブルの物理名 */
  tableName: string;
  /** DynamoDB クライアント。既定は `shared/ddb.ts` の共有インスタンス */
  dynamoClient?: DynamoDBClient;
}

export interface ObserveShardCountInput
  extends DescribeOpenShardCountInput,
    DescribeWarmThroughputWriteInput {
  /**
   * 失敗を記録する経路（ログ出力用）。例外は投げ直さない。
   *
   * 呼び出し側の Logger を渡すためのフックで、既定では何もしない。
   * 失敗の事実そのものは戻り値の `shardCountError` に載るため、
   * ログを取らなくても実行レコードから追跡できる。
   */
  onError?: (context: 'DescribeStream' | 'DescribeTable', error: unknown) => void;
}

/**
 * シャードがオープンかを判定する（要件 19.2）。
 *
 * 終端シーケンス番号が未設定ならオープン。空文字も未設定として扱う
 * （SDK が空文字を返す経路は無いが、`''` を「終端済み」と読むと
 * S を過小に見積もる方向の誤りになるため、安全側に倒す）。
 */
export function isOpenShard(shard: Shard): boolean {
  const ending = shard.SequenceNumberRange?.EndingSequenceNumber;
  return ending === undefined || ending === null || ending.trim() === '';
}

/** オープンシャードを数える（要件 19.2）。`undefined` は 0 件として扱う */
export function countOpenShards(shards: readonly Shard[] | undefined): number {
  return (shards ?? []).filter(isOpenShard).length;
}

/**
 * `DescribeStream` を全ページ辿ってオープンシャード数を数える（design §5.7）。
 *
 * ## ページネーションを省略できない理由
 *
 * `DescribeStream` は 1 回で最大 100 シャードしか返さない。
 * `LastEvaluatedShardId` を無視すると、シャードが 100 を超える構成
 * （軸 B が狙っているまさにその状態）で S を 100 で頭打ちにしてしまう。
 * 「シャードを増やしても壁が動かない」という**誤った結論**に直結するため、
 * ここは全件取得でなければ意味がない。
 *
 * ## 同じカーソルが返ったら打ち切る
 *
 * `LastEvaluatedShardId` が前回渡した値と同じなら、次も同じ応答が返る。
 * ページ数の上限（15 分のタイムアウトを守るための保険）だけに頼らず、
 * 進んでいないことを検知した時点で例外にする。
 *
 * @throws {Error} SDK が失敗した場合、`StreamDescription` が欠けている場合、
 *   ページ数の上限に達した場合、ページネーションが進まない場合
 */
export async function describeOpenShardCount(
  input: DescribeOpenShardCountInput
): Promise<OpenShardCountResult> {
  const client = input.streamsClient ?? getStreamsClient();
  const maxPages = input.maxPages ?? MAX_DESCRIBE_STREAM_PAGES;

  let openShardCount = 0;
  let pageCount = 0;
  let exclusiveStartShardId: string | undefined;

  for (;;) {
    const output = await client.send(
      new DescribeStreamCommand({
        StreamArn: input.streamArn,
        ExclusiveStartShardId: exclusiveStartShardId,
      })
    );
    pageCount += 1;

    const description = output.StreamDescription;
    if (description === undefined) {
      throw new Error(
        `DescribeStream が StreamDescription を返しませんでした（${pageCount} ページ目）`
      );
    }

    openShardCount += countOpenShards(description.Shards);

    const nextShardId = description.LastEvaluatedShardId;
    if (nextShardId === undefined || nextShardId === '') {
      return { openShardCount, pageCount };
    }
    if (nextShardId === exclusiveStartShardId) {
      throw new Error(
        `DescribeStream のページネーションが進みません（LastEvaluatedShardId=${nextShardId}）`
      );
    }
    if (pageCount >= maxPages) {
      throw new Error(
        `DescribeStream のページ数が上限（${maxPages}）に達しました（取得済み ${openShardCount} シャード）`
      );
    }
    exclusiveStartShardId = nextShardId;
  }
}

/**
 * `DescribeTable` から warm throughput（書き込み）の現在値を読む（design §5.7）。
 *
 * warm throughput は**テーブル側の設定**であり Lambda の環境変数に無い。
 * 軸 B の実行を後から見分けるために、実行レコードへ実際の値を刻む
 * （`.env` に書いた値ではなくデプロイ済みの値を出典にする。design §5.8 と同じ方針）。
 *
 * @returns 設定されていなければ `undefined`（既定のまま）
 * @throws {Error} SDK が失敗した場合
 */
export async function describeWarmThroughputWrite(
  input: DescribeWarmThroughputWriteInput
): Promise<number | undefined> {
  const client = input.dynamoClient ?? getDynamoDBClient();
  const output = await client.send(
    new DescribeTableCommand({ TableName: input.tableName })
  );
  return output.Table?.WarmThroughput?.WriteUnitsPerSecond;
}

/**
 * 観測をまとめて行う。**例外を投げない**（要件 19.5、design §E-8）。
 *
 * 負荷生成を止めないことがこの関数の存在理由である。呼び出し側は戻り値を
 * そのまま実行レコードへ書き、投入を続ける。
 *
 * ## warm throughput の取得失敗を `shardCountError` にしない
 *
 * `shard_count_error` は「この実行を消費能力の検証に使えるか」を判定する印である
 * （design §E-8 / Property 10・11）。warm throughput は S の算出に関与しない
 * 追跡用の情報なので、これが取れなかったことで実行結果を無効扱いにするのは行き過ぎになる。
 * 失敗は `onError` に流し、`warmThroughputWrite` を未設定にするだけに留める。
 */
export async function observeShardCount(
  input: ObserveShardCountInput
): Promise<ShardObservation> {
  const [shards, warmThroughputWrite] = await Promise.all([
    describeOpenShardCount(input).then(
      (result) => ({ ok: true, result }) as const,
      (error: unknown) => {
        input.onError?.('DescribeStream', error);
        return { ok: false, error } as const;
      }
    ),
    describeWarmThroughputWrite(input).catch((error: unknown) => {
      input.onError?.('DescribeTable', error);
      return undefined;
    }),
  ]);

  if (shards.ok) {
    return {
      openShardCount: shards.result.openShardCount,
      pageCount: shards.result.pageCount,
      warmThroughputWrite,
    };
  }

  return {
    shardCountError: toShardCountErrorReason(shards.error),
    pageCount: 0,
    warmThroughputWrite,
  };
}

/**
 * 失敗の理由を `shard_count_error` に載せる 1 行へ整形する。
 *
 * 例外の名前を残すのは、`AccessDeniedException`（権限の配線漏れ）と
 * `ResourceNotFoundException`（ストリーム ARN の取り違え）を検証者が
 * 実行レコードだけで見分けられるようにするためである。
 */
export function toShardCountErrorReason(error: unknown): string {
  const reason =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : `UnknownError: ${String(error)}`;
  const collapsed = reason.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_SHARD_COUNT_ERROR_LENGTH
    ? `${collapsed.slice(0, MAX_SHARD_COUNT_ERROR_LENGTH - 1)}…`
    : collapsed;
}

/**
 * 環境変数からストリーム ARN を読む。
 *
 * 未設定なら例外にする（`requireTableName` と同じ方針）。空文字のまま
 * `DescribeStream` を呼ぶと `ValidationException` になり、
 * 「配線漏れ」という本当の原因が `shard_count_error` から読み取れなくなる。
 *
 * @throws {Error} 環境変数が未設定または空文字の場合
 */
export function requireOrdersStreamArn(
  env: Record<string, string | undefined> = process.env
): string {
  const arn = env[ORDERS_STREAM_ARN_ENV]?.trim();
  if (!arn) {
    throw new Error(
      `${ORDERS_STREAM_ARN_ENV} が未設定です（Lambda の environment に設定してください。design §5.7）`
    );
  }
  return arn;
}

let streamsClient: DynamoDBStreamsClient | undefined;

/**
 * Streams クライアント（モジュールスコープで再利用。`shared/ddb.ts` と同じ方針）。
 *
 * `shared/` に置かずここに置いているのは、Streams の SDK を
 * `load-generator` 以外のバンドルへ引き込まないためである
 * （`DescribeStream` を持つのはこの関数だけ。design §5.9）。
 */
export function getStreamsClient(): DynamoDBStreamsClient {
  streamsClient ??= new DynamoDBStreamsClient({});
  return streamsClient;
}

/** テスト用。生成済みのクライアントを破棄する */
export function resetStreamsClient(): void {
  streamsClient = undefined;
}
