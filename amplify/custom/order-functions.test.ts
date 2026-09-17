import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ORDERS_STREAM_ARN_ENV } from '../functions/load-generator/shard-count.js';
import { ORDER_API_BASE_URL_ENV } from '../functions/query-impact-measure/query-target.js';
import { RUNTIME_ENV_VARS } from '../functions/shared/runtime-config.js';
import { OrderApi } from './order-api.js';
import {
  ORDER_FUNCTION_ENV_KEYS,
  ORDER_FUNCTION_SPECS,
  ORDER_MEASUREMENT_ENV_KEYS,
  ORDER_PARAM_ENV_KEYS,
  OrderFunctions,
  buildParameterEnvironment,
  type OrderFunctionsProps,
} from './order-functions.js';
import { OrderTables } from './order-tables.js';
import { testApp } from './test-app.js';
import { VERIFICATION_ENV_VARS, resolveVerificationConfig } from './verification-config.js';

/**
 * 合成結果の検証のみを行う（AWS へは接続しない）。
 *
 * `NodejsFunction` を 7 つ含むため、`Template.fromStack` の時点でローカルの
 * esbuild が 7 回走る。共通の検査はモジュール読み込み時の 1 回の合成
 * （`synthed`）を読み回す。スタック名や props を変えて確かめるテストだけが
 * 合成をやり直すが、`testApp` が `outdir` を共有してアセットのバンドル結果を
 * 再利用させるため、2 回目以降の合成は約 10 ミリ秒で済む。
 */
const FUNCTION_TYPE = 'AWS::Lambda::Function';

function config(env: Record<string, string | undefined> = {}) {
  return resolveVerificationConfig({ env, onWarning: null });
}

function synth(props: Partial<OrderFunctionsProps> = {}) {
  const stack = new Stack(testApp(), 'amplify-poc-sandbox-1111');
  const tables = new OrderTables(stack, 'OrderTables', { config: config() });
  const functions = new OrderFunctions(stack, 'OrderFunctions', {
    tables,
    config: config(),
    ...props,
  });
  return { stack, tables, functions, template: Template.fromStack(stack) };
}

const synthed = synth();

/** 物理関数名から合成済みリソースを 1 つ取り出す */
function functionByName(
  template: Template,
  namePattern: string
): Record<string, unknown> {
  const matches = Object.values(template.findResources(FUNCTION_TYPE)).filter(
    (resource) =>
      typeof resource.Properties?.FunctionName === 'string' &&
      new RegExp(namePattern).test(resource.Properties.FunctionName as string)
  );
  expect(matches, `${namePattern} に一致する関数`).toHaveLength(1);
  return matches[0] as Record<string, unknown>;
}

describe('OrderFunctions: 作る関数の範囲', () => {
  it('design §5.2 の 7 関数をすべて合成する', () => {
    const names = Object.values(synthed.template.findResources(FUNCTION_TYPE))
      .map((resource) => resource.Properties?.FunctionName as string | undefined)
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.replace(/-[0-9a-z]{8}$/, ''));

    expect(names.sort()).toEqual([
      'kiro-execution-status',
      'kiro-inventory-seed',
      'kiro-load-generator',
      'kiro-order-accept',
      'kiro-order-processor',
      'kiro-order-query',
      'kiro-query-impact-measure',
    ]);
    expect(synthed.functions.all).toHaveLength(7);
  });

  it('`all` が ORDER_FUNCTION_SPECS の全キーを覆う（ダッシュボードの漏れを防ぐ）', () => {
    expect(synthed.functions.all).toHaveLength(
      Object.keys(ORDER_FUNCTION_SPECS).length
    );
  });

  it('イベントソースマッピングは作らない（order-stream.ts の責務）', () => {
    // ESM の設定は消費能力の変数 P を含む観測の道具であり、
    // 「どの条件で計測したか」の出典を 1 箇所に保つため分離している
    expect(
      Object.keys(synthed.template.findResources('AWS::Lambda::EventSourceMapping'))
    ).toHaveLength(0);
  });

  it('design §5.2 の 7 関数分の仕様を持つ', () => {
    expect(Object.keys(ORDER_FUNCTION_SPECS).sort()).toEqual([
      'executionStatus',
      'inventorySeed',
      'loadGenerator',
      'orderAccept',
      'orderProcessor',
      'orderQuery',
      'queryImpactMeasure',
    ]);
  });
});

describe('OrderFunctions: 共通設定（design §5.2）', () => {
  it('ランタイム・トレーシング・ハンドラが全関数で揃っている', () => {
    const functions = synthed.template.findResources(FUNCTION_TYPE);

    for (const [logicalId, resource] of Object.entries(functions)) {
      expect(resource.Properties.Runtime, logicalId).toBe('nodejs22.x');
      expect(resource.Properties.TracingConfig, logicalId).toEqual({ Mode: 'Active' });
      expect(resource.Properties.Handler, logicalId).toBe('index.handler');
    }
  });

  it('予約枠を設定しない（枠の奪い合いを観測するため）', () => {
    for (const [logicalId, resource] of Object.entries(
      synthed.template.findResources(FUNCTION_TYPE)
    )) {
      expect(resource.Properties.ReservedConcurrentExecutions, logicalId).toBeUndefined();
    }
  });

  it('タイムアウトとメモリが design §5.2 の表どおりである', () => {
    const expected = [
      { pattern: '^kiro-order-accept-', timeout: 30, memory: 256 },
      { pattern: '^kiro-order-query-', timeout: 30, memory: 256 },
      { pattern: '^kiro-inventory-seed-', timeout: 900, memory: 512 },
      // `BatchSize × D` を超える必要がある（design §5.2）
      { pattern: '^kiro-order-processor-', timeout: 300, memory: 512 },
      // 計測系のワーカーは Lambda の上限（15 分）まで使う
      { pattern: '^kiro-load-generator-', timeout: 900, memory: 1024 },
      { pattern: '^kiro-query-impact-measure-', timeout: 900, memory: 1024 },
      { pattern: '^kiro-execution-status-', timeout: 30, memory: 256 },
    ];

    for (const { pattern, timeout, memory } of expected) {
      const resource = functionByName(synthed.template, pattern) as {
        Properties: { Timeout: number; MemorySize: number };
      };
      expect(resource.Properties.Timeout, pattern).toBe(timeout);
      expect(resource.Properties.MemorySize, pattern).toBe(memory);
    }
  });
});

describe('OrderFunctions: 環境変数', () => {
  it('テーブル名と検証パラメータを全関数へ渡す', () => {
    for (const [logicalId, resource] of Object.entries(
      synthed.template.findResources(FUNCTION_TYPE)
    )) {
      const variables = resource.Properties.Environment.Variables as Record<
        string,
        unknown
      >;
      for (const key of ORDER_FUNCTION_ENV_KEYS) {
        expect(variables[key], `${logicalId} に ${key} が無い`).toBeDefined();
      }
    }
  });

  it('実行時に読む環境変数（RUNTIME_ENV_VARS）を漏らさず設定する', () => {
    // 設定漏れは合成を通り、Lambda 実行時に RuntimeConfigError になる。
    // あるいは既定値へ落ちて `GET /config` が実際と違う条件を報告する（要件 10.6）
    const variables = (
      functionByName(synthed.template, '^kiro-order-query-') as {
        Properties: { Environment: { Variables: Record<string, unknown> } };
      }
    ).Properties.Environment.Variables;

    for (const key of RUNTIME_ENV_VARS) {
      expect(variables[key], `${key} が設定されていない`).toBeDefined();
    }
  });

  it('検証パラメータのキー名が design §10.1（verification-config.ts）に存在する', () => {
    const known = new Set(VERIFICATION_ENV_VARS);
    for (const key of Object.values(ORDER_PARAM_ENV_KEYS)) {
      expect(known.has(key), `${key} が design §10.1 に無い`).toBe(true);
    }
  });

  it('ORDERS_STREAM_ARN は計測系の 2 関数にだけ渡す（design §5.9 の権限と揃える）', () => {
    const hasStreamArn = (pattern: string): boolean => {
      const variables = (
        functionByName(synthed.template, pattern) as {
          Properties: { Environment: { Variables: Record<string, unknown> } };
        }
      ).Properties.Environment.Variables;
      return variables[ORDER_MEASUREMENT_ENV_KEYS.ordersStreamArn] !== undefined;
    };

    expect(hasStreamArn('^kiro-load-generator-')).toBe(true);
    expect(hasStreamArn('^kiro-query-impact-measure-')).toBe(true);
    // 権限を持たない関数に値だけ配ると、配線の意図が読み取れなくなる
    expect(hasStreamArn('^kiro-order-query-')).toBe(false);
    expect(hasStreamArn('^kiro-execution-status-')).toBe(false);
  });

  it('ORDER_API_BASE_URL はこの Construct では設定しない（API の後で配線する）', () => {
    // API が関数を統合先として参照するため、値はここでは決まらない。
    // `backend.ts` が `wireApiBaseUrl` を呼ぶ（backend.test.ts が検査する）
    const variables = (
      functionByName(synthed.template, '^kiro-query-impact-measure-') as {
        Properties: { Environment: { Variables: Record<string, unknown> } };
      }
    ).Properties.Environment.Variables;

    expect(variables[ORDER_MEASUREMENT_ENV_KEYS.orderApiBaseUrl]).toBeUndefined();
  });

  it('計測系の環境変数名が実行時側の定数と一致する', () => {
    // IaC から実行時モジュールを import しない代わりに、
    // 文字列の重複をここで突き合わせる（order-monitoring.ts の EMF 定数と同じ方針）
    expect(ORDER_MEASUREMENT_ENV_KEYS.ordersStreamArn).toBe(ORDERS_STREAM_ARN_ENV);
    expect(ORDER_MEASUREMENT_ENV_KEYS.orderApiBaseUrl).toBe(ORDER_API_BASE_URL_ENV);
  });

  it('wireApiBaseUrl が ORDER_API_BASE_URL を query-impact-measure にだけ設定する', () => {
    const stack = new Stack(testApp(), 'amplify-poc-sandbox-2222');
    const tables = new OrderTables(stack, 'OrderTables', { config: config() });
    const functions = new OrderFunctions(stack, 'OrderFunctions', {
      tables,
      config: config(),
    });
    const api = new OrderApi(stack, 'OrderApi', { handlers: functions });
    functions.wireApiBaseUrl(api);

    const template = Template.fromStack(stack);
    const envOf = (pattern: string): Record<string, unknown> =>
      (
        functionByName(template, pattern) as {
          Properties: { Environment: { Variables: Record<string, unknown> } };
        }
      ).Properties.Environment.Variables;

    expect(
      envOf('^kiro-query-impact-measure-')[ORDER_MEASUREMENT_ENV_KEYS.orderApiBaseUrl]
    ).toBeDefined();
    // 他の関数には配らない（計測対象を叩くのはこの関数だけ）
    expect(
      envOf('^kiro-load-generator-')[ORDER_MEASUREMENT_ENV_KEYS.orderApiBaseUrl]
    ).toBeUndefined();
  });

  it('デプロイ済みの値をそのまま渡す（既定値へ読み替えない）', () => {
    const environment = buildParameterEnvironment(
      config({
        ORDER_PAYMENT_DELAY_MS: '10000',
        ORDER_PAYMENT_FAILURE_RATE: '0.25',
        ORDER_STREAM_PARALLELIZATION_FACTOR: '10',
      })
    );

    expect(environment.ORDER_PAYMENT_DELAY_MS).toBe('10000');
    expect(environment.ORDER_PAYMENT_FAILURE_RATE).toBe('0.25');
    expect(environment.ORDER_STREAM_PARALLELIZATION_FACTOR).toBe('10');
    // 未指定の項目は既定値が入る（未設定のまま渡さない）
    expect(environment.ORDER_NOTIFICATION_DELAY_MS).toBe('500');
  });
});

describe('OrderFunctions: IAM 権限（design §5.9）', () => {
  interface PolicyStatementJson {
    Action: string | string[];
    Resource?: unknown;
  }

  /** 指定した関数のロールに付いたポリシーステートメント */
  function statementsOf(roleRef: string): PolicyStatementJson[] {
    return Object.values(synthed.template.findResources('AWS::IAM::Policy'))
      .filter((policy) =>
        ((policy.Properties.Roles ?? []) as { Ref?: string }[]).some(
          (role) => role.Ref === roleRef
        )
      )
      .flatMap(
        (policy) => policy.Properties.PolicyDocument.Statement as PolicyStatementJson[]
      );
  }

  /** 指定した接頭辞のアクションだけを集める */
  function actionsOf(roleRef: string, prefix: string): string[] {
    return statementsOf(roleRef)
      .flatMap((statement) =>
        Array.isArray(statement.Action) ? statement.Action : [statement.Action]
      )
      .filter((action) => action.startsWith(prefix))
      .sort();
  }

  /** 指定した関数のロールに付いた DynamoDB のアクション一覧 */
  function dynamoActionsOf(roleRef: string): string[] {
    return actionsOf(roleRef, 'dynamodb:');
  }

  /** 指定した関数のロールに付いた Lambda のアクション一覧（自己 invoke） */
  function lambdaActionsOf(roleRef: string): string[] {
    return actionsOf(roleRef, 'lambda:');
  }

  /** 関数リソースの Role 参照から、対応するロールの論理 ID を得る */
  function roleRefOf(namePattern: string): string {
    const resource = functionByName(synthed.template, namePattern) as {
      Properties: { Role: { 'Fn::GetAtt': [string, string] } };
    };
    return resource.Properties.Role['Fn::GetAtt'][0];
  }

  it('order-accept は注文テーブルへの PutItem だけを持つ', () => {
    expect(dynamoActionsOf(roleRefOf('^kiro-order-accept-'))).toEqual([
      'dynamodb:PutItem',
    ]);
  });

  it('order-query は Query だけを持ち、書き込み権限を持たない（要件 2.8）', () => {
    expect(dynamoActionsOf(roleRefOf('^kiro-order-query-'))).toEqual(['dynamodb:Query']);
  });

  it('order-query の Query はテーブルと GSI の両方を対象にする', () => {
    const statements = Object.values(synthed.template.findResources('AWS::IAM::Policy'))
      .flatMap(
        (policy) =>
          policy.Properties.PolicyDocument.Statement as {
            Action: string | string[];
            Resource: unknown;
          }[]
      )
      .filter((statement) => statement.Action === 'dynamodb:Query');

    expect(statements).toHaveLength(1);
    const resources = statements[0].Resource as unknown[];
    // 基表 + GSI の 2 つ。`index/*` ではなく GSI 名で限定していることを確かめる
    expect(resources).toHaveLength(2);
    expect(JSON.stringify(resources[1])).toContain(
      `/index/${synthed.tables.ordersCustomerIndexName}`
    );
  });

  it('inventory-seed は在庫テーブルへの書き込みだけを持つ', () => {
    expect(dynamoActionsOf(roleRefOf('^kiro-inventory-seed-'))).toEqual([
      'dynamodb:BatchWriteItem',
      'dynamodb:PutItem',
    ]);
  });

  it('order-processor は UpdateItem と冪等性テーブルの 4 操作だけを持つ', () => {
    // 注文テーブルの読み取り権限を持たないことが重要である。
    // Streams の NewImage から取るため不要であり（design §5.5）、
    // 読み直す実装が入ると処理時間 D が伸びて消費能力の観測がずれる
    expect(dynamoActionsOf(roleRefOf('^kiro-order-processor-'))).toEqual([
      'dynamodb:DeleteItem',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
      'dynamodb:UpdateItem',
    ]);
  });

  it('order-processor の UpdateItem は注文テーブルと在庫テーブルを対象にする', () => {
    const roleRef = roleRefOf('^kiro-order-processor-');
    const statements = Object.values(synthed.template.findResources('AWS::IAM::Policy'))
      .filter((policy) =>
        ((policy.Properties.Roles ?? []) as { Ref?: string }[]).some(
          (role) => role.Ref === roleRef
        )
      )
      .flatMap(
        (policy) =>
          policy.Properties.PolicyDocument.Statement as {
            Action: string | string[];
            Resource: unknown;
          }[]
      )
      .filter((statement) => statement.Action === 'dynamodb:UpdateItem');

    expect(statements).toHaveLength(1);
    const resources = statements[0].Resource as unknown[];
    expect(resources).toHaveLength(2);
    expect(JSON.stringify(resources)).toContain('OrdersTable');
    expect(JSON.stringify(resources)).toContain('InventoryTable');
  });

  it('Streams の読み取り権限を持たない（DynamoEventSource が付与する）', () => {
    const actions = dynamoActionsOf(roleRefOf('^kiro-order-processor-'));

    expect(actions).not.toContain('dynamodb:GetRecords');
    expect(actions).not.toContain('dynamodb:DescribeStream');
  });

  it('load-generator は design §5.9 の 5 つの権限を持つ', () => {
    expect(dynamoActionsOf(roleRefOf('^kiro-load-generator-'))).toEqual([
      'dynamodb:BatchWriteItem',
      'dynamodb:DescribeStream',
      'dynamodb:DescribeTable',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
    ]);
    expect(lambdaActionsOf(roleRefOf('^kiro-load-generator-'))).toEqual([
      'lambda:InvokeFunction',
    ]);
  });

  it('load-generator の DescribeStream はストリーム ARN を対象にする（要件 19.1）', () => {
    // テーブル ARN に対して許可しても DescribeStream は認可されず、
    // 全実行の shard_count_error が AccessDeniedException になる
    const statement = statementsOf(roleRefOf('^kiro-load-generator-')).find(
      (entry) => entry.Action === 'dynamodb:DescribeStream'
    );

    expect(statement).toBeDefined();
    expect(JSON.stringify(statement?.Resource)).toContain('StreamArn');
  });

  it('load-generator は注文テーブルへの書き込みを BatchWriteItem に限る（要件 11.10）', () => {
    const statement = statementsOf(roleRefOf('^kiro-load-generator-')).find(
      (entry) => entry.Action === 'dynamodb:BatchWriteItem'
    );

    expect(statement).toBeDefined();
    expect(JSON.stringify(statement?.Resource)).toContain('OrdersTable');
  });

  it('query-impact-measure はシャード観測と実行レコードの読み書きを持つ', () => {
    // design §5.9 の表は DescribeStream / DescribeTable を load-generator の行にしか
    // 挙げていないが、要件 12.5 が計測結果にシャード数を求めるため付与する。
    // 付与しないと全計測が shard_count_error 付きで完走し、比較表が埋まらない
    expect(dynamoActionsOf(roleRefOf('^kiro-query-impact-measure-'))).toEqual([
      'dynamodb:DescribeStream',
      'dynamodb:DescribeTable',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
    ]);
    expect(lambdaActionsOf(roleRefOf('^kiro-query-impact-measure-'))).toEqual([
      'lambda:InvokeFunction',
    ]);
  });

  it('query-impact-measure は注文テーブルへの書き込み権限を持たない（Property 9）', () => {
    const actions = dynamoActionsOf(roleRefOf('^kiro-query-impact-measure-'));

    expect(actions).not.toContain('dynamodb:BatchWriteItem');
    expect(actions).not.toContain('dynamodb:Query');
  });

  it('自己 invoke の対象は自分自身だけである（要件 11.9 / 12.1）', () => {
    for (const pattern of ['^kiro-load-generator-', '^kiro-query-impact-measure-']) {
      const statement = statementsOf(roleRefOf(pattern)).find(
        (entry) => entry.Action === 'lambda:InvokeFunction'
      );
      const logicalName = pattern.replace(/^\^kiro-|-$/g, '');

      expect(statement, pattern).toBeDefined();
      expect(JSON.stringify(statement?.Resource), pattern).toContain(
        `:function:kiro-${logicalName}-`
      );
    }
  });

  it('execution-status は GetItem だけを持つ（design §5.9）', () => {
    expect(dynamoActionsOf(roleRefOf('^kiro-execution-status-'))).toEqual([
      'dynamodb:GetItem',
    ]);
    expect(lambdaActionsOf(roleRefOf('^kiro-execution-status-'))).toEqual([]);
  });

  it('execution-status の GetItem は実行管理テーブルだけを対象にする', () => {
    const statement = statementsOf(roleRefOf('^kiro-execution-status-')).find(
      (entry) => entry.Action === 'dynamodb:GetItem'
    );

    expect(JSON.stringify(statement?.Resource)).toContain('ExecutionsTable');
    expect(JSON.stringify(statement?.Resource)).not.toContain('OrdersTable');
  });
});

describe('OrderFunctions: 物理関数名', () => {
  it('既定ではスタックごとに異なる（sandbox 間で衝突しない）', () => {
    const namesOf = (stackName: string): string[] => {
      const stack = new Stack(testApp(), stackName);
      const tables = new OrderTables(stack, 'OrderTables', { config: config() });
      new OrderFunctions(stack, 'OrderFunctions', { tables, config: config() });
      return Object.values(Template.fromStack(stack).findResources(FUNCTION_TYPE))
        .map((resource) => resource.Properties?.FunctionName as string)
        .filter((name) => typeof name === 'string')
        .sort();
    };

    expect(namesOf('amplify-poc-alice-aaaa')).not.toEqual(namesOf('amplify-poc-bob-bbbb'));
  });

  it('サフィックスを空にすると design §5.2 の固定名になる', () => {
    const { template } = synth({ functionNameSuffix: '' });

    for (const name of [
      'kiro-order-accept',
      'kiro-order-query',
      'kiro-inventory-seed',
      'kiro-order-processor',
      'kiro-load-generator',
      'kiro-query-impact-measure',
      'kiro-execution-status',
    ]) {
      template.hasResourceProperties(FUNCTION_TYPE, { FunctionName: name });
    }
  });
});
