import { Duration, Names, RemovalPolicy } from 'aws-cdk-lib';
import {
  Alarm,
  ComparisonOperator,
  Metric,
  Stats,
  TreatMissingData,
  type IMetric,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { Topic } from 'aws-cdk-lib/aws-sns';
import type { IQueue } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import {
  ACCOUNT_CONCURRENCY_LIMIT,
  ACCOUNT_CONCURRENCY_WARNING_RATIO,
  ITERATOR_AGE_THRESHOLDS_MS,
  type OrderMonitoringFunctions,
} from './order-monitoring.js';
import type { OrderTables } from './order-tables.js';

/**
 * CloudWatch アラームと通知先の SNS トピック
 * （design §6.2、要件 13.2 / 13.3 / 13.6 / 13.8 / 20.3）。
 *
 * ## ダッシュボードと別の Construct にしている理由
 *
 * `order-monitoring.ts` の冒頭に書いたとおり、ダッシュボードは「読むための道具」、
 * アラームは「起こすための道具」で判断の性質が違う。閾値の調整でダッシュボードの
 * ファイルを触りたくないので分けてある（`order-monitoring.test.ts` は
 * `OrderMonitoring` がアラームと SNS トピックを 1 つも作らないことを検査している）。
 *
 * 一方で**閾値の値そのものは共有する**。`ITERATOR_AGE_THRESHOLDS_MS` と
 * `ACCOUNT_CONCURRENCY_*` は `order-monitoring.ts` から import している。
 * ダッシュボードの注釈線とアラームの閾値がずれると、
 * 「グラフでは線を越えているのにアラームが鳴らない」という状態になり、
 * どちらが正しいのか読む側に判断できない。
 *
 * ## `IteratorAge` > 12 時間の Critical アラームが本 Spec の主要な成果である
 *
 * design §2.3 の段階 3（監視していないと気づかないデータロス）を検知する
 * **唯一の手段**である。DLQ には入らない（保持期限超過によるトリムは ESM の
 * 失敗ではないため `OnFailure` が発火しない。design 論点 4）し、
 * 注文レコードにも痕跡は残らない（そもそも processor が呼ばれない）。
 * したがってこのアラームが鳴らなければ、データロスは誰にも観測されない。
 *
 * **「鳴らないまま静かに壊れる」経路を潰すのがこのファイルの主眼である。**
 * 具体的な選択とその理由は `iteratorAgeDataLossRisk()` のコメントに書いた。
 *
 * ## 残る死角（意図的に受け入れている）
 *
 * `IteratorAge` は ESM が Lambda を呼び出したときにしか発行されない。
 * つまり**コンシューマが一度も起動しないまま滞留する構成事故**
 * （ESM の無効化、フィルタの誤設定、同時実行枠の完全な枯渇）では、
 * 12 時間の閾値を越えたかどうかを判定するデータ自体が存在しない。
 * `treatMissingData` を `BREACHING` にすれば拾えるが、
 * 本 PoC は検証していない時間帯（＝ほとんどの時間）が無トラフィックであり、
 * 常時 ALARM になってアラーム自体が無視される。
 * それは「静かに鳴らない」より悪い。
 *
 * この死角は残す。代わりに、この経路で起きる事象のうち
 * スロットルによるもの（`Throttles` > 0）は下記の Critical アラームが拾い、
 * それ以外はダッシュボードの `Invocations` / `Errors`
 * （`order-monitoring.ts`）で検証者が目視する前提とする。
 *
 * ## サブスクリプションは作らない（design §6.2、セキュリティ方針）
 *
 * メールアドレスをリポジトリに含めないため、トピックだけを作って
 * `topicArn` を公開する。検証者が任意で購読する。
 * **購読しない限りアラームは誰にも届かない**ので、
 * 手順のドキュメント化（タスク 27）までがこの機能の完成である。
 */

/**
 * アラームの評価粒度。
 *
 * ダッシュボードと同じ 1 分にしている（`order-monitoring.ts` の `PERIOD`）。
 * 同じ値だが**独立した決定**なので定数を共有していない。
 * ダッシュボード側の 1 分は「`Invocations` の毎分値がそのまま処理レートになる」
 * という読み方（design 論点 10）のためで、こちらは検知の遅れを 1 分に抑えるためである。
 */
export const ORDER_ALARM_PERIOD = Duration.minutes(1);

/**
 * DLQ アラームだけ評価粒度を長く取る理由。
 *
 * SQS の `ApproximateNumberOfMessagesVisible` は発行間隔が保証されておらず、
 * 1 分粒度にすると「データのある分は ALARM、無い分は OK」で
 * 状態が往復し、そのたびに通知が飛ぶ。
 * DLQ のメッセージは 14 日残る（`ORDER_STREAM_DLQ_RETENTION`）ので、
 * 検知が数分遅れても失うものは無い。
 */
export const ORDER_DLQ_ALARM_PERIOD = Duration.minutes(5);

/**
 * `IteratorAge` アラームの評価窓（`datapointsToAlarm` / `evaluationPeriods`）。
 *
 * 「5 分のうち 1 点でも閾値を越えたら ALARM」。理由は
 * `iteratorAgeDataLossRisk()` のコメントを参照。
 */
export const ITERATOR_AGE_EVALUATION_PERIODS = 5;
export const ITERATOR_AGE_DATAPOINTS_TO_ALARM = 1;

/** アラーム名とトピック名の既定の接頭辞（他の Construct と揃える） */
export const ORDER_ALARM_NAME_PREFIX = 'kiro-roasters';

/** SNS トピックの論理名 */
export const ORDER_ALARM_TOPIC_LOGICAL_NAME = 'order-pipeline-alarms';

/**
 * 深刻度（design §6.2 の「深刻度」列）。
 *
 * 通知先のトピックは 1 つなので、**深刻度はアラーム名と説明文でしか伝わらない**。
 * 購読者が受け取るメールの件名にはアラーム名が入るため、
 * 名前の先頭に深刻度を入れて、開かずに切り分けられるようにする。
 */
export const ORDER_ALARM_SEVERITY = {
  warning: 'warning',
  critical: 'critical',
} as const;

export type OrderAlarmSeverity =
  (typeof ORDER_ALARM_SEVERITY)[keyof typeof ORDER_ALARM_SEVERITY];

/** アラーム 1 本のメタデータ（design §6.2 の 1 行に対応する） */
export interface OrderAlarmSpec {
  /** 物理名に使う論理名 */
  readonly logicalName: string;
  /** design §6.2 の「アラーム」列 */
  readonly designRow: string;
  /** design §6.2 の「深刻度」列 */
  readonly severity: OrderAlarmSeverity;
  /** design §6.2 の「対応要件」列 */
  readonly requirements: readonly string[];
  /** 鳴ったときに何を意味するか。説明文（通知に載る）に使う */
  readonly meaning: string;
}

/**
 * design §6.2 の表そのもの。
 *
 * `order-alarms.test.ts` がこの定数と合成結果の両方を突き合わせるため、
 * 表の行を消す変更は黙って通らない。
 *
 * DynamoDB の書き込みスロットルだけ**表の 1 行に対してアラームが 2 本**ある。
 * 基表と GSI は別のメトリクス（ディメンションが違う）で、
 * CloudWatch は両者を合算した系列を発行しない。基表だけを見るアラームにすると、
 * **GSI 側で詰まったときに鳴らない**。GSI は射影 ALL で基表と同量の書き込みを受け、
 * かつ warm throughput を設定していない（design §4.2）ため、
 * 基表より先に詰まる可能性がある方である。
 * メトリクス演算で足し合わせる手もあるが、CloudWatch の演算は
 * 片方の系列に値が無い時刻を落とすため、
 * 「スロットルが片側だけで起きた分が消える」という別の穴が開く。
 * 2 本に分けるのが素直である。
 */
export const ORDER_ALARM_SPECS = {
  accountConcurrency: {
    logicalName: 'account-concurrency',
    designRow: '同時実行が枠の 80%',
    severity: ORDER_ALARM_SEVERITY.warning,
    requirements: ['13.2'],
    meaning: `アカウント全体の同時実行数が既定枠 ${ACCOUNT_CONCURRENCY_LIMIT} の ${
      ACCOUNT_CONCURRENCY_WARNING_RATIO * 100
    }% に達した。枠が壁になる手前である（参照値なので実際の枠は要確認）`,
  },
  queryThrottles: {
    logicalName: 'query-throttles',
    designRow: '照会系のスロットル',
    severity: ORDER_ALARM_SEVERITY.critical,
    requirements: ['13.3', '13.5'],
    meaning:
      '同期パス（order-query）がスロットルされた。後続処理の負荷が同期パスへ波及した状態である（design §2.6）',
  },
  processorThrottles: {
    logicalName: 'processor-throttles',
    designRow: '後続処理系のスロットル',
    severity: ORDER_ALARM_SEVERITY.critical,
    requirements: ['13.3'],
    meaning:
      '後続処理（order-processor）がスロットルされた。消費能力が同時実行枠で抑えられている状態である',
  },
  iteratorAgeWarning: {
    logicalName: 'iterator-age-warning',
    designRow: 'Streams 滞留',
    severity: ORDER_ALARM_SEVERITY.warning,
    requirements: ['20.1'],
    meaning:
      '滞留が始まった。投入が消費能力（S × P ÷ D）を超えている（design §2.4）',
  },
  iteratorAgeDataLossRisk: {
    logicalName: 'iterator-age-data-loss-risk',
    designRow: 'Streams 滞留が危険域',
    severity: ORDER_ALARM_SEVERITY.critical,
    requirements: ['20.3'],
    meaning:
      '滞留が保持期限（24 時間）の半分に達した。このまま伸びるとレコードは失われ、DLQ にも痕跡が残らない（design §2.3 の段階 3）。投入を止めるか消費能力を上げること',
  },
  deadLetterQueue: {
    logicalName: 'dlq-messages',
    designRow: 'DLQ にメッセージ',
    severity: ORDER_ALARM_SEVERITY.warning,
    requirements: ['13.6'],
    meaning:
      '再試行を使い切ったレコードが破棄された。入っているのはメタデータのみで、再処理には注文テーブルの読み直しが必要（design 論点 4）',
  },
  ordersTableWriteThrottles: {
    logicalName: 'orders-write-throttles',
    designRow: 'DynamoDB 書き込みスロットル',
    severity: ORDER_ALARM_SEVERITY.warning,
    requirements: ['13.8'],
    meaning:
      '注文テーブル（基表）の書き込みがスロットルされた。軸 A では壁にならない見込みの要素である（要件 20.5）',
  },
  ordersIndexWriteThrottles: {
    logicalName: 'orders-index-write-throttles',
    designRow: 'DynamoDB 書き込みスロットル',
    severity: ORDER_ALARM_SEVERITY.warning,
    requirements: ['13.8'],
    meaning:
      '注文テーブルの GSI の書き込みがスロットルされた。GSI は射影 ALL かつ warm throughput 未設定のため、基表より先に詰まる側である（design §4.2）',
  },
} as const satisfies Record<string, OrderAlarmSpec>;

export type OrderAlarmKey = keyof typeof ORDER_ALARM_SPECS;

export interface OrderAlarmsProps {
  /**
   * 監視対象の Lambda 関数。
   *
   * `OrderMonitoringFunctions` を再利用しているので `OrderFunctions` が
   * そのまま適合する。アラームが実際に使うのは必須の 2 つ
   * （`orderQuery` / `orderProcessor`）だけである。
   * design §6.2 が名前を挙げているのがこの 2 つだけであり、
   * 要件 13.5 の「照会系と後続処理系を区別する」も同じ 2 つを指す。
   */
  readonly functions: OrderMonitoringFunctions;

  /** テーブル 4 本。注文テーブルと GSI の書き込みスロットルを見る（要件 13.8） */
  readonly tables: OrderTables;

  /** Streams ESM の DLQ（`OrderStream.deadLetterQueue`）。要件 13.6 */
  readonly deadLetterQueue: IQueue;

  /**
   * アラーム名とトピック名の接頭辞。
   *
   * @default 'kiro-roasters'
   */
  readonly alarmNamePrefix?: string;

  /**
   * アラーム名とトピック名の末尾に付ける一意サフィックス。
   *
   * CloudWatch のアラーム名と SNS のトピック名はどちらもアカウント内
   * （リージョン内）で一意である。固定名にすると、検証者ごとの sandbox や
   * ブランチごとのスタックが 2 つ目のデプロイで衝突する。
   * アラームの場合の衝突はダッシュボードより厄介で、
   * **後からデプロイした側が既存のアラームを黙って上書きする**
   * （CloudFormation の `PutMetricAlarm` は同名を更新扱いにする）。
   * 既定でサフィックスを付けるのはこのためである。
   * 空文字を渡すと接頭辞と論理名だけの固定名になる。
   *
   * @default 構築パスとスタック名から算出した 8 文字
   */
  readonly alarmNameSuffix?: string;
}

/** CloudWatch アラームと通知先の SNS トピックを定義する Construct */
export class OrderAlarms extends Construct {
  /**
   * 全アラーム共通の通知先。サブスクリプションは作らない（design §6.2）。
   */
  readonly topic: Topic;

  /**
   * トピックの ARN。`backend.ts` が `addOutput` の `custom.alarmTopicArn` で出力する。
   *
   * 購読しない限りアラームは誰にも届かないため、
   * 検証者がこの ARN を使って購読できる状態にしておくことが要件である。
   */
  readonly topicArn: string;

  /** 定義したアラーム。キーは `ORDER_ALARM_SPECS` と 1 対 1 */
  readonly alarms: Record<OrderAlarmKey, Alarm>;

  private readonly props: OrderAlarmsProps;
  private readonly alarmName: (logicalName: string) => string;

  constructor(scope: Construct, id: string, props: OrderAlarmsProps) {
    super(scope, id);

    this.props = props;

    const prefix = props.alarmNamePrefix ?? ORDER_ALARM_NAME_PREFIX;
    const suffix = props.alarmNameSuffix ?? defaultNameSuffix(this);
    const physicalName = (logicalName: string): string =>
      [prefix, logicalName, suffix].filter((part) => part !== '').join('-');

    this.alarmName = physicalName;

    this.topic = new Topic(this, 'AlarmTopic', {
      topicName: physicalName(ORDER_ALARM_TOPIC_LOGICAL_NAME),
      displayName: '注文処理パイプライン PoC のアラーム',
      // 平文 HTTP での発行を拒否する（トピックポリシーで aws:SecureTransport を要求）。
      // 保存時暗号化（`masterKey`）は付けていない。SNS の AWS 管理キー
      // （alias/aws/sns）はキーポリシーを編集できず、CloudWatch アラームに
      // `kms:GenerateDataKey*` を許可できないため**アラームの発行が失敗する**。
      // カスタマー管理キーを作れば解決するが、鍵の月額とデプロイの前提が増えるだけで
      // 検証には何も足さない（`order-stream.ts` の DLQ と同じ判断）。
      // 流れるのはアラームの状態遷移のみで、機密情報は含まれない
      enforceSSL: true,
    });

    // 要件 17.5。検証終了後にスタックごと消せる状態を保つ
    this.topic.applyRemovalPolicy(RemovalPolicy.DESTROY);
    this.topicArn = this.topic.topicArn;

    this.alarms = {
      accountConcurrency: this.accountConcurrency(),
      queryThrottles: this.queryThrottles(),
      processorThrottles: this.processorThrottles(),
      iteratorAgeWarning: this.iteratorAgeWarning(),
      iteratorAgeDataLossRisk: this.iteratorAgeDataLossRisk(),
      deadLetterQueue: this.deadLetterQueue(),
      ordersTableWriteThrottles: this.ordersTableWriteThrottles(),
      ordersIndexWriteThrottles: this.ordersIndexWriteThrottles(),
    };
  }

  /**
   * 同時実行が枠の 80%（design §6.2、要件 13.2）。
   *
   * ディメンションを付けない `AWS/Lambda ConcurrentExecutions` が
   * アカウント全体の値である。枠は申請で変わるため、これは参照値に対する
   * 目安であって「これを越えたらスロットルする」ではない
   * （実際のスロットルは `queryThrottles` / `processorThrottles` が拾う）。
   *
   * 統計は最大。平均だと 1 分の中の瞬間的な集中が消え、
   * 枠は瞬間値で効くのに検知できない。
   */
  private accountConcurrency(): Alarm {
    return this.alarm('accountConcurrency', {
      metric: new Metric({
        namespace: 'AWS/Lambda',
        metricName: 'ConcurrentExecutions',
        period: ORDER_ALARM_PERIOD,
        statistic: Stats.MAXIMUM,
      }),
      threshold: ACCOUNT_CONCURRENCY_LIMIT * ACCOUNT_CONCURRENCY_WARNING_RATIO,
      // design §6.2 は「>= 800」
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      // 無トラフィックの時間帯を ALARM にしない
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }

  /**
   * 照会系のスロットル（design §6.2、要件 13.3 / 13.5）。
   *
   * `order-query` のみ。ダッシュボードのウィジェットを 2 枚に分けているのと
   * 同じ理由で、アラームも 2 本に分ける。1 本にまとめると
   * 通知を見た時点で「同期パスに波及したのか、後続処理だけなのか」が
   * 分からず、波及の判定（design §2.6）ができない。
   */
  private queryThrottles(): Alarm {
    return this.throttleAlarm('queryThrottles', this.props.functions.orderQuery);
  }

  /** 後続処理系のスロットル（design §6.2、要件 13.3）。`order-processor` のみ */
  private processorThrottles(): Alarm {
    return this.throttleAlarm('processorThrottles', this.props.functions.orderProcessor);
  }

  /**
   * `Throttles` > 0 のアラーム。
   *
   * Lambda はスロットルが起きなかった分の 0 を発行しないため、
   * データが無い＝スロットル無しである（`NOT_BREACHING`）。
   * 1 件でも意味があるので閾値 0 超・1 分・1 データポイントで鳴らす
   * （design §6.2 の「> 0、1 分間」）。
   */
  private throttleAlarm(key: OrderAlarmKey, fn: IFunction): Alarm {
    return this.alarm(key, {
      metric: fn.metricThrottles({ period: ORDER_ALARM_PERIOD, statistic: Stats.SUM }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }

  /**
   * Streams 滞留の Warning（design §6.2、要件 20.1）。
   *
   * 閾値 60 秒は「滞留が始まった」の目印であり、
   * ダッシュボードの 1 本目の注釈線と同じ値を使う。
   * design §6.2 の「1 分間」に従い 1 データポイントで鳴らす。
   */
  private iteratorAgeWarning(): Alarm {
    return this.alarm('iteratorAgeWarning', {
      metric: this.iteratorAgeMetric(),
      threshold: ITERATOR_AGE_THRESHOLDS_MS.warning,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.MISSING,
    });
  }

  /**
   * Streams 滞留が危険域（design §6.2、要件 20.3）。**本 Spec で最も重要なアラーム。**
   *
   * ## 閾値
   *
   * 保持期限（24 時間）の半分。`ITERATOR_AGE_THRESHOLDS_MS.dataLossRisk` を
   * ダッシュボードと共有しており、半分であることは
   * `order-monitoring.test.ts` が `retention` との関係で検査している。
   * 半分に置くのは対処の猶予を確保するためである
   * （投入を止めても滞留の消化には時間がかかる。要件 20.4）。
   *
   * ## `treatMissingData: MISSING` を選ぶ理由（`NOT_BREACHING` ではない）
   *
   * `IteratorAge` は ESM が Lambda を呼び出したときにしか発行されない。
   * `NOT_BREACHING` にすると、**滞留が危険域に入った後にコンシューマが
   * 止まった瞬間にアラームが OK へ戻る**。状況が悪化した時点で
   * 画面が緑になるという最悪の挙動である。
   * `MISSING` はデータが無い間、直前の状態を保持するので、
   * 一度 ALARM に入れば鳴り続ける。
   *
   * `BREACHING` にすれば「一度も起動しないまま滞留する」構成事故も拾えるが、
   * 本 PoC は検証していない時間帯が無トラフィックであり、常時 ALARM になる。
   * 常に鳴るアラームは無視されるので、結果として
   * **本当に危険なときにも誰も見ない**。この死角はファイル冒頭に明記して残す。
   *
   * ## `datapointsToAlarm = 1` / `evaluationPeriods = 5` を選ぶ理由
   *
   * 「連続 N 分の breach を要求する」設定にしてはならない。
   * `IteratorAge` の発行は呼び出し駆動なので、1 分の中に呼び出しが無い分は
   * 欠測になる。連続を要求すると、欠測が 1 つ挟まるだけで
   * カウントが振り出しに戻り、**12 時間を越えているのに永遠に鳴らない**
   * 状態が起こり得る。M / N（5 分のうち 1 点）にすれば欠測に強い。
   *
   * 1 点で断定してよいのは、`IteratorAge` が**レート値ではなく経過時間**
   * だからである。12 時間という値は滞留が積み上がった結果としてしか現れず、
   * 瞬間的なスパイクで到達することはない。誤検知のおそれが無いなら、
   * 検知を遅らせる理由も無い。
   *
   * ## 統計は最大（平均ではない）
   *
   * `parallelizationFactor > 1` では複数のシャード／バッチが並行し、
   * 平均は 1 つのシャードだけが取り残された状態を薄めてしまう。
   * DynamoDB Streams はシャード内の順序を保証するため、
   * **1 シャードの取り残しはそのシャードのキーのデータロスそのもの**である。
   * 最大なら拾える。
   */
  private iteratorAgeDataLossRisk(): Alarm {
    return this.alarm('iteratorAgeDataLossRisk', {
      metric: this.iteratorAgeMetric(),
      threshold: ITERATOR_AGE_THRESHOLDS_MS.dataLossRisk,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: ITERATOR_AGE_EVALUATION_PERIODS,
      datapointsToAlarm: ITERATOR_AGE_DATAPOINTS_TO_ALARM,
      treatMissingData: TreatMissingData.MISSING,
    });
  }

  /** `order-processor` の `IteratorAge` 最大値。2 本のアラームで共有する */
  private iteratorAgeMetric(): IMetric {
    return this.props.functions.orderProcessor.metric('IteratorAge', {
      period: ORDER_ALARM_PERIOD,
      statistic: Stats.MAXIMUM,
    });
  }

  /**
   * DLQ にメッセージ（design §6.2、要件 13.6）。
   *
   * **ここが鳴らないことは「レコードを失っていない」を意味しない。**
   * 保持期限超過によるトリムは ESM の失敗ではないため `OnFailure` が
   * 発火せず、DLQ には何も入らない（design 論点 4）。
   * データロスの検知は `iteratorAgeDataLossRisk` に依存する。
   *
   * 評価粒度だけ 5 分にしている理由は `ORDER_DLQ_ALARM_PERIOD` を参照。
   */
  private deadLetterQueue(): Alarm {
    return this.alarm('deadLetterQueue', {
      metric: this.props.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: ORDER_DLQ_ALARM_PERIOD,
        statistic: Stats.MAXIMUM,
      }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }

  /** 注文テーブル（基表）の書き込みスロットル（design §6.2、要件 13.8） */
  private ordersTableWriteThrottles(): Alarm {
    return this.writeThrottleAlarm('ordersTableWriteThrottles');
  }

  /**
   * 注文テーブルの GSI の書き込みスロットル（design §6.2、要件 13.8）。
   *
   * 基表と別のアラームにしている理由は `ORDER_ALARM_SPECS` のコメントを参照。
   */
  private ordersIndexWriteThrottles(): Alarm {
    const { ordersTable, ordersCustomerIndexName } = this.props.tables;

    return this.writeThrottleAlarm('ordersIndexWriteThrottles', {
      TableName: ordersTable.tableName,
      GlobalSecondaryIndexName: ordersCustomerIndexName,
    });
  }

  /**
   * `WriteThrottleEvents` > 0 のアラーム。
   *
   * DynamoDB はスロットルが起きなかった分の 0 を発行しないため
   * `NOT_BREACHING`。オンデマンドテーブルなのでスロットルは
   * 「バーストを超える急増」のときだけ起き、軸 A では 0 で推移する見込みである
   * （要件 20.5 の「壁にならなかった要素」）。0 のまま鳴らないことが観測結果になる。
   */
  private writeThrottleAlarm(
    key: OrderAlarmKey,
    dimensionsMap?: Record<string, string>
  ): Alarm {
    return this.alarm(key, {
      metric: this.props.tables.ordersTable.metric('WriteThrottleEvents', {
        period: ORDER_ALARM_PERIOD,
        statistic: Stats.SUM,
        ...(dimensionsMap === undefined ? {} : { dimensionsMap }),
      }),
      threshold: 0,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }

  /**
   * アラームを 1 本作り、SNS トピックをアクションに設定する。
   *
   * **アクションの設定をここに集約している**のが要点である。
   * 個々のアラームの定義箇所で `addAlarmAction` を呼ぶ形にすると、
   * 1 本だけ呼び忘れたアラームが「作られてはいるが誰にも通知しない」
   * 状態で残る。合成もデプロイも成功するため気づかない。
   * `order-alarms.test.ts` は全アラームにアクションが付いていることを検査する。
   */
  private alarm(
    key: OrderAlarmKey,
    options: {
      readonly metric: IMetric;
      readonly threshold: number;
      readonly comparisonOperator: ComparisonOperator;
      readonly evaluationPeriods: number;
      readonly datapointsToAlarm?: number;
      readonly treatMissingData: TreatMissingData;
    }
  ): Alarm {
    const spec = ORDER_ALARM_SPECS[key];

    const alarm = new Alarm(this, capitalize(key), {
      // 深刻度を名前の先頭側に入れる。通知メールの件名に載るため、
      // 開かずに Critical と Warning を切り分けられる
      alarmName: this.alarmName(`${spec.severity}-${spec.logicalName}`),
      alarmDescription: describe(spec),
      metric: options.metric,
      threshold: options.threshold,
      comparisonOperator: options.comparisonOperator,
      evaluationPeriods: options.evaluationPeriods,
      ...(options.datapointsToAlarm === undefined
        ? {}
        : { datapointsToAlarm: options.datapointsToAlarm }),
      treatMissingData: options.treatMissingData,
      // 既定だが明示する。false のアラームは画面上は赤くなるのに通知が飛ばない
      actionsEnabled: true,
    });

    alarm.addAlarmAction(new SnsAction(this.topic));

    return alarm;
  }
}

/**
 * アラームの説明文。
 *
 * 通知の本文に載るため、**購読者が他の資料を開かずに判断できる**内容にする。
 * サブスクリプションを作らない構成なので、購読するのは
 * 検証の文脈を持たない人になり得る。
 */
function describe(spec: OrderAlarmSpec): string {
  return [
    `[${spec.severity}] ${spec.designRow}`,
    spec.meaning,
    `対応要件: ${spec.requirements.join(' / ')}`,
  ].join(' | ');
}

/**
 * アラーム名の既定サフィックス。
 * `order-tables.ts` の `defaultTableNameSuffix` と同じ考え方
 * （スタック名を含むハッシュの下 8 桁。再デプロイでは変わらない）。
 */
function defaultNameSuffix(scope: Construct): string {
  return Names.uniqueResourceName(scope, { maxLength: 12 }).slice(-8).toLowerCase();
}

/** Construct の ID 用。`queryThrottles` → `QueryThrottles` */
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
