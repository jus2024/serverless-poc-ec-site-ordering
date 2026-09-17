import { Duration, Names, RemovalPolicy } from 'aws-cdk-lib';
import {
  FilterCriteria,
  FilterRule,
  StartingPosition,
  type IFunction,
} from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import type { OrderTables } from './order-tables.js';
import { getVerificationConfig, type VerificationConfig } from './verification-config.js';

/**
 * Streams イベントソースマッピングと DLQ（design §5.6 / 論点 4、
 * 要件 9.1 / 9.3 / 9.7 / 9.8 / 9.9 / 16.2）。
 *
 * ## この Construct が本 PoC の観測装置である
 *
 * 消費能力 `S × P ÷ D` の P（並列化係数）はここで決まる（design §2.1）。
 * S はテーブル側（オープンシャード数）、D は `order-processor` の実行時間なので、
 * **検証者が直接動かせる変数はこの Construct の `parallelizationFactor` だけ**である。
 * だから ESM を `order-functions.ts` に埋め込まず独立させている。
 * 「どの条件で計測したか」を追うとき、見る場所が 1 つで済む。
 *
 * ## イベントフィルタが無いと構成が自壊する（要件 9.7 / Property 8）
 *
 * `order-processor` は注文レコードを段階ごとに 1 回、合計 4 回更新する
 * （design §5.4）。フィルタを付けないとその 4 回が `MODIFY` として
 * ストリームに乗り、processor が**自分の更新で再起動される**。
 * 1 周ごとにイベントが 4 倍になるため、指数的に増幅して
 * シャードを埋め、同時実行枠を食い、課金だけが伸びる。
 *
 * 悪いことに、この故障は「壁を測る」という本来の観測と見分けが付きにくい。
 * `IteratorAge` は伸び、`Invocations` は増え、処理は遅れる。
 * つまり**測定結果が静かに嘘になる**。
 * したがってフィルタは設定項目ではなく構造として固定し、
 * `order-stream.test.ts` で合成結果を直接検査している。
 * ハンドラ側にも二次防御がある（`stream-record.ts` の `isProcessedEvent`）が、
 * あちらは呼ばれてしまった後の話であり、増幅そのものは防げない。
 *
 * ## DLQ に届くのはメタデータだけである（design 論点 4）
 *
 * DynamoDB Streams の `OnFailure` 送信先に入るのは**レコード本体ではなく
 * メタデータ**（ストリーム ARN、シャード ID、シーケンス番号の範囲、エラー情報）である。
 * ここから注文を再処理するには注文テーブルを読み直す必要がある。
 * そのため段階の失敗は注文レコード側にも残す設計になっている
 * （`{stage}_status` と `failure_reason`。design §E-2）。
 * **DLQ は「破棄された事実」の検知に使い、再処理の入力には使わない。**
 *
 * さらに重要な制約として、**保持期限（24 時間）によるデータロスは DLQ に入らない**。
 * トリムは ESM の失敗ではないため `OnFailure` が発火しない。
 * 検知は `IteratorAge` の監視だけに依存する（design §2.3 の段階 3）。
 * DLQ が空であることは「レコードを失っていない」ことを意味しない。
 */

/**
 * ESM のイベントフィルタ（要件 9.7）。
 *
 * `eventName = INSERT` のみを届ける。テストがこの定数と合成結果の
 * 両方を突き合わせるため、フィルタの出典はここ 1 箇所にする。
 */
export const ORDER_STREAM_INSERT_FILTER = FilterCriteria.filter({
  eventName: FilterRule.isEqual('INSERT'),
});

/**
 * 再試行回数の上限（design 論点 4）。
 *
 * 既定の -1（無限）だと、恒久的に失敗する 1 レコードが最大 24 時間
 * シャードを塞ぐ。DynamoDB Streams は順序を保証するため、
 * 塞がれたシャードの後続レコードも進めない。
 * 有限にして「詰まりを打ち切る」のがこの値の役割である。
 */
export const ORDER_STREAM_RETRY_ATTEMPTS = 3;

/**
 * DLQ のメッセージ保持期間。
 *
 * SQS の最大値。DLQ に落ちるのは検証者が後から読む診断情報であり、
 * 週末を挟んで気づいた場合でも残っていてほしい。
 * 到達件数はごく少ない想定なので、長くしても費用に影響しない。
 */
export const ORDER_STREAM_DLQ_RETENTION = Duration.days(14);

export interface OrderStreamProps {
  /** テーブル 4 本。注文テーブルの Streams をイベントソースにする */
  readonly tables: OrderTables;

  /** Streams コンシューマ（`OrderFunctions.orderProcessor`） */
  readonly processor: IFunction;

  /**
   * 解決済みの検証パラメータ。
   *
   * @default `getVerificationConfig()`（環境変数から解決）
   */
  readonly config?: VerificationConfig;

  /**
   * DLQ の物理名の接頭辞。
   *
   * @default 'kiro-roasters'（`order-tables.ts` と揃える）
   */
  readonly queueNamePrefix?: string;

  /**
   * DLQ の物理名の末尾に付ける一意サフィックス。
   * `order-tables.ts` / `order-functions.ts` と同じ理由で既定で付ける
   * （SQS のキュー名はリージョン内で一意である必要があり、
   * 固定名では sandbox やブランチごとのスタックが 2 つ目で衝突する）。
   *
   * @default 構築パスとスタック名から算出した 8 文字
   */
  readonly queueNameSuffix?: string;
}

/** Streams ESM と DLQ を定義する Construct */
export class OrderStream extends Construct {
  /** 破棄されたレコードのメタデータが入る DLQ（要件 9.9 / 16.2） */
  readonly deadLetterQueue: Queue;

  /** 合成した ESM の ID。ダッシュボードやトラブルシュートで使う */
  readonly eventSourceMappingId: string;

  /** 実際に適用した ESM の設定。`GET /config` や検証記録の突き合わせ用 */
  readonly settings: OrderStreamSettings;

  constructor(scope: Construct, id: string, props: OrderStreamProps) {
    super(scope, id);

    const config = props.config ?? getVerificationConfig();
    const prefix = props.queueNamePrefix ?? 'kiro-roasters';
    const suffix = props.queueNameSuffix ?? defaultNameSuffix(this);

    this.deadLetterQueue = new Queue(this, 'DeadLetterQueue', {
      queueName: [prefix, 'order-stream-dlq', suffix].filter((part) => part !== '').join('-'),
      retentionPeriod: ORDER_STREAM_DLQ_RETENTION,
      // SQS 管理のキーで暗号化する。KMS のカスタマー管理キーにすると
      // 鍵の月額とデプロイの前提が増えるだけで、検証には何も足さない
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      // 要件 17.5。検証終了後にスタックごと消せる状態を保つ
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.settings = resolveStreamSettings(config);

    const eventSource = new DynamoEventSource(props.tables.ordersTable, {
      // 過去の注文を再処理しない（design §5.6）。
      // TRIM_HORIZON にすると、再デプロイのたびに滞留していた
      // 古いレコードを処理し直し、シナリオの投入件数と処理件数が合わなくなる
      startingPosition: StartingPosition.LATEST,
      batchSize: this.settings.batchSize,
      parallelizationFactor: this.settings.parallelizationFactor,
      // 要件 9.7 / Property 8。この 1 行が無いと無限ループになる
      filters: [ORDER_STREAM_INSERT_FILTER],
      // 要件 9.8。ハンドラが返す batchItemFailures を Lambda に解釈させる。
      // false のままだと、1 件の失敗でバッチ全体が再試行される
      reportBatchItemFailures: true,
      retryAttempts: ORDER_STREAM_RETRY_ATTEMPTS,
      // 不良レコードを二分探索で隔離し、同一バッチの正常レコードを救う（design 論点 4）。
      // 既定の BatchSize = 1 では効かないが、BatchSize を上げる検証で効く
      bisectBatchOnError: true,
      // `maxRecordAge` は既定 -1（無期限）。下の注記を参照
      ...(this.settings.maxRecordAge === undefined
        ? {}
        : { maxRecordAge: this.settings.maxRecordAge }),
      onFailure: new SqsDlq(this.deadLetterQueue),
    });

    // `addEventSource` の中で `grantStreamRead` が呼ばれ、
    // processor のロールに Streams の読み取り権限が付く（design §5.9）
    props.processor.addEventSource(eventSource);

    this.eventSourceMappingId = eventSource.eventSourceMappingId;
  }
}

/** 実際に適用した ESM の設定（`resolveStreamSettings` の結果） */
export interface OrderStreamSettings {
  /** 1 呼び出しに渡すレコード数（design §5.6） */
  readonly batchSize: number;
  /** シャードあたりの並行バッチ数。消費能力の変数 P */
  readonly parallelizationFactor: number;
  /**
   * レコードの最大滞留時間。`undefined` は「無期限（-1）」を意味する。
   * CDK の props は `Duration` 型で -1 を表現できないため、
   * 無期限は**プロパティを渡さない**ことで表す（下の注記）。
   */
  readonly maxRecordAge?: Duration;
  /** 記録用。`maxRecordAge` の元の秒数（-1 を含む） */
  readonly maxRecordAgeSeconds: number;
}

/**
 * 検証パラメータを ESM の設定へ変換する（design §5.6 / §10.1）。
 *
 * ## `maxRecordAge = -1`（無期限）の扱い
 *
 * design 論点 4 の既定は -1（無期限）である。**有限にすると
 * 「古いレコードを捨てて追いつく」挙動になり、滞留の自然な成長を
 * 打ち切ってしまう。** 本 PoC は滞留が保持期限（24 時間）に達して
 * データロスに至る過程そのものを観測する（要件 20.3）ため、
 * 打ち切られると測りたい現象が消える。
 *
 * ところが CDK の `maxRecordAge` は `Duration` 型で、
 * `Duration.seconds(-1)` は `EventSourceMapping` の検証
 * （60 秒〜7 日）に弾かれる。-1 を値として渡す手段が無い。
 *
 * 一方 CloudFormation の `MaximumRecordAgeInSeconds` は
 * **省略時の既定が -1（無期限）** であり、CDK は
 * `props.maxRecordAge?.toSeconds()` をそのまま流すだけなので、
 * props を渡さなければ CFN 側もプロパティ未設定になる。
 * つまり「-1 を指定する」と「指定しない」は同じ結果になる。
 * よって -1 は**プロパティを省略して**表す。
 *
 * `verification-config.ts` が -1 を特例値として受け付けているのは
 * この経路のためであり、60 未満の有限値は合成時に弾かれる（design §10.3）。
 *
 * ## `batchSize` の上限について
 *
 * design §10.1 の範囲は 1〜10,000 で、CDK の `DynamoEventSource` も
 * 10,000 まで通す。しかし **DynamoDB Streams の実際の上限は 1,000** であり、
 * 1,000 を超える値は合成を通ってデプロイ時に失敗する。
 * ここで追加の検証を入れていないのは、範囲の出典を
 * `verification-config.ts`（design §10.1 の表）に一本化しているためである。
 * `BatchSize` は消費能力の式に現れない変数なので（design §2.1）、
 * 検証で 1,000 を超える値を使う場面はない。
 */
export function resolveStreamSettings(
  config: Pick<
    VerificationConfig,
    'streamBatchSize' | 'streamParallelizationFactor' | 'streamMaxRecordAgeSeconds'
  >
): OrderStreamSettings {
  const maxRecordAgeSeconds = config.streamMaxRecordAgeSeconds;

  return {
    batchSize: config.streamBatchSize,
    parallelizationFactor: config.streamParallelizationFactor,
    maxRecordAge:
      maxRecordAgeSeconds < 0 ? undefined : Duration.seconds(maxRecordAgeSeconds),
    maxRecordAgeSeconds,
  };
}

/**
 * DLQ の物理名の既定サフィックス。
 * `order-tables.ts` の `defaultTableNameSuffix` と同じ考え方
 * （スタック名を含むハッシュの下 8 桁。再デプロイでは変わらない）。
 */
function defaultNameSuffix(scope: Construct): string {
  return Names.uniqueResourceName(scope, { maxLength: 12 }).slice(-8).toLowerCase();
}
