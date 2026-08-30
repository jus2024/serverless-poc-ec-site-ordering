import { Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { describe, expect, it } from 'vitest';
import { OrderTables } from './order-tables.js';
import {
  ORDER_STREAM_DLQ_RETENTION,
  ORDER_STREAM_INSERT_FILTER,
  ORDER_STREAM_RETRY_ATTEMPTS,
  OrderStream,
  resolveStreamSettings,
  type OrderStreamProps,
} from './order-stream.js';
import { testApp } from './test-app.js';
import { resolveVerificationConfig } from './verification-config.js';

/**
 * 合成結果の検証のみを行う（AWS へは接続しない）。
 *
 * processor は素の `Function` で代用する。ここで検証したいのは ESM の設定と
 * DLQ の配線であり、`NodejsFunction` のバンドル（esbuild の実行）は要らない。
 */
const ESM_TYPE = 'AWS::Lambda::EventSourceMapping';
const QUEUE_TYPE = 'AWS::SQS::Queue';

/** 環境変数から検証パラメータを組み立てる。警告出力はテスト出力を汚さないよう捨てる */
function config(env: Record<string, string | undefined> = {}) {
  return resolveVerificationConfig({ env, onWarning: null });
}

function synth(
  props: Partial<OrderStreamProps> = {},
  stackName = 'amplify-poc-sandbox-1111'
) {
  const stack = new Stack(testApp(), stackName);
  const tables = new OrderTables(stack, 'OrderTables', { config: config() });
  const processor = new LambdaFunction(stack, 'OrderProcessor', {
    runtime: Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: Code.fromInline('exports.handler = async () => ({});'),
  });
  const stream = new OrderStream(stack, 'OrderStream', {
    tables,
    processor,
    config: config(),
    ...props,
  });

  return { stack, tables, processor, stream, template: Template.fromStack(stack) };
}

const synthed = synth();

/** 合成済みの ESM を 1 つ取り出す（この構成では 1 本しか作らない） */
function eventSourceMapping(template: Template): Record<string, unknown> {
  const mappings = Object.values(template.findResources(ESM_TYPE));
  expect(mappings, 'イベントソースマッピング').toHaveLength(1);
  return mappings[0].Properties as Record<string, unknown>;
}

describe('OrderStream: ESM の設定（design §5.6）', () => {
  it('注文テーブルの Streams を processor に直結する（要件 9.1）', () => {
    const properties = eventSourceMapping(synthed.template) as {
      EventSourceArn: { 'Fn::GetAtt': [string, string] };
      FunctionName: { Ref: string };
    };

    // 注文テーブルの StreamArn を参照している（在庫テーブル等ではない）
    expect(properties.EventSourceArn['Fn::GetAtt'][1]).toBe('StreamArn');
    expect(JSON.stringify(properties.EventSourceArn)).toContain('OrderTablesOrdersTable');
    expect(properties.FunctionName).toBeDefined();
  });

  it('design §5.6 の表どおりの設定になっている', () => {
    synthed.template.hasResourceProperties(ESM_TYPE, {
      // 過去の注文を再処理しない
      StartingPosition: 'LATEST',
      // 既定。`Invocations` の毎分値がそのまま処理レートになる（design 論点 10）
      BatchSize: 1,
      ParallelizationFactor: 1,
      // 要件 9.8。ハンドラの batchItemFailures を Lambda に解釈させる
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      // design 論点 4。無限再試行で 1 レコードがシャードを塞ぐのを防ぐ
      MaximumRetryAttempts: ORDER_STREAM_RETRY_ATTEMPTS,
      BisectBatchOnFunctionError: true,
    });
  });

  it('maxRecordAge を既定では設定しない（-1 = 無期限。滞留の成長を打ち切らない）', () => {
    // 有限にすると「古いレコードを捨てて追いつく」挙動になり、
    // 保持期限に達してデータロスに至る過程（要件 20.3）が観測できなくなる。
    // CFN の MaximumRecordAgeInSeconds は省略時の既定が -1 なので、
    // -1 は「プロパティを渡さない」ことで表す
    synthed.template.hasResourceProperties(ESM_TYPE, {
      MaximumRecordAgeInSeconds: Match.absent(),
    });
  });

  it('検証パラメータの P と BatchSize をそのまま反映する（要件 9.3 / design §10.1）', () => {
    const { template } = synth({
      config: config({
        ORDER_STREAM_PARALLELIZATION_FACTOR: '10',
        ORDER_STREAM_BATCH_SIZE: '25',
      }),
    });

    template.hasResourceProperties(ESM_TYPE, {
      ParallelizationFactor: 10,
      BatchSize: 25,
    });
  });

  it('maxRecordAge に有限値を指定するとその秒数が入る（別途の実験パラメータ）', () => {
    const { template, stream } = synth({
      config: config({ ORDER_STREAM_MAX_RECORD_AGE_SECONDS: '3600' }),
    });

    template.hasResourceProperties(ESM_TYPE, { MaximumRecordAgeInSeconds: 3600 });
    expect(stream.settings.maxRecordAge).toEqual(Duration.seconds(3600));
  });
});

describe('OrderStream: イベントフィルタ（要件 9.7 / Property 8）', () => {
  it('INSERT だけを届ける', () => {
    // これが無いと processor が自分の 4 回の更新（MODIFY）で再起動され、
    // 1 周ごとに 4 倍でイベントが増幅する無限ループになる。
    // しかも症状（IteratorAge の増加）は「壁に到達した」状態と見分けが付かず、
    // 測定結果が静かに嘘になる
    synthed.template.hasResourceProperties(ESM_TYPE, {
      FilterCriteria: {
        Filters: [{ Pattern: JSON.stringify({ eventName: ['INSERT'] }) }],
      },
    });
  });

  it('公開している定数と合成結果が一致する（出典の二重化を防ぐ）', () => {
    const properties = eventSourceMapping(synthed.template) as {
      FilterCriteria: { Filters: { Pattern: string }[] };
    };

    // CDK の `FilterCriteria.filter` は小文字の `pattern` を返し、
    // CFN のプロパティは `Pattern` になる。突き合わせるのは中身のパターン文字列
    expect(properties.FilterCriteria.Filters.map((filter) => filter.Pattern)).toEqual([
      (ORDER_STREAM_INSERT_FILTER as { pattern: string }).pattern,
    ]);
  });

  it('フィルタは設定で無効化できない（構造として固定する）', () => {
    // props にフィルタを差し替える口を作らない。設定項目にすると
    // 「無限ループを起こせる設定」が存在することになる
    const keys = Object.keys({
      tables: undefined,
      processor: undefined,
      config: undefined,
      queueNamePrefix: undefined,
      queueNameSuffix: undefined,
    } satisfies Record<keyof OrderStreamProps, undefined>);

    expect(keys).not.toContain('filters');
  });
});

describe('OrderStream: DLQ（要件 9.9 / 16.2、design 論点 4）', () => {
  it('SQS キューを作り onFailure に指定する', () => {
    const queues = Object.entries(synthed.template.findResources(QUEUE_TYPE));
    expect(queues).toHaveLength(1);

    const properties = eventSourceMapping(synthed.template) as {
      DestinationConfig: { OnFailure: { Destination: { 'Fn::GetAtt': [string, string] } } };
    };
    const [queueLogicalId] = queues[0];

    expect(properties.DestinationConfig.OnFailure.Destination['Fn::GetAtt']).toEqual([
      queueLogicalId,
      'Arn',
    ]);
    expect(synthed.stream.deadLetterQueue).toBeDefined();
  });

  it('メッセージを 14 日保持し、SQS 管理キーで暗号化する', () => {
    synthed.template.hasResourceProperties(QUEUE_TYPE, {
      MessageRetentionPeriod: ORDER_STREAM_DLQ_RETENTION.toSeconds(),
      SqsManagedSseEnabled: true,
    });
  });

  it('スタック削除で消える（要件 17.5）', () => {
    for (const [logicalId, queue] of Object.entries(
      synthed.template.findResources(QUEUE_TYPE)
    )) {
      expect(queue.DeletionPolicy, logicalId).toBe('Delete');
      expect(queue.UpdateReplacePolicy, logicalId).toBe('Delete');
    }
  });

  it('processor に DLQ への送信権限が付く', () => {
    const actions = Object.values(synthed.template.findResources('AWS::IAM::Policy'))
      .flatMap(
        (policy) =>
          policy.Properties.PolicyDocument.Statement as { Action: string | string[] }[]
      )
      .flatMap((statement) =>
        Array.isArray(statement.Action) ? statement.Action : [statement.Action]
      );

    expect(actions).toContain('sqs:SendMessage');
  });

  it('キュー名が既定ではスタックごとに異なる（sandbox 間で衝突しない）', () => {
    const nameOf = (stackName: string): string =>
      Object.values(synth({}, stackName).template.findResources(QUEUE_TYPE))[0].Properties
        .QueueName as string;

    expect(nameOf('amplify-poc-alice-aaaa')).not.toBe(nameOf('amplify-poc-bob-bbbb'));
  });

  it('サフィックスを空にすると固定名になる', () => {
    const { template } = synth({ queueNameSuffix: '' });

    template.hasResourceProperties(QUEUE_TYPE, {
      QueueName: 'kiro-roasters-order-stream-dlq',
    });
  });
});

describe('OrderStream: Streams の読み取り権限（design §5.9）', () => {
  it('DynamoEventSource が processor に付与する（Construct 側では付けない）', () => {
    const actions = Object.values(synthed.template.findResources('AWS::IAM::Policy'))
      .flatMap(
        (policy) =>
          policy.Properties.PolicyDocument.Statement as { Action: string | string[] }[]
      )
      .flatMap((statement) =>
        Array.isArray(statement.Action) ? statement.Action : [statement.Action]
      );

    expect(actions).toContain('dynamodb:DescribeStream');
    expect(actions).toContain('dynamodb:GetRecords');
    expect(actions).toContain('dynamodb:GetShardIterator');
  });
});

describe('resolveStreamSettings: maxRecordAge の変換', () => {
  it('-1（無期限）は Duration を返さない', () => {
    const settings = resolveStreamSettings({
      streamBatchSize: 1,
      streamParallelizationFactor: 1,
      streamMaxRecordAgeSeconds: -1,
    });

    // Duration.seconds(-1) は EventSourceMapping の検証（60 秒〜7 日）に弾かれる。
    // -1 を値として渡す手段が無いため、省略で表す
    expect(settings.maxRecordAge).toBeUndefined();
    expect(settings.maxRecordAgeSeconds).toBe(-1);
  });

  it('有限値は Duration に変換する', () => {
    const settings = resolveStreamSettings({
      streamBatchSize: 10,
      streamParallelizationFactor: 5,
      streamMaxRecordAgeSeconds: 60,
    });

    expect(settings.maxRecordAge).toEqual(Duration.seconds(60));
    expect(settings.batchSize).toBe(10);
    expect(settings.parallelizationFactor).toBe(5);
  });
});
