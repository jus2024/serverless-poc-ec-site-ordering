import { Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import { describe, expect, it } from 'vitest';
import { EXECUTION_STATUS_RESOURCE } from '../functions/execution-status/routes.js';
import { CORS_HEADERS } from '../functions/shared/http.js';
import { ORDER_QUERY_RESOURCES } from '../functions/order-query/routes.js';
import {
  ORDER_API_CORS,
  ORDER_API_ROUTES,
  ORDER_API_STAGE_NAME,
  OrderApi,
  type OrderApiHandlers,
} from './order-api.js';
import { testApp } from './test-app.js';

/**
 * 合成結果の検証のみを行う（AWS へは接続しない）。
 *
 * ハンドラは素の `Function` で代用する。ここで検証したいのは
 * ルートの配線と CORS / トレーシングの設定であり、`NodejsFunction` の
 * バンドル（esbuild の実行）は必要ない。
 */
function synth() {
  const stack = new Stack(testApp(), 'amplify-poc-sandbox-1111');
  const handler = (id: string) =>
    new LambdaFunction(stack, id, {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromInline('exports.handler = async () => ({});'),
    });

  const handlers: OrderApiHandlers = {
    orderAccept: handler('OrderAccept'),
    orderQuery: handler('OrderQuery'),
    inventorySeed: handler('InventorySeed'),
    loadGenerator: handler('LoadGenerator'),
    queryImpactMeasure: handler('QueryImpactMeasure'),
    executionStatus: handler('ExecutionStatus'),
  };
  const api = new OrderApi(stack, 'OrderApi', { handlers });

  return { stack, api, handlers, template: Template.fromStack(stack) };
}

const synthed = synth();

/** 合成済みのメソッド定義を `METHOD /path` の一覧に畳む */
function routeSummary(template: Template): string[] {
  const resources = template.findResources('AWS::ApiGateway::Resource');
  const methods = template.findResources('AWS::ApiGateway::Method');

  /** リソースの論理 ID → パス（親を辿って組み立てる） */
  const pathOf = (logicalId: string): string => {
    const resource = resources[logicalId];
    const part = resource.Properties.PathPart as string;
    const parent = resource.Properties.ParentId as { Ref?: string };
    // 親が Fn::GetAtt（ルート）ならそこで終わり
    return parent.Ref === undefined ? `/${part}` : `${pathOf(parent.Ref)}/${part}`;
  };

  return Object.values(methods)
    .map((method) => {
      const resourceId = (method.Properties.ResourceId as { Ref?: string }).Ref;
      const path = resourceId === undefined ? '' : pathOf(resourceId);
      return `${method.Properties.HttpMethod as string} ${path === '' ? '/' : path}`;
    })
    .sort();
}

describe('OrderApi: ルート（design §5.8）', () => {
  it('design §5.8 の 9 ルートをすべて定義する', () => {
    expect(ORDER_API_ROUTES.map((route) => `${route.method} ${route.path}`).sort()).toEqual(
      [
        'GET /catalog',
        'GET /config',
        'GET /executions/{executionId}',
        'GET /orders',
        'GET /orders/{orderId}',
        'POST /inventory/seed',
        'POST /load-test/start',
        'POST /measure/start',
        'POST /orders',
      ]
    );
  });

  it('計測系のルートが design §5.8 の Lambda に向く', () => {
    const handlerOf = (method: string, path: string) =>
      ORDER_API_ROUTES.find((route) => route.method === method && route.path === path)
        ?.handler;

    expect(handlerOf('POST', '/load-test/start')).toBe('loadGenerator');
    expect(handlerOf('POST', '/measure/start')).toBe('queryImpactMeasure');
    expect(handlerOf('GET', '/executions/{executionId}')).toBe('executionStatus');
  });

  it('execution-status のルート定義（routes.ts）と一致する', () => {
    // ハンドラ側は `/executions/{executionId}` を前提にパスパラメータを取り出す。
    // 片方だけを変えると実行 ID が取れず 400 になる
    const wired = ORDER_API_ROUTES.filter(
      (route) => route.handler === 'executionStatus'
    ).map((route) => route.path);

    expect(wired).toEqual([EXECUTION_STATUS_RESOURCE]);
  });

  it('1 つの関数に 2 つ以上の POST を相乗りさせていない（計測系）', () => {
    // 負荷生成と並行計測は別の関数である（design §5.2）。同じ関数に寄せると
    // 投入と計測が同じ同時実行枠を食い、要件 11.10 の前提が崩れる
    const posts = ORDER_API_ROUTES.filter((route) => route.method === 'POST');
    const handlers = posts.map((route) => route.handler);

    expect(new Set(handlers).size).toBe(posts.length);
  });

  it('合成結果に定義どおりのメソッドが並ぶ', () => {
    const summary = routeSummary(synthed.template);

    for (const route of ORDER_API_ROUTES) {
      expect(summary, `${route.method} ${route.path} が無い`).toContain(
        `${route.method} ${route.path}`
      );
    }
  });

  it('order-query のルート定義（routes.ts）と一致する', () => {
    // 片方だけを増やすと、API Gateway が Lambda に渡すのに
    // ハンドラ側が UnroutableRequestError で 500 を返す状態になる
    const wired = new Set(
      ORDER_API_ROUTES.filter((route) => route.handler === 'orderQuery').map(
        (route) => route.path
      )
    );

    expect(wired).toEqual(new Set(Object.values(ORDER_QUERY_RESOURCES)));
  });

  it('POST /orders は order-accept、GET /orders は order-query に向く', () => {
    const byPath = (method: string, path: string) =>
      ORDER_API_ROUTES.find((route) => route.method === method && route.path === path);

    expect(byPath('POST', '/orders')?.handler).toBe('orderAccept');
    expect(byPath('GET', '/orders')?.handler).toBe('orderQuery');
    expect(byPath('POST', '/inventory/seed')?.handler).toBe('inventorySeed');
  });

  it('すべてのメソッドが Lambda プロキシ統合である', () => {
    for (const [logicalId, method] of Object.entries(
      synthed.template.findResources('AWS::ApiGateway::Method')
    )) {
      const integration = method.Properties.Integration as {
        Type: string;
        IntegrationHttpMethod?: string;
      };
      if (method.Properties.HttpMethod === 'OPTIONS') {
        // CORS プリフライトは MOCK 統合（CDK が生成する）
        expect(integration.Type, logicalId).toBe('MOCK');
        continue;
      }
      expect(integration.Type, logicalId).toBe('AWS_PROXY');
      expect(integration.IntegrationHttpMethod, logicalId).toBe('POST');
    }
  });
});

describe('OrderApi: CORS（design §5.8 / §E-1）', () => {
  it('全オリジンを許可する（検証用の割り切り）', () => {
    expect(ORDER_API_CORS.allowOrigins).toEqual(['*']);
  });

  it('プリフライトの許可内容が shared/http.ts の実応答ヘッダーと一致する', () => {
    // 食い違うと、ブラウザ側では原因の分からない CORS エラーになる
    expect(ORDER_API_CORS.allowOrigins.join(',')).toBe(
      CORS_HEADERS['Access-Control-Allow-Origin']
    );
    expect(ORDER_API_CORS.allowMethods.join(',')).toBe(
      CORS_HEADERS['Access-Control-Allow-Methods']
    );
    expect(ORDER_API_CORS.allowHeaders.join(',')).toBe(
      CORS_HEADERS['Access-Control-Allow-Headers']
    );
  });

  it('すべてのリソースに OPTIONS を張る（エラー応答も読めるようにする）', () => {
    const summary = routeSummary(synthed.template);
    const paths = new Set(
      summary
        .filter((entry) => entry.startsWith('OPTIONS '))
        .map((entry) => entry.slice('OPTIONS '.length))
    );

    for (const route of ORDER_API_ROUTES) {
      expect(paths, `${route.path} に OPTIONS が無い`).toContain(route.path);
    }
  });
});

describe('OrderApi: ステージとエンドポイント', () => {
  it('X-Ray トレーシングを有効にする（要件 13.4）', () => {
    synthed.template.hasResourceProperties('AWS::ApiGateway::Stage', {
      StageName: 'poc',
      TracingEnabled: true,
    });
  });

  it('実行ログを有効にしない（アカウント単位のロール設定を前提にしないため）', () => {
    synthed.template.hasResourceProperties('AWS::ApiGateway::Stage', {
      MethodSettings: Match.absent(),
      AccessLogSetting: Match.absent(),
    });
  });

  it('リージョナルエンドポイントである（CloudFront の遅延を測定に混ぜない）', () => {
    synthed.template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      EndpointConfiguration: { Types: ['REGIONAL'] },
    });
  });

  it('ベース URL を公開する（要件 14.10 の出典）', () => {
    expect(synthed.api.url).toBeTruthy();
  });

  it('ステージ名の既定は poc（検証専用）', () => {
    expect(ORDER_API_STAGE_NAME).toBe('poc');
    expect(synthed.api.stageName).toBe('poc');
  });
});

describe('OrderApi: Lambda へ渡すベース URL（design 論点 3）', () => {
  it('Stage / Deployment を経由しない（循環参照を作らない）', () => {
    // `api.url` は Stage を参照する。それを Lambda の環境変数に渡すと
    // RestApi.url → Stage → Deployment → Method → Lambda → env → url の循環になる。
    // `urlForLambdaEnvironment` は RestApi 自身（restApiId）だけを参照する
    const resolved = synthed.stack.resolve(synthed.api.urlForLambdaEnvironment);
    const serialized = JSON.stringify(resolved);

    expect(serialized).toContain('OrderApiRestApi');
    expect(serialized).toContain('execute-api');
    expect(serialized).toContain(`/${synthed.api.stageName}`);
    expect(serialized).not.toContain('Stage');
    expect(serialized).not.toContain('Deployment');
  });

  it('末尾にスラッシュを付けない（query-target.ts が正規化する形と揃える）', () => {
    const stack = new Stack(testApp(), 'amplify-poc-region-2222', {
      env: { account: '123456789012', region: 'ap-northeast-1' },
    });
    const handler = new LambdaFunction(stack, 'Handler', {
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromInline('exports.handler = async () => ({});'),
    });
    const api = new OrderApi(stack, 'OrderApi', {
      handlers: {
        orderAccept: handler,
        orderQuery: handler,
        inventorySeed: handler,
        loadGenerator: handler,
        queryImpactMeasure: handler,
        executionStatus: handler,
      },
    });

    // リージョンが確定している環境ではリージョン名が素の文字列に解決される
    // （URL サフィックスは `AWS::URLSuffix` の参照のまま。中国リージョンで
    // `amazonaws.com.cn` になるため文字列で埋めない）
    const serialized = JSON.stringify(stack.resolve(api.urlForLambdaEnvironment));

    expect(serialized).toContain('.execute-api.ap-northeast-1.');
    expect(serialized).toContain('AWS::URLSuffix');
    expect(serialized).toContain('/poc');
    expect(serialized).not.toContain('/poc/');
  });
});

describe('OrderApi: 認証（design §8）', () => {
  it('認証を掛けていない（スコープ外。公開環境に常設してはならない）', () => {
    for (const [logicalId, method] of Object.entries(
      synthed.template.findResources('AWS::ApiGateway::Method')
    )) {
      expect(method.Properties.AuthorizationType, logicalId).toBe('NONE');
      expect(method.Properties.ApiKeyRequired ?? false, logicalId).toBe(false);
    }
  });
});
