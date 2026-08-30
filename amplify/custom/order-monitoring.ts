import { Duration, Names } from 'aws-cdk-lib';
import type { RestApiBase } from 'aws-cdk-lib/aws-apigateway';
import {
  Dashboard,
  GraphWidget,
  LegendPosition,
  Metric,
  PeriodOverride,
  Stats,
  TextWidget,
  type HorizontalAnnotation,
  type IMetric,
} from 'aws-cdk-lib/aws-cloudwatch';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import type { IQueue } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { ORDER_FUNCTION_SPECS, type OrderFunctionKey } from './order-functions.js';
import type { OrderTables } from './order-tables.js';

/**
 * CloudWatch ダッシュボード（design §6.1、要件 9.5 / 13.1 / 13.5 / 13.6 / 13.7 / 13.8 / 20.5）。
 *
 * ## この Construct が作るもの
 *
 * design §6.1 の表に載っている**単一のダッシュボード**だけを作る。
 * アラームと SNS トピック（design §6.2）はこの Construct には含めない。
 * ダッシュボードは「読むための道具」、アラームは「起こすための道具」で
 * 判断の性質が違い、閾値の調整でダッシュボードを触りたくないためである。
 *
 * ## 手作業でグラフを作らない（要件 13.7）
 *
 * 検証は条件を変えて何度も回す。ダッシュボードをコンソールで作ると
 * 「前回どのメトリクスをどの粒度で見たか」が記録に残らず、
 * シナリオ間の比較が成立しなくなる。ここが唯一の出典である。
 *
 * ## `IteratorAge` を最上段に単独で置く（design 論点 9、要件 9.5 / 20.1）
 *
 * 滞留**件数**を直接測るメトリクスは存在しない。CloudWatch が出すのは
 * `IteratorAge`（時間）だけで、件数は `IteratorAge × 投入レート` から導出する
 * （design §2.4。当初は「× 消費能力」としていたが A2 の実測で訂正した）。
 * したがって `IteratorAge` は本 PoC の一次指標であり、
 * 他の系列と同じ行に並べると読み落とす。24 幅で最上段に単独で置き、
 * 保持期限（24 時間）との距離が一目で分かるよう注釈線を引いている。
 *
 * ## 照会系と後続処理系のスロットルを別ウィジェットにする（要件 13.5）
 *
 * **同一グラフに載せてはならない。** 本 PoC の問いの 1 つは
 * 「後続処理の負荷が同期パスに波及するか」であり（design §2.6）、
 * 波及は「processor 側のスロットルが立ち上がっているとき、
 * order-query 側は立っているか」という**因果の読み取り**で判定する。
 * 1 つのグラフに重ねると、どちらの系列が動いたのかが目で追えず、
 * 判定そのものができなくなる。
 *
 * ## 「壁にならない要素」も並べる（要件 20.5）
 *
 * DynamoDB の書き込みスロットル、API Gateway のエラー、
 * アカウント全体の同時実行数は、軸 A ではゼロないし低位で推移する見込みである。
 * **ゼロを示すためにウィジェットを置く。** 「壁になった要素」と
 * 「壁にならなかった要素」を区別して記録するのが要件 20.5 であり、
 * グラフが無い要素は「見ていない」と区別できない。
 *
 * ## 計測系の 3 関数は任意で受け取る
 *
 * `load-generator` / `query-impact-measure` / `execution-status` は
 * props を全 7 関数の任意項目にしてあるため、`OrderFunctions` がそのまま
 * 構造的に適合する（関数が増えても自動的に系列へ加わる）。
 */

/**
 * ダッシュボードのメトリクスの粒度。
 *
 * 1 分に固定する。design 論点 10 の検算は「`BatchSize = 1` なら
 * `Invocations` の毎分値がそのまま処理レート（件/分）」という読み方に依存し、
 * 検証シナリオの投入レートも件/分で刻んである（requirements の検証シナリオ）。
 * 5 分（CDK の既定）にすると、グラフの数字と記録の単位が食い違う。
 */
const PERIOD = Duration.minutes(1);

/** ダッシュボードの既定の表示期間。負荷シナリオ 1 本を通して見られる長さ */
const DEFAULT_INTERVAL = Duration.hours(3);

/** ダッシュボード名の既定の接頭辞と論理名（design §6.1） */
export const ORDER_DASHBOARD_NAME_PREFIX = 'kiro-roasters';
export const ORDER_DASHBOARD_LOGICAL_NAME = 'order-pipeline';

/**
 * Lambda の同時実行枠（既定・未申請の値）。
 *
 * 注釈線の参照値としてのみ使う。実際の枠はアカウントごとに違うため、
 * この線を超えたことが即スロットルを意味するわけではない。
 * 「枠に近づいているか」を目で見るための目安である（design §6.2 の Warning と同じ位置）。
 */
export const ACCOUNT_CONCURRENCY_LIMIT = 1000;

/** 枠に対する Warning の位置（design §6.2 の「枠の 80%」） */
export const ACCOUNT_CONCURRENCY_WARNING_RATIO = 0.8;

/**
 * `IteratorAge` に引く注釈線（design §2.3 / §6.2）。
 *
 * `retention` は DynamoDB Streams の保持期限（24 時間）そのもので、
 * **ここに到達するとレコードは失われる**。`dataLossRisk` はその半分で、
 * design §6.2 が Critical アラームを置く位置と同じ（対処の猶予を確保するため）。
 * `warning` は滞留が始まったことの目印。
 */
export const ITERATOR_AGE_THRESHOLDS_MS = {
  warning: 60_000,
  dataLossRisk: 12 * 60 * 60 * 1000,
  retention: 24 * 60 * 60 * 1000,
} as const;

/**
 * EMF のカスタムメトリクス側の文字列（design 論点 9 / §6.1）。
 *
 * `amplify/functions/shared/metrics.ts` に同じ値がある。**意図的に重複させている。**
 * IaC から Lambda の実行時モジュールを import すると、`metrics.ts` が読み込む
 * Powertools が合成の依存に入ってしまう（`order-api.ts` の CORS と同じ判断。design §5.3）。
 * 食い違いは `order-monitoring.test.ts` が両方を突き合わせて検出する。
 *
 * `service` は Powertools が `serviceName` から自動で付ける既定ディメンションのキーである。
 * `metrics.ts` 側には現れない文字列なので、テストは実際に EMF を 1 回出力して
 * ディメンション名を確かめている。
 */
export const ORDER_EMF = {
  namespace: 'KiroRoasters/OrderPipeline',
  serviceDimension: 'service',
  serviceName: 'order-pipeline',
  stageDimension: 'Stage',
  ordersProcessed: 'OrdersProcessed',
  stageDurationMs: 'StageDurationMs',
  /** 段階名。`shared/types.ts` の `ORDER_STAGES` と一致する必要がある */
  stages: ['payment', 'allocation', 'notification', 'point'],
} as const;

/**
 * ウィジェットのタイトル。
 *
 * 定数にしているのは、テストが「design §6.1 の表の行がすべて存在するか」を
 * タイトルで確かめるためである。タイトルを変えるとテストが落ちるので、
 * 表の行を消す変更が黙って通ることはない。
 */
export const ORDER_DASHBOARD_WIDGETS = {
  /** 一次指標。単独行 */
  iteratorAge: 'Streams 滞留: IteratorAge（processor）',
  processingRate: '処理レート: Invocations（processor）',
  ordersProcessed: '処理件数（EMF: OrdersProcessed）',
  stageDurationAverage: '段階所要時間 平均（EMF: StageDurationMs）',
  stageDurationP99: '段階所要時間 p99（EMF: StageDurationMs）',
  /** 要件 13.5。この 2 つを 1 つにまとめてはならない */
  queryThrottles: 'スロットル（照会系: order-query）',
  processorThrottles: 'スロットル（後続処理系: order-processor）',
  concurrencyByFunction: '同時実行（関数別）',
  /** 要件 20.5。壁にならない見込みの要素 */
  concurrencyAccount: '同時実行（アカウント全体）',
  errors: 'エラー（関数別）',
  deadLetterQueue: 'DLQ のメッセージ数',
  apiLatency: 'API Gateway レイテンシ',
  /** 要件 20.5 */
  apiRequests: 'API Gateway リクエスト数とエラー',
  dynamoWriteCapacity: 'DynamoDB 書き込み容量（orders + GSI）',
  /** 要件 20.5 */
  dynamoWriteThrottles: 'DynamoDB 書き込みスロットル（orders + GSI）',
} as const;

/**
 * ダッシュボードに載せる関数。
 *
 * `orderQuery` と `orderProcessor` だけ必須にしているのは、要件 13.5 の
 * スロットル 2 枚がこの 2 つを前提にしているためである。
 * 残りは欠けても表の行が空になるだけで、ダッシュボードの意味は壊れない。
 * すべて任意にしてあるので、関数が増えても props の形を変えずに系列が増える。
 */
export interface OrderMonitoringFunctions {
  /** `GET` 系。要件 13.5 の照会系スロットルの対象 */
  readonly orderQuery: IFunction;
  /** Streams コンシューマ。`IteratorAge` と後続処理系スロットルの対象 */
  readonly orderProcessor: IFunction;
  readonly orderAccept?: IFunction;
  readonly inventorySeed?: IFunction;
  /** 負荷生成（要件 11） */
  readonly loadGenerator?: IFunction;
  /** 並行計測（要件 12） */
  readonly queryImpactMeasure?: IFunction;
  /** 実行状態照会（要件 11.6 / 12.5） */
  readonly executionStatus?: IFunction;
}

/**
 * 関数別ウィジェットの系列の並び順。
 *
 * `ORDER_FUNCTION_SPECS` のキーと一致していなければならない
 * （新しい関数を `order-functions.ts` に足したのにダッシュボードから漏れる、
 * という状態を `order-monitoring.test.ts` が検出する）。
 */
export const ORDER_MONITORING_FUNCTION_KEYS = [
  'orderAccept',
  'orderQuery',
  'inventorySeed',
  'orderProcessor',
  'loadGenerator',
  'queryImpactMeasure',
  'executionStatus',
] as const satisfies readonly OrderFunctionKey[];

export interface OrderMonitoringProps {
  /** 監視対象の Lambda 関数（`OrderFunctions` がそのまま適合する） */
  readonly functions: OrderMonitoringFunctions;

  /** テーブル 4 本。注文テーブルと GSI の書き込みを見る（要件 13.8） */
  readonly tables: OrderTables;

  /** 同期パスの API。レイテンシとエラーを見る（要件 12.1 / 20.5） */
  readonly api: RestApiBase;

  /** Streams ESM の DLQ（`OrderStream.deadLetterQueue`）。要件 13.6 */
  readonly deadLetterQueue: IQueue;

  /**
   * ダッシュボード名の接頭辞。
   *
   * @default 'kiro-roasters'（design §6.1 の `kiro-roasters-order-pipeline`）
   */
  readonly dashboardNamePrefix?: string;

  /**
   * ダッシュボード名の末尾に付ける一意サフィックス。
   *
   * 既定で付けるのは他の Construct と同じ理由である。ダッシュボード名は
   * リージョン内で一意で、固定名だと検証者ごとの sandbox やブランチごとの
   * スタックが同じダッシュボードを取り合う。**この衝突は静かに起きる**
   * （デプロイは成功し、片方のグラフが他方のリソースを指すだけ）ため、
   * 名前の衝突を避ける側を既定にしている。
   * 空文字を渡すと design §6.1 の固定名そのものになる。
   *
   * @default 構築パスとスタック名から算出した 8 文字
   */
  readonly dashboardNameSuffix?: string;
}

/** CloudWatch ダッシュボードを定義する Construct */
export class OrderMonitoring extends Construct {
  readonly dashboard: Dashboard;

  private readonly props: OrderMonitoringProps;

  constructor(scope: Construct, id: string, props: OrderMonitoringProps) {
    super(scope, id);

    this.props = props;

    const prefix = props.dashboardNamePrefix ?? ORDER_DASHBOARD_NAME_PREFIX;
    const suffix = props.dashboardNameSuffix ?? defaultNameSuffix(this);

    this.dashboard = new Dashboard(this, 'Dashboard', {
      dashboardName: [prefix, ORDER_DASHBOARD_LOGICAL_NAME, suffix]
        .filter((part) => part !== '')
        .join('-'),
      defaultInterval: DEFAULT_INTERVAL,
      // ウィジェットに書いた 1 分粒度を尊重させる。既定（AUTO）だと
      // 表示期間に応じて CloudWatch が粒度を変えてしまい、
      // 「Invocations の毎分値 = 処理レート」という読み方（design 論点 10）が
      // 画面を広げただけで静かに崩れる
      periodOverride: PeriodOverride.INHERIT,
    });

    this.dashboard.addWidgets(this.header());

    // 一次指標は単独行（design 論点 9）
    this.dashboard.addWidgets(this.iteratorAgeWidget());

    this.dashboard.addWidgets(this.processingRateWidget(), this.ordersProcessedWidget());
    this.dashboard.addWidgets(...this.stageDurationWidgets());

    // 要件 13.5。左右に並べるが、別のウィジェットである
    this.dashboard.addWidgets(this.queryThrottlesWidget(), this.processorThrottlesWidget());

    this.dashboard.addWidgets(
      this.concurrencyByFunctionWidget(),
      this.concurrencyAccountWidget()
    );
    this.dashboard.addWidgets(this.errorsWidget(), this.deadLetterQueueWidget());
    this.dashboard.addWidgets(this.apiLatencyWidget(), this.apiRequestsWidget());
    this.dashboard.addWidgets(
      this.dynamoWriteCapacityWidget(),
      this.dynamoWriteThrottlesWidget()
    );
  }

  /**
   * 読み方の説明。
   *
   * ダッシュボードに文章を置くのは、**このダッシュボードのゼロが意味を持つ**からである。
   * 「DynamoDB のスロットルが 0」は要件 20.5 の記録すべき観測結果であって、
   * 「まだ何も起きていない」ではない。説明が無いと、次に開いた検証者が
   * ゼロのグラフを無意味なものとして飛ばす。
   */
  private header(): TextWidget {
    return new TextWidget({
      width: 24,
      height: 4,
      markdown: [
        '## 注文処理パイプライン PoC（direct 構成）',
        '',
        `- **滞留件数は直接測れない。** \`IteratorAge\` × 消費能力（\`S × P ÷ D\`）で導出する（design §2.4）。保持期限は ${ITERATOR_AGE_THRESHOLDS_MS.retention / 3_600_000} 時間で、到達するとレコードは失われる`,
        '- **スロットルは照会系と後続処理系で別のグラフに分けてある**（要件 13.5）。波及の判定は 2 つのグラフを並べて読む',
        '- **ゼロも観測結果である。** DynamoDB のスロットル / API Gateway のエラー / アカウント全体の同時実行数は、軸 A では「壁にならなかった要素」として記録する（要件 20.5）',
        `- 粒度は ${PERIOD.toMinutes()} 分固定。\`Invocations\` の毎分値が処理レート（件/分）に相当する（\`BatchSize = 1\` のとき。design 論点 10）`,
      ].join('\n'),
    });
  }

  /** 一次指標。24 幅で単独（要件 9.5 / 13.1 / 20.1） */
  private iteratorAgeWidget(): GraphWidget {
    const { orderProcessor } = this.props.functions;

    return graph(ORDER_DASHBOARD_WIDGETS.iteratorAge, {
      width: 24,
      height: 8,
      left: [
        orderProcessor.metric('IteratorAge', {
          period: PERIOD,
          statistic: Stats.MAXIMUM,
          label: 'IteratorAge 最大',
        }),
        orderProcessor.metric('IteratorAge', {
          period: PERIOD,
          statistic: Stats.AVERAGE,
          label: 'IteratorAge 平均',
        }),
      ],
      leftYAxis: { label: 'ミリ秒', showUnits: false, min: 0 },
      leftAnnotations: [
        annotation(ITERATOR_AGE_THRESHOLDS_MS.warning, '滞留の開始（1 分）'),
        annotation(ITERATOR_AGE_THRESHOLDS_MS.dataLossRisk, 'データロス危険域（12 時間）'),
        annotation(ITERATOR_AGE_THRESHOLDS_MS.retention, '保持期限（24 時間）= データロス'),
      ],
    });
  }

  /** 処理レート。消費能力の実測値そのもの（要件 19.4 / 20.8） */
  private processingRateWidget(): GraphWidget {
    const { orderProcessor } = this.props.functions;

    return graph(ORDER_DASHBOARD_WIDGETS.processingRate, {
      left: [
        orderProcessor.metricInvocations({ period: PERIOD, label: 'Invocations（呼び出し/分）' }),
      ],
      right: [
        orderProcessor.metricDuration({
          period: PERIOD,
          statistic: Stats.AVERAGE,
          label: '実行時間 平均（D の実測）',
        }),
      ],
      leftYAxis: { label: '件/分', showUnits: false, min: 0 },
      rightYAxis: { label: 'ミリ秒', showUnits: false, min: 0 },
    });
  }

  /** EMF の処理件数。`Invocations` からの推定を検算する（design 論点 9） */
  private ordersProcessedWidget(): GraphWidget {
    return graph(ORDER_DASHBOARD_WIDGETS.ordersProcessed, {
      left: [
        emfMetric(ORDER_EMF.ordersProcessed, {
          statistic: Stats.SUM,
          label: '処理件数/分',
        }),
      ],
      leftYAxis: { label: '件/分', showUnits: false, min: 0 },
    });
  }

  /**
   * EMF の段階所要時間。平均と p99 を別のウィジェットにする。
   *
   * 8 系列を 1 枚に載せると、どの線がどの段階のどの統計値か読めない。
   * design §6.1 の 1 行を 2 枚に割っているのは表示上の都合で、
   * 見せているメトリクスは表のとおり「段階別の `StageDurationMs`」である。
   */
  private stageDurationWidgets(): GraphWidget[] {
    const byStatistic = (statistic: string): IMetric[] =>
      ORDER_EMF.stages.map((stage) =>
        emfMetric(ORDER_EMF.stageDurationMs, {
          statistic,
          label: stage,
          dimensionsMap: { [ORDER_EMF.stageDimension]: stage },
        })
      );

    const yAxis = { label: 'ミリ秒', showUnits: false, min: 0 };

    return [
      graph(ORDER_DASHBOARD_WIDGETS.stageDurationAverage, {
        left: byStatistic(Stats.AVERAGE),
        leftYAxis: yAxis,
      }),
      graph(ORDER_DASHBOARD_WIDGETS.stageDurationP99, {
        left: byStatistic(Stats.p(99)),
        leftYAxis: yAxis,
      }),
    ];
  }

  /**
   * 照会系のスロットル（要件 13.5 / 20.7）。
   *
   * `order-query` **のみ**。ここに他の関数の系列を足すと、
   * 「同期パスが割を食ったか」という問いに答えられなくなる。
   */
  private queryThrottlesWidget(): GraphWidget {
    const { orderQuery } = this.props.functions;

    return graph(ORDER_DASHBOARD_WIDGETS.queryThrottles, {
      left: [orderQuery.metricThrottles({ period: PERIOD, label: 'order-query' })],
      leftYAxis: { label: '件/分', showUnits: false, min: 0 },
    });
  }

  /** 後続処理系のスロットル（要件 13.5）。`order-processor` のみ */
  private processorThrottlesWidget(): GraphWidget {
    const { orderProcessor } = this.props.functions;

    return graph(ORDER_DASHBOARD_WIDGETS.processorThrottles, {
      left: [orderProcessor.metricThrottles({ period: PERIOD, label: 'order-processor' })],
      leftYAxis: { label: '件/分', showUnits: false, min: 0 },
    });
  }

  /** 関数別の同時実行数（要件 13.1 / 20.5） */
  private concurrencyByFunctionWidget(): GraphWidget {
    return graph(ORDER_DASHBOARD_WIDGETS.concurrencyByFunction, {
      left: this.perFunctionMetrics((fn, label) =>
        fn.metric('ConcurrentExecutions', { period: PERIOD, statistic: Stats.MAXIMUM, label })
      ),
      leftYAxis: { label: '同時実行数', showUnits: false, min: 0 },
    });
  }

  /**
   * アカウント全体の同時実行数（要件 13.1 / 20.5）。
   *
   * ディメンションを付けない `AWS/Lambda ConcurrentExecutions` が
   * アカウント全体の値になる。この構成の関数以外（Amplify の auth / data 側や
   * 同一アカウントの別スタック）も含むため、**枠の奪い合いを見るならこちらが正しい**。
   * 軸 A では枠に届かない見込みで、その「届かなかった」ことを示すために置く。
   */
  private concurrencyAccountWidget(): GraphWidget {
    const warning = ACCOUNT_CONCURRENCY_LIMIT * ACCOUNT_CONCURRENCY_WARNING_RATIO;

    return graph(ORDER_DASHBOARD_WIDGETS.concurrencyAccount, {
      left: [
        new Metric({
          namespace: 'AWS/Lambda',
          metricName: 'ConcurrentExecutions',
          period: PERIOD,
          statistic: Stats.MAXIMUM,
          label: 'アカウント全体',
        }),
      ],
      leftYAxis: { label: '同時実行数', showUnits: false, min: 0 },
      leftAnnotations: [
        annotation(warning, `枠の ${ACCOUNT_CONCURRENCY_WARNING_RATIO * 100}%（参照値）`),
        annotation(ACCOUNT_CONCURRENCY_LIMIT, '既定の同時実行枠（参照値）'),
      ],
    });
  }

  /** 関数別のエラー（要件 13.1） */
  private errorsWidget(): GraphWidget {
    return graph(ORDER_DASHBOARD_WIDGETS.errors, {
      left: this.perFunctionMetrics((fn, label) => fn.metricErrors({ period: PERIOD, label })),
      leftYAxis: { label: '件/分', showUnits: false, min: 0 },
    });
  }

  /**
   * DLQ のメッセージ数（要件 13.6）。
   *
   * **ここが 0 でも「レコードを失っていない」ことにはならない。**
   * 保持期限（24 時間）超過によるトリムは ESM の失敗ではないため
   * `OnFailure` が発火せず、DLQ には何も入らない（design 論点 4）。
   * データロスの検知は上段の `IteratorAge` に依存する。
   */
  private deadLetterQueueWidget(): GraphWidget {
    const { deadLetterQueue } = this.props;

    return graph(ORDER_DASHBOARD_WIDGETS.deadLetterQueue, {
      left: [
        deadLetterQueue.metricApproximateNumberOfMessagesVisible({
          period: PERIOD,
          statistic: Stats.MAXIMUM,
          label: '取得可能なメッセージ数',
        }),
      ],
      leftYAxis: { label: '件', showUnits: false, min: 0 },
    });
  }

  /**
   * 同期パスのレイテンシ（要件 12.1）。
   *
   * 波及の判定に使うのは分位点である。平均は、後続処理の負荷で
   * 一部のリクエストだけが遅くなる状況を隠してしまう。
   */
  private apiLatencyWidget(): GraphWidget {
    const { api } = this.props;

    return graph(ORDER_DASHBOARD_WIDGETS.apiLatency, {
      left: [
        api.metricLatency({ period: PERIOD, statistic: Stats.p(50), label: 'p50' }),
        api.metricLatency({ period: PERIOD, statistic: Stats.p(90), label: 'p90' }),
        api.metricLatency({ period: PERIOD, statistic: Stats.p(99), label: 'p99' }),
      ],
      leftYAxis: { label: 'ミリ秒', showUnits: false, min: 0 },
    });
  }

  /** リクエスト数とエラー（要件 12.1 / 20.5。API Gateway が壁でないことの確認） */
  private apiRequestsWidget(): GraphWidget {
    const { api } = this.props;

    return graph(ORDER_DASHBOARD_WIDGETS.apiRequests, {
      left: [api.metricCount({ period: PERIOD, statistic: Stats.SUM, label: 'Count' })],
      right: [
        api.metricClientError({ period: PERIOD, label: '4XXError' }),
        api.metricServerError({ period: PERIOD, label: '5XXError' }),
      ],
      leftYAxis: { label: '件/分', showUnits: false, min: 0 },
      rightYAxis: { label: 'エラー/分', showUnits: false, min: 0 },
    });
  }

  /** 注文テーブルと GSI の消費書き込み容量（要件 13.8） */
  private dynamoWriteCapacityWidget(): GraphWidget {
    const { ordersTable, ordersCustomerIndexName } = this.props.tables;

    return graph(ORDER_DASHBOARD_WIDGETS.dynamoWriteCapacity, {
      left: [
        ordersTable.metricConsumedWriteCapacityUnits({ period: PERIOD, label: 'orders（基表）' }),
        ordersTable.metricConsumedWriteCapacityUnits({
          period: PERIOD,
          label: `orders（GSI: ${ordersCustomerIndexName}）`,
          dimensionsMap: {
            TableName: ordersTable.tableName,
            GlobalSecondaryIndexName: ordersCustomerIndexName,
          },
        }),
      ],
      leftYAxis: { label: 'WCU/分', showUnits: false, min: 0 },
    });
  }

  /**
   * 書き込みスロットル（要件 13.8 / 20.5）。
   *
   * 基表と GSI を分けて出す。GSI は射影 ALL で基表と同量の書き込みを受け、
   * かつ warm throughput を設定していない（design §4.2）ため、
   * **基表より先に GSI 側が詰まる可能性がある**。同じ系列にまとめると
   * どちら側で起きたのかが分からない。
   */
  private dynamoWriteThrottlesWidget(): GraphWidget {
    const { ordersTable, ordersCustomerIndexName } = this.props.tables;

    return graph(ORDER_DASHBOARD_WIDGETS.dynamoWriteThrottles, {
      left: [
        ordersTable.metric('WriteThrottleEvents', {
          period: PERIOD,
          statistic: Stats.SUM,
          label: 'orders（基表）',
        }),
        ordersTable.metric('WriteThrottleEvents', {
          period: PERIOD,
          statistic: Stats.SUM,
          label: `orders（GSI: ${ordersCustomerIndexName}）`,
          dimensionsMap: {
            TableName: ordersTable.tableName,
            GlobalSecondaryIndexName: ordersCustomerIndexName,
          },
        }),
      ],
      leftYAxis: { label: '件/分', showUnits: false, min: 0 },
    });
  }

  /**
   * 渡された関数だけを `ORDER_MONITORING_FUNCTION_KEYS` の順に並べる。
   * 系列のラベルは `ORDER_FUNCTION_SPECS` の論理名を使う（物理名は
   * サフィックス付きで読みにくく、スタックごとに変わるため）。
   */
  private perFunctionMetrics(
    toMetric: (fn: IFunction, label: string) => IMetric
  ): IMetric[] {
    const metrics: IMetric[] = [];
    for (const key of ORDER_MONITORING_FUNCTION_KEYS) {
      const fn = this.props.functions[key];
      if (fn !== undefined) {
        metrics.push(toMetric(fn, ORDER_FUNCTION_SPECS[key].logicalName));
      }
    }
    return metrics;
  }
}

/** GraphWidget の共通設定（12 幅・6 高・凡例を右に）を当てる */
function graph(
  title: string,
  options: {
    readonly left?: IMetric[];
    readonly right?: IMetric[];
    readonly leftYAxis?: { label: string; showUnits: boolean; min: number };
    readonly rightYAxis?: { label: string; showUnits: boolean; min: number };
    readonly leftAnnotations?: HorizontalAnnotation[];
    readonly width?: number;
    readonly height?: number;
  }
): GraphWidget {
  return new GraphWidget({
    title,
    width: options.width ?? 12,
    height: options.height ?? 6,
    // 系列名（段階名や関数の論理名）が長いため、下ではなく右に置く
    legendPosition: LegendPosition.RIGHT,
    left: options.left,
    right: options.right,
    leftYAxis: options.leftYAxis,
    rightYAxis: options.rightYAxis,
    leftAnnotations: options.leftAnnotations,
    // ウィジェット側でも粒度を明示する。Metric に period を渡してあるので
    // 冗長だが、系列を足すときに 5 分（既定）が混ざるのを防ぐ
    period: PERIOD,
  });
}

/** 注釈線（閾値の目印）。色はダッシュボード側の既定に任せる */
function annotation(value: number, label: string): HorizontalAnnotation {
  return { value, label };
}

/**
 * EMF のカスタムメトリクスを組み立てる。
 * `service` ディメンションは Powertools が必ず付けるため、常に含める。
 */
function emfMetric(
  metricName: string,
  options: {
    readonly statistic: string;
    readonly label: string;
    readonly dimensionsMap?: Record<string, string>;
  }
): Metric {
  return new Metric({
    namespace: ORDER_EMF.namespace,
    metricName,
    period: PERIOD,
    statistic: options.statistic,
    label: options.label,
    dimensionsMap: {
      [ORDER_EMF.serviceDimension]: ORDER_EMF.serviceName,
      ...options.dimensionsMap,
    },
  });
}

/**
 * ダッシュボード名の既定サフィックス。
 * `order-tables.ts` の `defaultTableNameSuffix` と同じ考え方
 * （スタック名を含むハッシュの下 8 桁。再デプロイでは変わらない）。
 */
function defaultNameSuffix(scope: Construct): string {
  return Names.uniqueResourceName(scope, { maxLength: 12 }).slice(-8).toLowerCase();
}
