import { Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import {
  ORDER_CUSTOMER_INDEX_NAME,
  ORDER_TABLE_ENV_KEYS,
  OrderTables,
  toWarmThroughput,
  type OrderTablesProps,
} from './order-tables.js';
import { testApp } from './test-app.js';
import { resolveVerificationConfig } from './verification-config.js';

/**
 * 合成結果の検証のみを行う（AWS へは接続しない）。
 * `TableV2` は `AWS::DynamoDB::GlobalTable` に合成される点に注意。
 */
const TABLE_TYPE = 'AWS::DynamoDB::GlobalTable';

/** 環境変数から検証パラメータを組み立てる。警告出力はテスト出力を汚さないよう捨てる */
function config(env: Record<string, string | undefined> = {}) {
  return resolveVerificationConfig({ env, onWarning: null });
}

function synth(props: OrderTablesProps = {}, stackName = 'amplify-poc-sandbox-1111') {
  const stack = new Stack(testApp(), stackName);
  const tables = new OrderTables(stack, 'OrderTables', {
    config: config(),
    ...props,
  });
  return { stack, tables, template: Template.fromStack(stack) };
}

describe('OrderTables: 注文テーブル（design §4.2）', () => {
  it('キー・課金・Streams・TTL・GSI が design どおりである', () => {
    const { template } = synth();

    template.hasResourceProperties(TABLE_TYPE, {
      KeySchema: [
        { AttributeName: 'order_id', KeyType: 'HASH' },
        { AttributeName: 'customer_id', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
      TimeToLiveSpecification: { AttributeName: 'expires_at', Enabled: true },
      GlobalSecondaryIndexes: [
        {
          IndexName: ORDER_CUSTOMER_INDEX_NAME,
          KeySchema: [
            { AttributeName: 'customer_id', KeyType: 'HASH' },
            { AttributeName: 'created_at', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    });
  });

  it('書き込み上限を設けない（DynamoDB を先に壁にしないため）', () => {
    const { template } = synth();

    template.hasResourceProperties(TABLE_TYPE, {
      TableName: Match.stringLikeRegexp('^kiro-roasters-orders-'),
      WriteOnDemandThroughputSettings: Match.absent(),
    });
  });

  it('Streams ARN を公開する（タスク 12 の ESM 用）', () => {
    const { tables } = synth();

    expect(tables.ordersStreamArn).toBeTruthy();
  });
});

describe('OrderTables: warm throughput（要件 10.3 / 17.8）', () => {
  it('未設定なら WarmThroughput を出力しない', () => {
    const { template } = synth();

    template.hasResourceProperties(TABLE_TYPE, {
      TableName: Match.stringLikeRegexp('^kiro-roasters-orders-'),
      WarmThroughput: Match.absent(),
    });
  });

  it('設定されていれば注文テーブルに反映する', () => {
    const { template } = synth({
      config: config({
        ORDER_WARM_THROUGHPUT_WRITE: '40000',
        ORDER_WARM_THROUGHPUT_READ: '12000',
      }),
    });

    template.hasResourceProperties(TABLE_TYPE, {
      TableName: Match.stringLikeRegexp('^kiro-roasters-orders-'),
      WarmThroughput: { WriteUnitsPerSecond: 40000, ReadUnitsPerSecond: 12000 },
    });
  });

  it('GSI には warm throughput を設定しない（引き上げ不可の課金を広げない）', () => {
    const { template } = synth({
      config: config({ ORDER_WARM_THROUGHPUT_WRITE: '40000' }),
    });

    template.hasResourceProperties(TABLE_TYPE, {
      GlobalSecondaryIndexes: [
        Match.objectLike({
          IndexName: ORDER_CUSTOMER_INDEX_NAME,
          WarmThroughput: Match.absent(),
        }),
      ],
    });
  });

  it('注文テーブル以外には設定しない', () => {
    const { template } = synth({
      config: config({ ORDER_WARM_THROUGHPUT_WRITE: '40000' }),
    });

    for (const logicalName of ['order-inventory', 'order-idempotency', 'order-executions']) {
      template.hasResourceProperties(TABLE_TYPE, {
        TableName: Match.stringLikeRegexp(`^kiro-roasters-${logicalName}-`),
        WarmThroughput: Match.absent(),
      });
    }
  });
});

describe('toWarmThroughput', () => {
  it('両方未設定なら undefined を返す（暗黙に値を埋めない）', () => {
    expect(toWarmThroughput({})).toBeUndefined();
  });

  it('片方だけ設定されていればその側だけを返す', () => {
    expect(toWarmThroughput({ warmThroughputWriteUnitsPerSecond: 40_000 })).toEqual({
      writeUnitsPerSecond: 40_000,
    });
    expect(toWarmThroughput({ warmThroughputReadUnitsPerSecond: 12_000 })).toEqual({
      readUnitsPerSecond: 12_000,
    });
  });
});

describe('OrderTables: 補助テーブル（design §4.1 / §4.3 / §4.4）', () => {
  it('引当在庫テーブルは itemId / warehouseId で、Streams と TTL を持たない', () => {
    const { template } = synth();

    template.hasResourceProperties(TABLE_TYPE, {
      TableName: Match.stringLikeRegexp('^kiro-roasters-order-inventory-'),
      KeySchema: [
        { AttributeName: 'itemId', KeyType: 'HASH' },
        { AttributeName: 'warehouseId', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      StreamSpecification: Match.absent(),
      TimeToLiveSpecification: Match.absent(),
    });
  });

  it('冪等性テーブルは id を PK に、expiration を TTL にする（要件 16.6）', () => {
    const { template } = synth();

    template.hasResourceProperties(TABLE_TYPE, {
      TableName: Match.stringLikeRegexp('^kiro-roasters-order-idempotency-'),
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'expiration', Enabled: true },
    });
  });

  it('実行管理テーブルは execution_id を PK に、expires_at を TTL にする', () => {
    const { template } = synth();

    template.hasResourceProperties(TABLE_TYPE, {
      TableName: Match.stringLikeRegexp('^kiro-roasters-order-executions-'),
      KeySchema: [{ AttributeName: 'execution_id', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'expires_at', Enabled: true },
    });
  });
});

describe('OrderTables: ライフサイクル（要件 17.5）', () => {
  it('4 本すべてがスタック削除で消える', () => {
    const { template } = synth();

    const tables = template.findResources(TABLE_TYPE);
    expect(Object.keys(tables)).toHaveLength(4);
    for (const [logicalId, resource] of Object.entries(tables)) {
      expect(resource.DeletionPolicy, logicalId).toBe('Delete');
      expect(resource.UpdateReplacePolicy, logicalId).toBe('Delete');
    }
  });
});

describe('OrderTables: 物理テーブル名', () => {
  /** 合成後の物理テーブル名。`table.tableName` は合成時にはトークンなので使えない */
  const tableNamesOf = (stackName: string): string[] =>
    Object.values(synth({}, stackName).template.findResources(TABLE_TYPE))
      .map((resource) => resource.Properties.TableName as string)
      .sort();

  it('既定ではスタックごとに異なる名前になる（サンドボックス間の衝突を避ける）', () => {
    const alice = tableNamesOf('amplify-poc-alice-sandbox-aaaa');
    const bob = tableNamesOf('amplify-poc-bob-sandbox-bbbb');

    expect(alice).toHaveLength(4);
    expect(alice).not.toEqual(bob);
  });

  it('同じスタックを再合成しても名前は変わらない（作り直しを起こさない）', () => {
    expect(tableNamesOf('amplify-poc-alice-sandbox-aaaa')).toEqual(
      tableNamesOf('amplify-poc-alice-sandbox-aaaa')
    );
  });

  it('サフィックスを空にすると design §4.1 の固定名になる', () => {
    const { template } = synth({ tableNameSuffix: '' });

    for (const tableName of [
      'kiro-roasters-orders',
      'kiro-roasters-order-inventory',
      'kiro-roasters-order-idempotency',
      'kiro-roasters-order-executions',
    ]) {
      template.hasResourceProperties(TABLE_TYPE, { TableName: tableName });
    }
  });
});

describe('OrderTables: Lambda へ渡す環境変数', () => {
  it('4 本のテーブル名と GSI 名を公開する', () => {
    const { tables } = synth();
    const env = tables.tableEnvironment;

    expect(Object.keys(env).sort()).toEqual(Object.values(ORDER_TABLE_ENV_KEYS).sort());
    expect(env[ORDER_TABLE_ENV_KEYS.ordersCustomerIndexName]).toBe(
      ORDER_CUSTOMER_INDEX_NAME
    );
  });
});
