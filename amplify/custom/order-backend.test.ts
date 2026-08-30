import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ORDER_API_BASE_URL_ENV } from '../functions/query-impact-measure/query-target.js';
import { OrderAlarms } from './order-alarms.js';
import { ORDER_API_ROUTES, OrderApi } from './order-api.js';
import { OrderFunctions } from './order-functions.js';
import { OrderMonitoring } from './order-monitoring.js';
import { OrderStream } from './order-stream.js';
import { OrderTables } from './order-tables.js';
import { testApp } from './test-app.js';
import { resolveVerificationConfig } from './verification-config.js';

/**
 * PoC スタック全体の合成テスト（`backend.ts` の配線に対応する。タスク 20）。
 *
 * ## なぜ Construct 単位のテストだけでは足りないのか
 *
 * 各 Construct のテストは自分の担当リソースしか合成しない。ところがタスク 20 で
 * 増えた配線の危険は**Construct 間の参照の向き**にある。とくに
 * `query-impact-measure` は自分が属する API のベース URL を環境変数で受け取るため
 * （design 論点 3）、Lambda → API の参照が生まれる。API は各 Lambda を統合先として
 * 参照しているので、参照の作り方を誤ると循環になる。
 *
 * ## 循環を 2 段で検出する
 *
 * `App.synth()` 単体は `Ref` / `Fn::GetAtt` による循環を検出しない
 * （検出するのは Construct 間の依存の循環だけ）。素の合成スクリプトで確認しても
 * **デプロイで初めて `Circular dependency between resources` になる**類の
 * 誤りが残る。このリポジトリはデプロイを伴う確認をタスク 13 以降に分けているため、
 * 参照の誤りはここで止めなければならない。
 *
 * 1. `Template.fromStack` が `Template is undeployable, these resources have a
 *    dependency cycle` を投げる（モジュール読み込みの時点で全テストが落ちる）
 * 2. 下の `findCycle` が同じ検査を名前の付いたテストとして行い、循環の経路を出す
 *
 * 2 が 1 と重複しているのは意図的である。1 だけだとファイル全体が
 * 「テストが 1 つも実行されない」形で落ち、原因が配線にあることが読み取れない。
 */

const CONFIG = resolveVerificationConfig({ env: {}, onWarning: null });

/** `backend.ts` と同じ順序・同じ props で全 Construct を組む */
function synthBackend() {
  const stack = new Stack(testApp(), 'amplify-poc-sandbox-1111', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
  });

  const tables = new OrderTables(stack, 'OrderTables', { config: CONFIG });
  const functions = new OrderFunctions(stack, 'OrderFunctions', {
    tables,
    config: CONFIG,
  });
  const api = new OrderApi(stack, 'OrderApi', { handlers: functions });
  functions.wireApiBaseUrl(api);

  const stream = new OrderStream(stack, 'OrderStream', {
    tables,
    processor: functions.orderProcessor,
    config: CONFIG,
  });

  new OrderMonitoring(stack, 'OrderMonitoring', {
    functions,
    tables,
    api: api.api,
    deadLetterQueue: stream.deadLetterQueue,
  });

  const alarms = new OrderAlarms(stack, 'OrderAlarms', {
    functions,
    tables,
    deadLetterQueue: stream.deadLetterQueue,
  });

  return { stack, tables, functions, api, stream, alarms, template: Template.fromStack(stack) };
}

const synthed = synthBackend();

/** テンプレート内の参照（`Ref` / `Fn::GetAtt` / `DependsOn`）を辿るグラフ */
function referenceGraph(template: Template): Map<string, Set<string>> {
  const resources = template.toJSON().Resources as Record<string, unknown>;
  const logicalIds = new Set(Object.keys(resources));
  const graph = new Map<string, Set<string>>();

  const collect = (node: unknown, into: Set<string>): void => {
    if (Array.isArray(node)) {
      for (const item of node) collect(item, into);
      return;
    }
    if (node === null || typeof node !== 'object') return;

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      // 疑似パラメータ（AWS::URLSuffix など）とテンプレートパラメータは
      // Resources に無いので自然に除かれる
      if (key === 'Ref' && typeof value === 'string' && logicalIds.has(value)) {
        into.add(value);
        continue;
      }
      if (key === 'Fn::GetAtt' && Array.isArray(value) && typeof value[0] === 'string') {
        if (logicalIds.has(value[0])) into.add(value[0]);
        continue;
      }
      collect(value, into);
    }
  };

  for (const [logicalId, resource] of Object.entries(resources)) {
    const edges = new Set<string>();
    const { DependsOn, ...rest } = resource as { DependsOn?: unknown };

    collect(rest, edges);
    for (const dependency of toArray(DependsOn)) {
      if (typeof dependency === 'string' && logicalIds.has(dependency)) {
        edges.add(dependency);
      }
    }
    edges.delete(logicalId);
    graph.set(logicalId, edges);
  }

  return graph;
}

function toArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** 循環があれば経路を返す（先頭と末尾が同じ論理 ID になる） */
function findCycle(graph: Map<string, Set<string>>): string[] | undefined {
  const visited = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();

  const walk = (node: string): string[] | undefined => {
    visited.add(node);
    stack.push(node);
    onStack.add(node);

    for (const next of graph.get(node) ?? []) {
      if (onStack.has(next)) {
        return [...stack.slice(stack.indexOf(next)), next];
      }
      if (!visited.has(next)) {
        const cycle = walk(next);
        if (cycle !== undefined) return cycle;
      }
    }

    stack.pop();
    onStack.delete(node);
    return undefined;
  };

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      const cycle = walk(node);
      if (cycle !== undefined) return cycle;
    }
  }
  return undefined;
}

/** 物理名の接頭辞で Lambda リソースの論理 ID を引く */
function functionLogicalId(namePattern: string): string {
  const matches = Object.entries(synthed.template.findResources('AWS::Lambda::Function'))
    .filter(([, resource]) =>
      new RegExp(namePattern).test(resource.Properties?.FunctionName as string)
    )
    .map(([logicalId]) => logicalId);

  expect(matches, namePattern).toHaveLength(1);
  return matches[0];
}

describe('PoC スタック全体: 合成（タスク 20）', () => {
  it('全 Construct を配線しても合成できる', () => {
    expect(Object.keys(synthed.template.toJSON().Resources as object).length).toBeGreaterThan(
      0
    );
  });

  it('リソース間の参照に循環が無い（デプロイ時の Circular dependency を防ぐ）', () => {
    const cycle = findCycle(referenceGraph(synthed.template));

    expect(cycle, `循環参照: ${cycle?.join(' -> ') ?? ''}`).toBeUndefined();
  });

  it('design §5.2 の 7 関数と design §5.8 の 9 ルートが揃う', () => {
    synthed.template.resourceCountIs('AWS::Lambda::Function', 7);

    const methods = Object.values(synthed.template.findResources('AWS::ApiGateway::Method'));
    const nonPreflight = methods.filter(
      (method) => method.Properties.HttpMethod !== 'OPTIONS'
    );
    expect(nonPreflight).toHaveLength(ORDER_API_ROUTES.length);
  });

  it('観測装置（ダッシュボード・アラーム・SNS）を作る（design §6）', () => {
    synthed.template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    synthed.template.resourceCountIs('AWS::SNS::Topic', 1);
    // design §6.2 の 8 本（DynamoDB 書き込みスロットルは基表と GSI で 2 本）
    synthed.template.resourceCountIs('AWS::CloudWatch::Alarm', 8);
    expect(synthed.alarms.topicArn).toBeTruthy();
  });

  it('Streams のイベントソースマッピングと DLQ を 1 組だけ作る（design §5.6）', () => {
    synthed.template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
    synthed.template.resourceCountIs('AWS::SQS::Queue', 1);
  });
});

describe('PoC スタック全体: 計測系の環境変数（design 論点 3）', () => {
  it('query-impact-measure に ORDER_API_BASE_URL が入る', () => {
    // `backend.ts` が `wireApiBaseUrl` を呼び忘れると、計測の開始要求が
    // OrderApiBaseUrlError で 500 になる（デプロイするまで気づけない）
    const resource = synthed.template.findResources('AWS::Lambda::Function')[
      functionLogicalId('^kiro-query-impact-measure-')
    ] as { Properties: { Environment: { Variables: Record<string, unknown> } } };

    expect(resource.Properties.Environment.Variables[ORDER_API_BASE_URL_ENV]).toBeDefined();
  });

  it('ベース URL がステージリソースを参照しない（api.url との違い）', () => {
    // `Stage` の `stageName` は CfnStage の Ref である。したがって `api.url` は
    // ステージリソースを参照し、Lambda の環境変数に渡すと
    // Lambda → Stage → Deployment → Method → Lambda の循環になる。
    // `urlForLambdaEnvironment` は RestApi 自身だけを参照する
    const stageLogicalIds = Object.keys(
      synthed.template.findResources('AWS::ApiGateway::Stage')
    );
    const forEnvironment = JSON.stringify(
      synthed.stack.resolve(synthed.api.urlForLambdaEnvironment)
    );
    const forOutput = JSON.stringify(synthed.stack.resolve(synthed.api.url));

    expect(stageLogicalIds).toHaveLength(1);
    for (const stageLogicalId of stageLogicalIds) {
      expect(forEnvironment).not.toContain(stageLogicalId);
      // 出力用の `url` は参照する。だから環境変数には使えない
      expect(forOutput).toContain(stageLogicalId);
    }
  });
});
