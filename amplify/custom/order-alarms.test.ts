import { Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Function as LambdaFunction, type IFunction } from 'aws-cdk-lib/aws-lambda';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { describe, expect, it } from 'vitest';
import {
  ITERATOR_AGE_DATAPOINTS_TO_ALARM,
  ITERATOR_AGE_EVALUATION_PERIODS,
  ORDER_ALARM_PERIOD,
  ORDER_ALARM_SEVERITY,
  ORDER_ALARM_SPECS,
  ORDER_ALARM_TOPIC_LOGICAL_NAME,
  ORDER_DLQ_ALARM_PERIOD,
  OrderAlarms,
  type OrderAlarmKey,
  type OrderAlarmsProps,
} from './order-alarms.js';
import {
  ACCOUNT_CONCURRENCY_LIMIT,
  ACCOUNT_CONCURRENCY_WARNING_RATIO,
  ITERATOR_AGE_THRESHOLDS_MS,
  type OrderMonitoringFunctions,
} from './order-monitoring.js';
import { ORDER_CUSTOMER_INDEX_NAME, OrderTables } from './order-tables.js';
import { testApp } from './test-app.js';
import { resolveVerificationConfig } from './verification-config.js';

/**
 * 合成結果の検証のみを行う（AWS へは接続しない）。
 *
 * 関数とキューは `order-monitoring.test.ts` と同じ理由でインポートで代用する。
 * 実リソースにするとディメンションの値が `{ Ref }` になり、
 * 「照会系のアラームが order-query だけを見ているか」（要件 13.5）を
 * 機械的に確かめられない。
 */

const ALARM_TYPE = 'AWS::CloudWatch::Alarm';
const TOPIC_TYPE = 'AWS::SNS::Topic';
const SUBSCRIPTION_TYPE = 'AWS::SNS::Subscription';

const FUNCTION_NAMES = {
  orderQuery: 'test-order-query',
  orderProcessor: 'test-order-processor',
} as const;

const DLQ_NAME = 'test-order-stream-dlq';

function config() {
  return resolveVerificationConfig({ env: {}, onWarning: null });
}

function importedFunction(stack: Stack, id: string, functionName: string): IFunction {
  return LambdaFunction.fromFunctionArn(
    stack,
    id,
    `arn:aws:lambda:us-east-1:123456789012:function:${functionName}`
  );
}

function synth(
  props: Partial<OrderAlarmsProps> = {},
  stackName = 'amplify-poc-sandbox-1111'
) {
  const stack = new Stack(testApp(), stackName);
  const functions: OrderMonitoringFunctions = {
    orderQuery: importedFunction(stack, 'FnQuery', FUNCTION_NAMES.orderQuery),
    orderProcessor: importedFunction(stack, 'FnProcessor', FUNCTION_NAMES.orderProcessor),
  };

  const alarms = new OrderAlarms(stack, 'OrderAlarms', {
    functions,
    tables: new OrderTables(stack, 'OrderTables', { config: config() }),
    deadLetterQueue: Queue.fromQueueArn(
      stack,
      'Dlq',
      `arn:aws:sqs:us-east-1:123456789012:${DLQ_NAME}`
    ),
    ...props,
  });

  return { stack, alarms, template: Template.fromStack(stack) };
}

const synthed = synth();

interface AlarmProperties {
  readonly AlarmName: string;
  readonly AlarmDescription?: string;
  readonly Namespace?: string;
  readonly MetricName?: string;
  readonly Dimensions?: { Name: string; Value: unknown }[];
  readonly Statistic?: string;
  readonly ExtendedStatistic?: string;
  readonly Period?: number;
  readonly Threshold: number;
  readonly ComparisonOperator: string;
  readonly EvaluationPeriods: number;
  readonly DatapointsToAlarm?: number;
  readonly TreatMissingData?: string;
  readonly ActionsEnabled?: boolean;
  readonly AlarmActions?: unknown[];
}

/** 合成された全アラームを物理名で引ける形にする */
function alarmsByName(template: Template): Map<string, AlarmProperties> {
  const result = new Map<string, AlarmProperties>();
  for (const resource of Object.values(template.findResources(ALARM_TYPE))) {
    const properties = resource.Properties as AlarmProperties;
    result.set(properties.AlarmName, properties);
  }
  return result;
}

const allAlarms = alarmsByName(synthed.template);

/** `ORDER_ALARM_SPECS` のキーから合成結果を引く */
function alarm(key: OrderAlarmKey): AlarmProperties {
  const spec = ORDER_ALARM_SPECS[key];
  const suffix = `${spec.severity}-${spec.logicalName}`;
  const found = [...allAlarms.entries()].filter(([name]) => name.includes(suffix));

  expect(found, `アラーム「${suffix}」`).toHaveLength(1);
  return found[0][1];
}

/** ディメンションを連想配列にする（トークンは残す） */
function dimensions(properties: AlarmProperties): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const dimension of properties.Dimensions ?? []) {
    result[dimension.Name] = dimension.Value;
  }
  return result;
}

const ALARM_KEYS = Object.keys(ORDER_ALARM_SPECS) as OrderAlarmKey[];

describe('OrderAlarms: design §6.2 の表の全行が存在する', () => {
  it('表の 7 行すべてにアラームがある', () => {
    // DynamoDB 書き込みスロットルの行だけ基表と GSI で 2 本に分かれる
    const designRows = new Set(ALARM_KEYS.map((key) => ORDER_ALARM_SPECS[key].designRow));

    expect([...designRows].sort()).toEqual(
      [
        'DLQ にメッセージ',
        'DynamoDB 書き込みスロットル',
        'Streams 滞留',
        'Streams 滞留が危険域',
        '同時実行が枠の 80%',
        '後続処理系のスロットル',
        '照会系のスロットル',
      ].sort()
    );
  });

  it('合成されたアラームの本数が仕様の本数と一致する（漏れも余りもない）', () => {
    synthed.template.resourceCountIs(ALARM_TYPE, ALARM_KEYS.length);
  });

  it('深刻度が design §6.2 の表どおりである', () => {
    const severities = Object.fromEntries(
      ALARM_KEYS.map((key) => [key, ORDER_ALARM_SPECS[key].severity])
    );

    expect(severities).toEqual({
      accountConcurrency: ORDER_ALARM_SEVERITY.warning,
      queryThrottles: ORDER_ALARM_SEVERITY.critical,
      processorThrottles: ORDER_ALARM_SEVERITY.critical,
      iteratorAgeWarning: ORDER_ALARM_SEVERITY.warning,
      iteratorAgeDataLossRisk: ORDER_ALARM_SEVERITY.critical,
      deadLetterQueue: ORDER_ALARM_SEVERITY.warning,
      ordersTableWriteThrottles: ORDER_ALARM_SEVERITY.warning,
      ordersIndexWriteThrottles: ORDER_ALARM_SEVERITY.warning,
    });
  });

  it('深刻度と対応要件が通知に載る（購読者が他の資料を開かずに判断できる）', () => {
    for (const key of ALARM_KEYS) {
      const spec = ORDER_ALARM_SPECS[key];
      const description = alarm(key).AlarmDescription ?? '';

      expect(description, key).toContain(`[${spec.severity}]`);
      expect(description, key).toContain(spec.designRow);
      for (const requirement of spec.requirements) {
        expect(description, key).toContain(requirement);
      }
    }
  });

  it('深刻度が名前の先頭側に入る（通知メールの件名で切り分けられる）', () => {
    expect(alarm('iteratorAgeDataLossRisk').AlarmName).toContain(
      `-${ORDER_ALARM_SEVERITY.critical}-`
    );
    expect(alarm('iteratorAgeWarning').AlarmName).toContain(
      `-${ORDER_ALARM_SEVERITY.warning}-`
    );
  });
});

describe('OrderAlarms: IteratorAge > 12 時間（要件 20.3、design §2.3 の段階 3）', () => {
  const target = alarm('iteratorAgeDataLossRisk');

  it('processor の IteratorAge の最大値を見る', () => {
    expect(target.Namespace).toBe('AWS/Lambda');
    expect(target.MetricName).toBe('IteratorAge');
    expect(dimensions(target)).toEqual({ FunctionName: FUNCTION_NAMES.orderProcessor });
    // 平均だと 1 シャードだけの取り残しが薄まる。
    // Streams はシャード内の順序を保証するため、1 シャードの取り残しは
    // そのシャードのキーのデータロスそのものである
    expect(target.Statistic).toBe('Maximum');
  });

  it('閾値が保持期限の半分である（12 時間 = 43,200,000ms）', () => {
    expect(target.Threshold).toBe(ITERATOR_AGE_THRESHOLDS_MS.dataLossRisk);
    expect(target.Threshold).toBe(12 * 60 * 60 * 1000);
    // ダッシュボードの注釈線と同じ定数を使っている。
    // ずれると「グラフでは線を越えているのに鳴らない」状態になる
    expect(target.Threshold * 2).toBe(ITERATOR_AGE_THRESHOLDS_MS.retention);
  });

  it('欠測でアラームが OK へ戻らない（MISSING。NOT_BREACHING ではない）', () => {
    // IteratorAge は ESM が Lambda を呼び出したときにしか発行されない。
    // NOT_BREACHING だと、危険域に入った後にコンシューマが止まった瞬間に
    // アラームが OK へ戻る。状況が悪化した時点で画面が緑になる
    expect(target.TreatMissingData).toBe('missing');
    expect(target.TreatMissingData).not.toBe('notBreaching');
    // BREACHING でもない（無トラフィックの時間帯に常時 ALARM になり、
    // 結果としてアラームが無視される）
    expect(target.TreatMissingData).not.toBe('breaching');
  });

  it('連続 breach を要求しない（欠測が挟まっても鳴る）', () => {
    // 連続 N 分を要求すると、呼び出しの無い 1 分が挟まるだけで
    // カウントが振り出しに戻り、12 時間を越えているのに永遠に鳴らない
    expect(target.DatapointsToAlarm).toBe(ITERATOR_AGE_DATAPOINTS_TO_ALARM);
    expect(target.EvaluationPeriods).toBe(ITERATOR_AGE_EVALUATION_PERIODS);
    expect(target.DatapointsToAlarm).toBe(1);
    expect(target.EvaluationPeriods).toBeGreaterThan(target.DatapointsToAlarm ?? 0);
  });

  it('1 点で断定してよい（IteratorAge はレートではなく経過時間）', () => {
    // 12 時間という値は滞留が積み上がった結果としてしか現れず、
    // 瞬間的なスパイクでは到達しない。誤検知が無いなら検知を遅らせる理由も無い
    expect(target.Period).toBe(ORDER_ALARM_PERIOD.toSeconds());
    expect(target.ComparisonOperator).toBe('GreaterThanThreshold');
  });

  it('Warning 側は 60 秒・1 分間で鳴る（要件 20.1）', () => {
    const warning = alarm('iteratorAgeWarning');

    expect(warning.Threshold).toBe(ITERATOR_AGE_THRESHOLDS_MS.warning);
    expect(warning.EvaluationPeriods).toBe(1);
    expect(warning.TreatMissingData).toBe('missing');
  });
});

describe('OrderAlarms: スロットル（要件 13.3 / 13.5）', () => {
  it('照会系は order-query だけを見る', () => {
    const target = alarm('queryThrottles');

    expect(target.MetricName).toBe('Throttles');
    expect(dimensions(target)).toEqual({ FunctionName: FUNCTION_NAMES.orderQuery });
  });

  it('後続処理系は order-processor だけを見る', () => {
    const target = alarm('processorThrottles');

    expect(target.MetricName).toBe('Throttles');
    expect(dimensions(target)).toEqual({ FunctionName: FUNCTION_NAMES.orderProcessor });
  });

  it('2 本に分かれている（1 本にまとめると波及の判定ができない）', () => {
    // 通知を見た時点で「同期パスに波及したのか、後続処理だけなのか」が
    // 分からないと、design §2.6 の問いに答えられない
    const throttleAlarms = [...allAlarms.values()].filter(
      (properties) => properties.MetricName === 'Throttles'
    );

    expect(throttleAlarms).toHaveLength(2);
    for (const properties of throttleAlarms) {
      expect(properties.Dimensions).toHaveLength(1);
    }
  });

  it('1 件でも鳴り、データが無い分は正常とみなす', () => {
    // Lambda はスロットルが起きなかった分の 0 を発行しない
    for (const key of ['queryThrottles', 'processorThrottles'] as const) {
      const target = alarm(key);

      expect(target.Threshold, key).toBe(0);
      expect(target.ComparisonOperator, key).toBe('GreaterThanThreshold');
      expect(target.EvaluationPeriods, key).toBe(1);
      expect(target.Statistic, key).toBe('Sum');
      expect(target.TreatMissingData, key).toBe('notBreaching');
      expect(target.Period, key).toBe(ORDER_ALARM_PERIOD.toSeconds());
    }
  });
});

describe('OrderAlarms: 同時実行が枠の 80%（要件 13.2）', () => {
  const target = alarm('accountConcurrency');

  it('アカウント全体の ConcurrentExecutions をディメンションなしで見る', () => {
    expect(target.Namespace).toBe('AWS/Lambda');
    expect(target.MetricName).toBe('ConcurrentExecutions');
    expect(target.Dimensions).toBeUndefined();
  });

  it('閾値がダッシュボードの注釈線と同じ 800 で、>= で判定する', () => {
    expect(target.Threshold).toBe(
      ACCOUNT_CONCURRENCY_LIMIT * ACCOUNT_CONCURRENCY_WARNING_RATIO
    );
    expect(target.Threshold).toBe(800);
    expect(target.ComparisonOperator).toBe('GreaterThanOrEqualToThreshold');
  });

  it('最大値で見る（枠は瞬間値で効くため平均では拾えない）', () => {
    expect(target.Statistic).toBe('Maximum');
    expect(target.EvaluationPeriods).toBe(1);
    expect(target.TreatMissingData).toBe('notBreaching');
  });
});

describe('OrderAlarms: DLQ（要件 13.6）', () => {
  const target = alarm('deadLetterQueue');

  it('取得可能なメッセージ数が 1 件でもあれば鳴る', () => {
    expect(target.Namespace).toBe('AWS/SQS');
    expect(target.MetricName).toBe('ApproximateNumberOfMessagesVisible');
    expect(dimensions(target)).toEqual({ QueueName: DLQ_NAME });
    expect(target.Threshold).toBe(0);
    expect(target.ComparisonOperator).toBe('GreaterThanThreshold');
    expect(target.Statistic).toBe('Maximum');
  });

  it('評価粒度だけ 5 分にする（発行間隔が保証されず状態が往復するため）', () => {
    // DLQ のメッセージは 14 日残るので、検知が数分遅れても失うものは無い
    expect(target.Period).toBe(ORDER_DLQ_ALARM_PERIOD.toSeconds());
    expect(target.Period).not.toBe(ORDER_ALARM_PERIOD.toSeconds());
    expect(target.TreatMissingData).toBe('notBreaching');
  });
});

describe('OrderAlarms: DynamoDB 書き込みスロットル（要件 13.8）', () => {
  it('基表と GSI を別のアラームにする', () => {
    // CloudWatch は基表と GSI を合算した系列を発行しない。
    // 基表だけを見るアラームにすると GSI 側で詰まったときに鳴らない。
    // GSI は射影 ALL かつ warm throughput 未設定で、先に詰まる側である
    const base = alarm('ordersTableWriteThrottles');
    const index = alarm('ordersIndexWriteThrottles');

    expect(base.MetricName).toBe('WriteThrottleEvents');
    expect(index.MetricName).toBe('WriteThrottleEvents');
    expect(Object.keys(dimensions(base))).toEqual(['TableName']);
    expect(dimensions(index).GlobalSecondaryIndexName).toBe(ORDER_CUSTOMER_INDEX_NAME);
  });

  it('どちらも 1 件で鳴り、データが無い分は正常とみなす', () => {
    for (const key of ['ordersTableWriteThrottles', 'ordersIndexWriteThrottles'] as const) {
      const target = alarm(key);

      expect(target.Namespace, key).toBe('AWS/DynamoDB');
      expect(target.Threshold, key).toBe(0);
      expect(target.Statistic, key).toBe('Sum');
      expect(target.EvaluationPeriods, key).toBe(1);
      expect(target.TreatMissingData, key).toBe('notBreaching');
    }
  });
});

describe('OrderAlarms: SNS トピック（design §6.2）', () => {
  it('トピックを 1 つだけ作る', () => {
    synthed.template.resourceCountIs(TOPIC_TYPE, 1);
  });

  it('サブスクリプションは作らない（メールアドレスをリポジトリに含めない）', () => {
    synthed.template.resourceCountIs(SUBSCRIPTION_TYPE, 0);
  });

  it('全アラームがこのトピックをアクションに持つ', () => {
    // 1 本でも付け忘れると「作られてはいるが誰にも通知しない」アラームが
    // 残る。合成もデプロイも成功するため気づかない
    const topicLogicalIds = Object.keys(synthed.template.findResources(TOPIC_TYPE));
    expect(topicLogicalIds).toHaveLength(1);

    const alarmActions = [...allAlarms.values()];
    expect(alarmActions).toHaveLength(ALARM_KEYS.length);

    for (const properties of alarmActions) {
      expect(properties.ActionsEnabled, properties.AlarmName).toBe(true);
      expect(properties.AlarmActions, properties.AlarmName).toEqual([
        { Ref: topicLogicalIds[0] },
      ]);
    }
  });

  it('ARN を公開する（タスク 20 で backend.addOutput が出力する）', () => {
    // 購読しない限りアラームは誰にも届かないため、
    // 検証者が購読できる状態にしておくことが要件である
    expect(synthed.alarms.topicArn).toBeDefined();
    expect(synthed.alarms.topicArn).toBe(synthed.alarms.topic.topicArn);
  });

  it('平文 HTTP での発行を拒否する', () => {
    // 保存時暗号化は付けていない。SNS の AWS 管理キーはキーポリシーを
    // 編集できず、CloudWatch アラームからの発行が失敗する
    synthed.template.hasResourceProperties(TOPIC_TYPE, {
      KmsMasterKeyId: Match.absent(),
    });
    synthed.template.resourceCountIs('AWS::SNS::TopicPolicy', 1);
  });

  it('スタック削除で消える（要件 17.5）', () => {
    for (const [logicalId, topic] of Object.entries(
      synthed.template.findResources(TOPIC_TYPE)
    )) {
      expect(topic.DeletionPolicy, logicalId).toBe('Delete');
    }
  });
});

describe('OrderAlarms: 物理名（既存の Construct と同じ衝突回避）', () => {
  it('既定ではスタックごとに異なる名前になる', () => {
    // アラーム名とトピック名はリージョン内で一意。固定名だと
    // 後からデプロイした側が既存のアラームを黙って上書きする
    const namesOf = (stackName: string): string[] =>
      [...alarmsByName(synth({}, stackName).template).keys()].sort();

    const alice = namesOf('amplify-poc-alice-aaaa');
    const bob = namesOf('amplify-poc-bob-bbbb');

    expect(alice).toHaveLength(ALARM_KEYS.length);
    for (const [index, name] of alice.entries()) {
      expect(name).not.toBe(bob[index]);
    }
  });

  it('サフィックスを空にすると接頭辞と論理名だけの固定名になる', () => {
    const { template } = synth({ alarmNameSuffix: '' });
    const names = [...alarmsByName(template).keys()];

    expect(names).toContain('kiro-roasters-critical-iterator-age-data-loss-risk');
    template.hasResourceProperties(TOPIC_TYPE, {
      TopicName: `kiro-roasters-${ORDER_ALARM_TOPIC_LOGICAL_NAME}`,
    });
  });
});
