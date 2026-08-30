import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { MockIntegration, RestApi } from 'aws-cdk-lib/aws-apigateway';
import { Function as LambdaFunction, type IFunction } from 'aws-cdk-lib/aws-lambda';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  METRIC_DIMENSIONS,
  METRIC_NAMES,
  METRICS_NAMESPACE,
  METRICS_SERVICE_NAME,
  flushMetrics,
  recordOrdersProcessed,
  recordStageDuration,
  resetMetrics,
} from '../functions/shared/metrics.js';
import { ORDER_STAGES } from '../functions/shared/types.js';
import { ORDER_FUNCTION_SPECS } from './order-functions.js';
import {
  ACCOUNT_CONCURRENCY_LIMIT,
  ACCOUNT_CONCURRENCY_WARNING_RATIO,
  ITERATOR_AGE_THRESHOLDS_MS,
  ORDER_DASHBOARD_WIDGETS,
  ORDER_EMF,
  ORDER_MONITORING_FUNCTION_KEYS,
  OrderMonitoring,
  type OrderMonitoringFunctions,
} from './order-monitoring.js';
import { ORDER_CUSTOMER_INDEX_NAME, OrderTables } from './order-tables.js';
import { testApp } from './test-app.js';
import { resolveVerificationConfig } from './verification-config.js';

/**
 * 合成結果の検証のみを行う（AWS へは接続しない）。
 *
 * 関数・キュー・API は**インポート（`from*`）で代用する**。実リソースにすると
 * ディメンションの値が `{ Ref }` になり、「照会系のウィジェットに
 * order-query だけが載っているか」（要件 13.5）を機械的に確かめられない。
 * インポートなら物理名が合成結果に文字列として現れる。
 */

const DASHBOARD_TYPE = 'AWS::CloudWatch::Dashboard';

/** `{ Ref }` などの未解決トークンの置き換え文字。JSON として壊れない形にする */
const TOKEN = '<token>';

const FUNCTION_NAMES = {
  orderAccept: 'test-order-accept',
  orderQuery: 'test-order-query',
  inventorySeed: 'test-inventory-seed',
  orderProcessor: 'test-order-processor',
  loadGenerator: 'test-load-generator',
  queryImpactMeasure: 'test-query-impact-measure',
  executionStatus: 'test-execution-status',
} as const;

const DLQ_NAME = 'test-order-stream-dlq';
const API_NAME = 'test-order-api';

function config() {
  return resolveVerificationConfig({ env: {}, onWarning: null });
}

/**
 * 代用の Lambda 関数。
 *
 * `fromFunctionName` ではなく ARN からインポートする。`fromFunctionName` は
 * リージョンとアカウントのトークンを含む ARN を組み立てるため、
 * そこから逆算される `functionName` もトークンになり、
 * 合成結果に関数名が文字列として現れない。
 */
function importedFunction(stack: Stack, id: string, functionName: string): IFunction {
  return LambdaFunction.fromFunctionArn(
    stack,
    id,
    `arn:aws:lambda:us-east-1:123456789012:function:${functionName}`
  );
}

/**
 * 代用の REST API。`ApiName` ディメンションだけが要るため統合はモックにする。
 * `RestApi` はメソッドが 1 つも無いと合成が失敗するのでルートに 1 本足す。
 */
function restApi(stack: Stack, restApiName?: string): RestApi {
  const api = new RestApi(stack, 'Api', {
    ...(restApiName === undefined ? {} : { restApiName }),
    deploy: false,
  });
  api.root.addMethod('GET', new MockIntegration());
  return api;
}

function synth(
  options: {
    /** 省略した関数（タスク 20 で増える計測系）を再現するためのキー一覧 */
    readonly functionKeys?: readonly (keyof typeof FUNCTION_NAMES)[];
    readonly dashboardNameSuffix?: string;
  } = {}
) {
  const stack = new Stack(testApp(), 'amplify-poc-sandbox-1111');
  const keys =
    options.functionKeys ?? (['orderAccept', 'orderQuery', 'inventorySeed', 'orderProcessor'] as const);

  const functions: Record<string, IFunction> = {};
  for (const key of keys) {
    functions[key] = importedFunction(stack, `Fn${key}`, FUNCTION_NAMES[key]);
  }

  const monitoring = new OrderMonitoring(stack, 'OrderMonitoring', {
    functions: functions as unknown as OrderMonitoringFunctions,
    tables: new OrderTables(stack, 'OrderTables', { config: config() }),
    api: restApi(stack, API_NAME),
    deadLetterQueue: Queue.fromQueueArn(
      stack,
      'Dlq',
      `arn:aws:sqs:us-east-1:123456789012:${DLQ_NAME}`
    ),
    ...(options.dashboardNameSuffix === undefined
      ? {}
      : { dashboardNameSuffix: options.dashboardNameSuffix }),
  });

  return { stack, monitoring, template: Template.fromStack(stack) };
}

interface DashboardWidget {
  readonly type: string;
  readonly width: number;
  readonly height: number;
  readonly properties: {
    readonly title?: string;
    readonly markdown?: string;
    readonly period?: number;
    readonly metrics?: unknown[][];
    readonly annotations?: { horizontal?: { value: number; label?: string }[] };
  };
}

/** `DashboardBody`（`Fn::Join` を含む）を実際の JSON に戻す */
function dashboardBody(template: Template): {
  name: string;
  body: { widgets: DashboardWidget[]; periodOverride?: string; start?: string };
} {
  const dashboards = Object.values(template.findResources(DASHBOARD_TYPE));
  expect(dashboards, 'ダッシュボードは 1 枚だけ（design §6.1）').toHaveLength(1);

  const properties = dashboards[0].Properties as {
    DashboardName: string;
    DashboardBody: unknown;
  };

  return { name: properties.DashboardName, body: JSON.parse(join(properties.DashboardBody)) };
}

function join(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const parts = (value as { 'Fn::Join': [string, unknown[]] })['Fn::Join'];
  const [delimiter, elements] = parts;
  return elements.map((element) => (typeof element === 'string' ? element : TOKEN)).join(delimiter);
}

const synthed = synth();
const { body } = dashboardBody(synthed.template);

/** タイトルでウィジェットを 1 つ取る */
function widget(title: string): DashboardWidget {
  const found = body.widgets.filter((candidate) => candidate.properties.title === title);
  expect(found, `ウィジェット「${title}」`).toHaveLength(1);
  return found[0];
}

/** ウィジェットの系列を `[名前空間, メトリクス名, ...ディメンション]` に畳む */
function series(title: string): string[][] {
  return (widget(title).properties.metrics ?? []).map((metric) =>
    metric.filter((element): element is string => typeof element === 'string')
  );
}

/**
 * 系列のディメンションを連想配列にする。
 * CloudWatch のダッシュボード JSON は名前と値を交互に並べ、
 * CDK はディメンション名を昇順に並べ替えるため、位置では比較できない。
 */
function dimensions(metric: string[]): Record<string, string> {
  const pairs = metric.slice(2);
  const result: Record<string, string> = {};
  for (let index = 0; index + 1 < pairs.length; index += 2) {
    result[pairs[index]] = pairs[index + 1];
  }
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  resetMetrics();
});

describe('OrderMonitoring: ダッシュボード本体（要件 13.7）', () => {
  it('IaC で単一のダッシュボードを作る', () => {
    synthed.template.resourceCountIs(DASHBOARD_TYPE, 1);
  });

  it('名前が既定ではスタックごとに異なる（sandbox 間で取り合わない）', () => {
    const nameOf = (stackName: string): string => {
      const stack = new Stack(testApp(), stackName);
      const fn = importedFunction(stack, 'Fn', 'f');
      const monitoring = new OrderMonitoring(stack, 'OrderMonitoring', {
        functions: { orderQuery: fn, orderProcessor: fn },
        tables: new OrderTables(stack, 'OrderTables', { config: config() }),
        api: restApi(stack),
        deadLetterQueue: Queue.fromQueueArn(
          stack,
          'Dlq',
          'arn:aws:sqs:us-east-1:123456789012:q'
        ),
      });
      expect(monitoring.dashboard).toBeDefined();
      return dashboardBody(Template.fromStack(stack)).name;
    };

    expect(nameOf('amplify-poc-alice-aaaa')).not.toBe(nameOf('amplify-poc-bob-bbbb'));
  });

  it('サフィックスを空にすると design §6.1 の固定名になる', () => {
    const { template } = synth({ dashboardNameSuffix: '' });

    expect(dashboardBody(template).name).toBe('kiro-roasters-order-pipeline');
  });

  it('粒度を 1 分に固定し、表示期間で粒度が変わらないようにする', () => {
    // AUTO（既定）だと表示期間に応じて CloudWatch が粒度を変え、
    // 「Invocations の毎分値 = 処理レート」という読み方が静かに崩れる
    expect(body.periodOverride).toBe('inherit');

    for (const candidate of body.widgets) {
      if (candidate.type === 'metric') {
        expect(candidate.properties.period, candidate.properties.title).toBe(60);
      }
    }
  });

  it('すべての系列が 1 分粒度で定義されている', () => {
    const periods = body.widgets
      .filter((candidate) => candidate.type === 'metric')
      .flatMap((candidate) => candidate.properties.metrics ?? [])
      .map((metric) => metric.at(-1) as { period?: number });

    expect(periods.length).toBeGreaterThan(0);
    for (const options of periods) {
      expect(options.period).toBe(60);
    }
  });
});

describe('OrderMonitoring: design §6.1 の表の全行が存在する', () => {
  it('タイトルが揃っている', () => {
    const titles = body.widgets
      .filter((candidate) => candidate.type === 'metric')
      .map((candidate) => candidate.properties.title);

    expect(titles).toEqual(expect.arrayContaining(Object.values(ORDER_DASHBOARD_WIDGETS)));
  });

  it('読み方の説明を先頭に置く（ゼロが観測結果であることを明示するため）', () => {
    const [first] = body.widgets;

    expect(first.type).toBe('text');
    expect(first.properties.markdown).toContain('壁にならなかった要素');
  });
});

describe('OrderMonitoring: IteratorAge（要件 9.5 / 13.1、design 論点 9）', () => {
  const target = widget(ORDER_DASHBOARD_WIDGETS.iteratorAge);

  it('一次指標として最上段に単独で置く', () => {
    // 滞留件数は IteratorAge × 投入レートからしか導出できない（design §2.4）。
    // 他の系列と同じ行に並べると読み落とす
    expect(target.width).toBe(24);

    const metricWidgets = body.widgets.filter((candidate) => candidate.type === 'metric');
    expect(metricWidgets[0].properties.title).toBe(ORDER_DASHBOARD_WIDGETS.iteratorAge);
  });

  it('processor の IteratorAge を見る', () => {
    for (const metric of series(ORDER_DASHBOARD_WIDGETS.iteratorAge)) {
      expect(metric).toEqual([
        'AWS/Lambda',
        'IteratorAge',
        'FunctionName',
        FUNCTION_NAMES.orderProcessor,
      ]);
    }
  });

  it('保持期限とデータロス危険域に注釈線を引く（design §2.3 の段階 3）', () => {
    const values = (target.properties.annotations?.horizontal ?? []).map(
      (horizontal) => horizontal.value
    );

    expect(values).toEqual([
      ITERATOR_AGE_THRESHOLDS_MS.warning,
      ITERATOR_AGE_THRESHOLDS_MS.dataLossRisk,
      ITERATOR_AGE_THRESHOLDS_MS.retention,
    ]);
  });

  it('危険域は保持期限の半分である（対処の猶予を確保する位置）', () => {
    expect(ITERATOR_AGE_THRESHOLDS_MS.dataLossRisk * 2).toBe(
      ITERATOR_AGE_THRESHOLDS_MS.retention
    );
    // DynamoDB Streams の保持期限は 24 時間
    expect(ITERATOR_AGE_THRESHOLDS_MS.retention).toBe(24 * 60 * 60 * 1000);
  });
});

describe('OrderMonitoring: スロットルの分離（要件 13.5）', () => {
  it('照会系のウィジェットは order-query だけを載せる', () => {
    expect(series(ORDER_DASHBOARD_WIDGETS.queryThrottles)).toEqual([
      ['AWS/Lambda', 'Throttles', 'FunctionName', FUNCTION_NAMES.orderQuery],
    ]);
  });

  it('後続処理系のウィジェットは order-processor だけを載せる', () => {
    expect(series(ORDER_DASHBOARD_WIDGETS.processorThrottles)).toEqual([
      ['AWS/Lambda', 'Throttles', 'FunctionName', FUNCTION_NAMES.orderProcessor],
    ]);
  });

  it('2 つは別のウィジェットである（同一グラフに重ねない）', () => {
    // 重ねると「processor 側が立ったとき query 側は立っているか」という
    // 波及の判定（design §2.6）が目で追えなくなる
    expect(ORDER_DASHBOARD_WIDGETS.queryThrottles).not.toBe(
      ORDER_DASHBOARD_WIDGETS.processorThrottles
    );

    const throttleWidgets = body.widgets.filter((candidate) =>
      (candidate.properties.metrics ?? []).some((metric) => metric.includes('Throttles'))
    );

    expect(throttleWidgets).toHaveLength(2);
    for (const candidate of throttleWidgets) {
      expect(candidate.properties.metrics, candidate.properties.title).toHaveLength(1);
    }
  });
});

describe('OrderMonitoring: 壁にならない要素（要件 20.5）', () => {
  it('アカウント全体の同時実行数をディメンションなしで見る', () => {
    // ディメンションを付けない ConcurrentExecutions がアカウント全体の値になる。
    // この構成以外の関数も含むため、枠の奪い合いを見るならこちらが正しい
    expect(series(ORDER_DASHBOARD_WIDGETS.concurrencyAccount)).toEqual([
      ['AWS/Lambda', 'ConcurrentExecutions'],
    ]);
  });

  it('同時実行枠と Warning 位置に注釈線を引く', () => {
    const values = (
      widget(ORDER_DASHBOARD_WIDGETS.concurrencyAccount).properties.annotations?.horizontal ?? []
    ).map((horizontal) => horizontal.value);

    expect(values).toEqual([
      ACCOUNT_CONCURRENCY_LIMIT * ACCOUNT_CONCURRENCY_WARNING_RATIO,
      ACCOUNT_CONCURRENCY_LIMIT,
    ]);
  });

  it('DynamoDB の書き込みスロットルを基表と GSI で分けて見る（要件 13.8）', () => {
    const metrics = series(ORDER_DASHBOARD_WIDGETS.dynamoWriteThrottles);

    expect(metrics).toHaveLength(2);
    for (const metric of metrics) {
      expect(metric[0]).toBe('AWS/DynamoDB');
      expect(metric[1]).toBe('WriteThrottleEvents');
      expect(metric).toContain('TableName');
    }

    // GSI 側は射影 ALL で基表と同量の書き込みを受け、warm throughput も
    // 設定していない（design §4.2）。基表より先に詰まる可能性がある
    expect(metrics[0]).not.toContain('GlobalSecondaryIndexName');
    expect(metrics[1]).toEqual(
      expect.arrayContaining(['GlobalSecondaryIndexName', ORDER_CUSTOMER_INDEX_NAME])
    );
  });

  it('DynamoDB の消費書き込み容量も基表と GSI で見る', () => {
    const metrics = series(ORDER_DASHBOARD_WIDGETS.dynamoWriteCapacity);

    expect(metrics).toHaveLength(2);
    for (const metric of metrics) {
      expect(metric[1]).toBe('ConsumedWriteCapacityUnits');
    }
    expect(metrics[1]).toContain('GlobalSecondaryIndexName');
  });

  it('API Gateway の 4XX / 5XX を見る（要件 12.1）', () => {
    const metrics = series(ORDER_DASHBOARD_WIDGETS.apiRequests);
    const names = metrics.map((metric) => metric[1]);

    expect(names).toEqual(['Count', '4XXError', '5XXError']);
    for (const metric of metrics) {
      expect(metric).toEqual(expect.arrayContaining(['AWS/ApiGateway', 'ApiName', API_NAME]));
    }
  });

  it('API Gateway のレイテンシは分位点で見る（平均は一部の遅延を隠す）', () => {
    const statistics = (widget(ORDER_DASHBOARD_WIDGETS.apiLatency).properties.metrics ?? []).map(
      (metric) => (metric.at(-1) as { stat?: string }).stat
    );

    expect(statistics).toEqual(['p50', 'p90', 'p99']);
  });
});

describe('OrderMonitoring: DLQ と関数別の系列', () => {
  it('DLQ の取得可能なメッセージ数を見る（要件 13.6）', () => {
    expect(series(ORDER_DASHBOARD_WIDGETS.deadLetterQueue)).toEqual([
      ['AWS/SQS', 'ApproximateNumberOfMessagesVisible', 'QueueName', DLQ_NAME],
    ]);
  });

  it('エラーと同時実行を渡された関数すべてについて見る（要件 13.1）', () => {
    const labels = (title: string): (string | undefined)[] =>
      (widget(title).properties.metrics ?? []).map(
        (metric) => (metric.at(-1) as { label?: string }).label
      );

    // 既定の合成では同期パス 3 関数 + processor
    expect(labels(ORDER_DASHBOARD_WIDGETS.errors)).toEqual([
      'order-accept',
      'order-query',
      'inventory-seed',
      'order-processor',
    ]);
    expect(labels(ORDER_DASHBOARD_WIDGETS.concurrencyByFunction)).toEqual([
      'order-accept',
      'order-query',
      'inventory-seed',
      'order-processor',
    ]);
  });

  it('計測系の 3 関数が増えても props の形を変えずに系列が増える（タスク 20）', () => {
    const { template } = synth({
      functionKeys: ORDER_MONITORING_FUNCTION_KEYS,
    });
    const full = dashboardBody(template).body;
    const errors = full.widgets.find(
      (candidate) => candidate.properties.title === ORDER_DASHBOARD_WIDGETS.errors
    );

    expect(errors?.properties.metrics).toHaveLength(ORDER_MONITORING_FUNCTION_KEYS.length);
  });

  it('系列の並び順は order-functions.ts の関数一覧と一致する', () => {
    // ここが食い違うと、新しい関数を足したのにダッシュボードから漏れる
    expect([...ORDER_MONITORING_FUNCTION_KEYS].sort()).toEqual(
      Object.keys(ORDER_FUNCTION_SPECS).sort()
    );
  });
});

describe('OrderMonitoring: EMF のカスタムメトリクス（design 論点 9）', () => {
  it('処理件数を出典どおりの名前空間とメトリクス名で見る', () => {
    const metrics = series(ORDER_DASHBOARD_WIDGETS.ordersProcessed);

    expect(metrics).toHaveLength(1);
    expect(metrics[0].slice(0, 2)).toEqual([METRICS_NAMESPACE, METRIC_NAMES.ordersProcessed]);
    expect(dimensions(metrics[0])).toEqual({
      [ORDER_EMF.serviceDimension]: METRICS_SERVICE_NAME,
    });
  });

  it('段階所要時間を段階別に見る（平均と p99）', () => {
    // Average は CloudWatch の既定統計なので、合成結果では `stat` が省略される
    for (const [title, expected] of [
      [ORDER_DASHBOARD_WIDGETS.stageDurationAverage, undefined],
      [ORDER_DASHBOARD_WIDGETS.stageDurationP99, 'p99'],
    ] as const) {
      const metrics = series(title);

      expect(metrics, title).toHaveLength(ORDER_STAGES.length);
      expect(
        metrics.map((metric) => dimensions(metric)[METRIC_DIMENSIONS.stage]),
        title
      ).toEqual([...ORDER_STAGES]);

      for (const metric of metrics) {
        expect(metric.slice(0, 2), title).toEqual([
          METRICS_NAMESPACE,
          METRIC_NAMES.stageDurationMs,
        ]);
        expect(dimensions(metric)[ORDER_EMF.serviceDimension], title).toBe(
          METRICS_SERVICE_NAME
        );
      }

      const statistics = (widget(title).properties.metrics ?? []).map(
        (metric) => (metric.at(-1) as { stat?: string }).stat
      );
      expect(new Set(statistics), title).toEqual(new Set([expected]));
    }
  });

  it('ダッシュボード側に写した文字列が metrics.ts と一致する', () => {
    // IaC から実行時モジュールを import しない（Powertools を合成の依存に入れない。
    // design §5.3）ため意図的に重複させている。食い違いはここで落とす
    expect(ORDER_EMF.namespace).toBe(METRICS_NAMESPACE);
    expect(ORDER_EMF.serviceName).toBe(METRICS_SERVICE_NAME);
    expect(ORDER_EMF.ordersProcessed).toBe(METRIC_NAMES.ordersProcessed);
    expect(ORDER_EMF.stageDurationMs).toBe(METRIC_NAMES.stageDurationMs);
    expect(ORDER_EMF.stageDimension).toBe(METRIC_DIMENSIONS.stage);
    expect([...ORDER_EMF.stages]).toEqual([...ORDER_STAGES]);
  });

  it('Powertools が実際に出力するディメンション名と一致する', () => {
    // `service` は metrics.ts に現れない文字列（Powertools が serviceName から
    // 自動で付ける）。ダッシュボードが依存しているので実出力で確かめる。
    //
    // Powertools は `console` ではなく `process.stdout` に直結した
    // 独自の Console へ書くため（Lambda 側の console 差し替えを避けるため）、
    // 捕まえるのはストリーム側である
    resetMetrics();
    const emitted: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      emitted.push(String(chunk));
      return true;
    });

    recordStageDuration('payment', 12);
    recordOrdersProcessed();
    flushMetrics();

    const blobs = emitted
      .flatMap((chunk) => chunk.split('\n'))
      .filter((line) => line.includes('"_aws"'))
      .map(
        (line) =>
          JSON.parse(line) as {
            _aws: { CloudWatchMetrics: { Namespace: string; Dimensions: string[][] }[] };
          }
      );

    expect(blobs.length).toBeGreaterThan(0);
    const dimensionSets = blobs.flatMap((blob) =>
      blob._aws.CloudWatchMetrics.map((entry) => entry.Dimensions[0])
    );

    expect(dimensionSets).toContainEqual([ORDER_EMF.serviceDimension]);
    expect(dimensionSets).toContainEqual([
      ORDER_EMF.serviceDimension,
      ORDER_EMF.stageDimension,
    ]);
    for (const blob of blobs) {
      for (const entry of blob._aws.CloudWatchMetrics) {
        expect(entry.Namespace).toBe(ORDER_EMF.namespace);
      }
    }
  });
});

describe('OrderMonitoring: アラームは作らない（タスク 19.2 の責務）', () => {
  it('この Construct はダッシュボードだけを作る', () => {
    synthed.template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    synthed.template.resourceCountIs('AWS::SNS::Topic', 0);
  });
});
