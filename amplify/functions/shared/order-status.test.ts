import { describe, expect, it } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  StagePreconditionError,
  advanceOrderStage,
  areAllStagesDone,
  buildStageProgress,
  buildStageUpdateCommandInput,
  resolveEndToEndMs,
  resolveOrderStatus,
} from './order-status.js';
import { ORDER_STAGES, type OrderRecord, type OrderStage, type StageResult } from './types.js';

/**
 * 段階完了の記録の単体テスト（design §5.4 / §E-2、Property 1 / 2 / 4）。
 *
 * 検証の主眼は 4 点。
 *
 * 1. 1 段階の記録が **1 回の `UpdateItem`** に収まり、更新式が design §5.4 のとおりであること
 * 2. 条件式が二重加算を防ぎ（Property 1）、`COMPLETED` に全段階完了を要求すること（Property 4）
 * 3. 条件失敗が「処理済み」と「前提条件未達」で区別されること
 * 4. 段階進捗と経過時間が段階属性から正しく算出されること（要件 2.5 / 2.6）
 *
 * `buildStageUpdateCommandInput` は純粋関数なので AWS クライアントを必要としない。
 */

const TABLE = 'kiro-roasters-orders';
const ORDER_ID = 'ORD#01J000000000000000000000';
const CUSTOMER_ID = 'CUST#test-0001';
const NOW = '2025-01-01T00:00:10.000Z';

/** 更新入力の組み立て（既定値つき） */
function buildInput(
  stage: OrderStage,
  result: StageResult,
  extra: { failureReason?: string; pointEarned?: number } = {}
): UpdateCommandInput {
  return buildStageUpdateCommandInput({
    tableName: TABLE,
    orderId: ORDER_ID,
    customerId: CUSTOMER_ID,
    stage,
    result,
    now: NOW,
    ...extra,
  });
}

/** 更新式と条件式を 1 つの文字列にまとめる（トークンの参照有無を調べるため） */
function expressionText(input: UpdateCommandInput): string {
  return `${input.UpdateExpression ?? ''} ${input.ConditionExpression ?? ''}`;
}

/** 注文レコードの雛形 */
function orderRecord(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    order_id: ORDER_ID,
    customer_id: CUSTOMER_ID,
    order_status: 'PENDING',
    items: [{ sku: 'ITEM#ETH-YIRG-G1-MEDIUM-200G', qty: 1, price: 1800 }],
    total_amount: 1800,
    point_earned: 0,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    stages_done: 0,
    pipeline_mode: 'direct',
    expires_at: 1_767_225_600,
    ...overrides,
  };
}

/** 全段階が DONE の注文（完了時刻は 1 秒刻み） */
function completedOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return orderRecord({
    order_status: 'COMPLETED',
    stages_done: 4,
    payment_status: 'DONE',
    payment_at: '2025-01-01T00:00:03.000Z',
    allocation_status: 'DONE',
    allocation_at: '2025-01-01T00:00:04.000Z',
    notification_status: 'DONE',
    notification_at: '2025-01-01T00:00:05.000Z',
    point_status: 'DONE',
    point_at: '2025-01-01T00:00:06.000Z',
    ...overrides,
  });
}

describe('buildStageUpdateCommandInput: 更新式（design §5.4）', () => {
  const input = buildInput('payment', 'DONE');

  it('キーとテーブル名を design §4.2 のキー設計どおりに指定する', () => {
    expect(input.TableName).toBe(TABLE);
    expect(input.Key).toEqual({ order_id: ORDER_ID, customer_id: CUSTOMER_ID });
  });

  it('段階属性・完了時刻・updated_at・order_status・stages_done を 1 回で更新する', () => {
    expect(input.UpdateExpression).toBe(
      'SET #stageStatus = :stageResult, #stageAt = :now, updated_at = :now, ' +
        'order_status = :orderStatus, stages_done = if_not_exists(stages_done, :zero) + :one'
    );
  });

  it('段階属性名を実行時の段階から解決する', () => {
    expect(input.ExpressionAttributeNames).toEqual({
      '#stageStatus': 'payment_status',
      '#stageAt': 'payment_at',
    });
  });

  it('段階完了時刻と updated_at に同じ時刻を使う（1 つの :now を共有する）', () => {
    expect(input.ExpressionAttributeValues?.[':now']).toBe(NOW);
    expect(input.UpdateExpression).toContain('#stageAt = :now');
    expect(input.UpdateExpression).toContain('updated_at = :now');
  });

  it('stages_done を if_not_exists で加算する（属性が無い注文でも 1 になる。Property 1）', () => {
    expect(input.UpdateExpression).toContain(
      'stages_done = if_not_exists(stages_done, :zero) + :one'
    );
    expect(input.ExpressionAttributeValues?.[':zero']).toBe(0);
    expect(input.ExpressionAttributeValues?.[':one']).toBe(1);
  });

  it('更新後のレコードを返させる（呼び出し側が再読み込みしないため）', () => {
    expect(input.ReturnValues).toBe('ALL_NEW');
  });

  it('指定がなければ failure_reason と point_earned を触らない', () => {
    expect(input.UpdateExpression).not.toContain('failure_reason');
    expect(input.UpdateExpression).not.toContain('point_earned');
  });
});

describe('buildStageUpdateCommandInput: ステータス遷移（要件 8.5 / design §E-2）', () => {
  const successStatuses: Array<[OrderStage, string]> = [
    ['payment', 'PAID'],
    ['allocation', 'ALLOCATED'],
    ['notification', 'NOTIFIED'],
    ['point', 'COMPLETED'],
  ];

  for (const [stage, status] of successStatuses) {
    it(`${stage} の成功で order_status = ${status} を書く`, () => {
      const input = buildInput(stage, 'DONE');
      expect(input.ExpressionAttributeValues?.[':orderStatus']).toBe(status);
      expect(input.ExpressionAttributeValues?.[':stageResult']).toBe('DONE');
    });
  }

  it('決済の失敗で PAYMENT_FAILED と failure_reason を書く', () => {
    const input = buildInput('payment', 'FAILED', { failureReason: '決済が拒否されました' });
    expect(input.ExpressionAttributeValues?.[':orderStatus']).toBe('PAYMENT_FAILED');
    expect(input.ExpressionAttributeValues?.[':stageResult']).toBe('FAILED');
    expect(input.UpdateExpression).toContain('failure_reason = :failureReason');
    expect(input.ExpressionAttributeValues?.[':failureReason']).toBe('決済が拒否されました');
  });

  it('引当の失敗で ALLOCATION_FAILED を書く', () => {
    const input = buildInput('allocation', 'FAILED', { failureReason: '在庫不足' });
    expect(input.ExpressionAttributeValues?.[':orderStatus']).toBe('ALLOCATION_FAILED');
  });

  it('通知の失敗では order_status を変えない（専用の失敗ステータスが無い）', () => {
    const input = buildInput('notification', 'FAILED', { failureReason: 'タイムアウト' });
    expect(input.UpdateExpression).not.toContain('order_status');
    expect(input.ExpressionAttributeValues).not.toHaveProperty(':orderStatus');
    // 失敗の事実は段階属性と failure_reason に残る
    expect(input.ExpressionAttributeValues?.[':stageResult']).toBe('FAILED');
    expect(input.UpdateExpression).toContain('failure_reason = :failureReason');
  });

  it('ポイント付与の失敗でも order_status を変えない', () => {
    const input = buildInput('point', 'FAILED', { failureReason: 'タイムアウト' });
    expect(input.ExpressionAttributeValues).not.toHaveProperty(':orderStatus');
  });

  it('付与ポイントを指定したときだけ point_earned を書く（要件 7.5）', () => {
    const input = buildInput('point', 'DONE', { pointEarned: 18 });
    expect(input.UpdateExpression).toContain('point_earned = :pointEarned');
    expect(input.ExpressionAttributeValues?.[':pointEarned']).toBe(18);
  });

  it('付与ポイント 0 も明示値として書く（未指定と区別する）', () => {
    const input = buildInput('point', 'DONE', { pointEarned: 0 });
    expect(input.ExpressionAttributeValues?.[':pointEarned']).toBe(0);
  });
});

describe('buildStageUpdateCommandInput: 条件式（Property 1 / 4）', () => {
  it('段階属性が存在しないことを条件にする（二重加算の防止。要件 8.3）', () => {
    for (const stage of ORDER_STAGES) {
      expect(buildInput(stage, 'FAILED').ConditionExpression).toBe(
        'attribute_not_exists(#stageStatus)'
      );
    }
  });

  it('決済・引当・通知の成功では条件を追加しない', () => {
    for (const stage of ['payment', 'allocation', 'notification'] as const) {
      expect(buildInput(stage, 'DONE').ConditionExpression).toBe(
        'attribute_not_exists(#stageStatus)'
      );
    }
  });

  it('COMPLETED は他 3 段階の DONE を条件にする（Property 4 / 要件 8.4）', () => {
    const input = buildInput('point', 'DONE');
    expect(input.ConditionExpression).toBe(
      'attribute_not_exists(#stageStatus) AND payment_status = :done ' +
        'AND allocation_status = :done AND notification_status = :done'
    );
    expect(input.ExpressionAttributeValues?.[':done']).toBe('DONE');
  });

  it('COMPLETED の条件に自段階（point_status）の等値比較を含めない', () => {
    // 自段階は attribute_not_exists で見るため、= :done を足すと必ず矛盾する
    expect(buildInput('point', 'DONE').ConditionExpression).not.toContain(
      'point_status = :done'
    );
  });

  it('ポイント段階の失敗には他段階の条件を付けない（失敗の記録を妨げないため）', () => {
    const input = buildInput('point', 'FAILED', { failureReason: 'タイムアウト' });
    expect(input.ConditionExpression).toBe('attribute_not_exists(#stageStatus)');
    expect(input.ExpressionAttributeValues).not.toHaveProperty(':done');
  });
});

describe('buildStageUpdateCommandInput: 式とプレースホルダの整合', () => {
  // DynamoDB は未使用の ExpressionAttributeNames / Values を
  // ValidationException で拒否する。段階 × 結果の全組み合わせで検査する。
  const cases = ORDER_STAGES.flatMap((stage) =>
    (['DONE', 'FAILED'] as const).map((result) => ({ stage, result }))
  );

  for (const { stage, result } of cases) {
    it(`${stage} / ${result}: 宣言したプレースホルダをすべて参照する`, () => {
      const input = buildInput(stage, result, {
        failureReason: result === 'FAILED' ? '理由' : undefined,
        pointEarned: stage === 'point' && result === 'DONE' ? 18 : undefined,
      });
      const text = expressionText(input);
      const referencedNames = new Set(text.match(/#[A-Za-z0-9_]+/g) ?? []);
      const referencedValues = new Set(text.match(/:[A-Za-z0-9_]+/g) ?? []);

      expect([...referencedNames].sort()).toEqual(
        Object.keys(input.ExpressionAttributeNames ?? {}).sort()
      );
      expect([...referencedValues].sort()).toEqual(
        Object.keys(input.ExpressionAttributeValues ?? {}).sort()
      );
    });
  }
});

describe('resolveOrderStatus', () => {
  it('成功時は要件 8.5 の順序どおりのステータスを返す', () => {
    expect(resolveOrderStatus('payment', 'DONE')).toBe('PAID');
    expect(resolveOrderStatus('allocation', 'DONE')).toBe('ALLOCATED');
    expect(resolveOrderStatus('notification', 'DONE')).toBe('NOTIFIED');
    expect(resolveOrderStatus('point', 'DONE')).toBe('COMPLETED');
  });

  it('失敗時は design §E-2 のとおり（通知・ポイントは null）', () => {
    expect(resolveOrderStatus('payment', 'FAILED')).toBe('PAYMENT_FAILED');
    expect(resolveOrderStatus('allocation', 'FAILED')).toBe('ALLOCATION_FAILED');
    expect(resolveOrderStatus('notification', 'FAILED')).toBeNull();
    expect(resolveOrderStatus('point', 'FAILED')).toBeNull();
  });
});

describe('areAllStagesDone', () => {
  it('4 段階すべてが DONE なら true', () => {
    expect(areAllStagesDone(completedOrder())).toBe(true);
  });

  it('1 段階でも未完了なら false', () => {
    expect(areAllStagesDone(completedOrder({ point_status: undefined }))).toBe(false);
  });

  it('FAILED は DONE として数えない（Property 3）', () => {
    expect(areAllStagesDone(completedOrder({ notification_status: 'FAILED' }))).toBe(false);
  });

  it('段階属性を持たない注文は false', () => {
    expect(areAllStagesDone(orderRecord())).toBe(false);
  });
});

describe('buildStageProgress: 段階進捗（要件 2.5）', () => {
  it('4 段階を design の順序で返す', () => {
    expect(buildStageProgress(orderRecord()).map((p) => p.stage)).toEqual([
      'payment',
      'allocation',
      'notification',
      'point',
    ]);
  });

  it('未完了の段階は WAITING で完了時刻と経過時間を持たない', () => {
    expect(buildStageProgress(orderRecord())).toEqual([
      { stage: 'payment', status: 'WAITING', completedAt: null, elapsedMs: null },
      { stage: 'allocation', status: 'WAITING', completedAt: null, elapsedMs: null },
      { stage: 'notification', status: 'WAITING', completedAt: null, elapsedMs: null },
      { stage: 'point', status: 'WAITING', completedAt: null, elapsedMs: null },
    ]);
  });

  it('注文作成から各段階の完了までの経過時間を返す', () => {
    expect(buildStageProgress(completedOrder()).map((p) => p.elapsedMs)).toEqual([
      3000, 4000, 5000, 6000,
    ]);
  });

  it('失敗した段階の結果をそのまま返す', () => {
    const progress = buildStageProgress(
      orderRecord({
        order_status: 'PAYMENT_FAILED',
        payment_status: 'FAILED',
        payment_at: '2025-01-01T00:00:02.000Z',
        stages_done: 1,
      })
    );
    expect(progress[0]).toEqual({
      stage: 'payment',
      status: 'FAILED',
      completedAt: '2025-01-01T00:00:02.000Z',
      elapsedMs: 2000,
    });
    expect(progress[1].status).toBe('WAITING');
  });

  it('created_at が解釈できない注文では経過時間を null にする（完了時刻は残す）', () => {
    const progress = buildStageProgress(completedOrder({ created_at: 'broken' }));
    expect(progress.every((p) => p.elapsedMs === null)).toBe(true);
    expect(progress[0].completedAt).toBe('2025-01-01T00:00:03.000Z');
  });
});

describe('resolveEndToEndMs: 全段階完了までの経過時間（要件 2.6）', () => {
  it('最後に完了した段階の時刻から算出する', () => {
    expect(resolveEndToEndMs(completedOrder())).toBe(6000);
  });

  it('完了順が入れ替わっても最大値を使う（実行順に依存しない）', () => {
    // ポイント段階が通知より先に終わったケース。最後は notification_at（5 秒）
    const order = completedOrder({ point_at: '2025-01-01T00:00:04.500Z' });
    expect(resolveEndToEndMs(order)).toBe(5000);
  });

  it('未完了なら null（要件 2.6）', () => {
    expect(resolveEndToEndMs(orderRecord())).toBeNull();
    expect(resolveEndToEndMs(completedOrder({ point_status: undefined }))).toBeNull();
  });

  it('失敗を含む注文は完了しないため null', () => {
    expect(resolveEndToEndMs(completedOrder({ point_status: 'FAILED' }))).toBeNull();
  });

  it('時刻が解釈できない場合は null', () => {
    expect(resolveEndToEndMs(completedOrder({ created_at: 'broken' }))).toBeNull();
    expect(resolveEndToEndMs(completedOrder({ point_at: 'broken' }))).toBeNull();
  });
});

// ─── advanceOrderStage: 送信と条件失敗の扱い ────────────────────────
//
// DynamoDB への接続は行わない。`send` だけを差し替えた最小の代役を使い、
// 「何回・どのコマンドを送るか」と条件失敗の分岐を検証する。

interface FakeDocClient {
  client: DynamoDBDocumentClient;
  sent: unknown[];
}

function fakeDocClient(handlers: {
  update: () => unknown;
  get?: () => unknown;
}): FakeDocClient {
  const sent: unknown[] = [];
  const client = {
    send(command: unknown) {
      sent.push(command);
      if (command instanceof GetCommand) {
        if (handlers.get === undefined) {
          throw new Error('GetCommand は期待していません');
        }
        return Promise.resolve(handlers.get());
      }
      return Promise.resolve(handlers.update());
    },
  };
  return { client: client as unknown as DynamoDBDocumentClient, sent };
}

function conditionalCheckFailed(): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({
    $metadata: {},
    message: 'The conditional request failed',
  });
}

describe('advanceOrderStage: 通常経路', () => {
  it('UpdateItem を 1 回だけ送り、更新後のレコードを返す', async () => {
    const updated = completedOrder({ order_status: 'PAID' });
    const fake = fakeDocClient({ update: () => ({ Attributes: updated }) });

    const result = await advanceOrderStage({
      docClient: fake.client,
      tableName: TABLE,
      orderId: ORDER_ID,
      customerId: CUSTOMER_ID,
      stage: 'payment',
      result: 'DONE',
      now: NOW,
    });

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toBeInstanceOf(UpdateCommand);
    expect(result).toEqual({ order: updated, orderStatus: 'PAID', applied: true });
  });

  it('組み立てた更新式をそのまま送る', async () => {
    const fake = fakeDocClient({ update: () => ({ Attributes: orderRecord() }) });
    await advanceOrderStage({
      docClient: fake.client,
      tableName: TABLE,
      orderId: ORDER_ID,
      customerId: CUSTOMER_ID,
      stage: 'point',
      result: 'DONE',
      pointEarned: 18,
      now: NOW,
    });

    const expected = buildStageUpdateCommandInput({
      tableName: TABLE,
      orderId: ORDER_ID,
      customerId: CUSTOMER_ID,
      stage: 'point',
      result: 'DONE',
      pointEarned: 18,
      now: NOW,
    });
    expect((fake.sent[0] as UpdateCommand).input).toEqual(expected);
  });
});

describe('advanceOrderStage: 条件失敗の扱い（design §5.4）', () => {
  it('同一段階が記録済みなら冪等に成功として返す（applied = false）', async () => {
    const current = orderRecord({
      order_status: 'PAID',
      payment_status: 'DONE',
      payment_at: '2025-01-01T00:00:03.000Z',
      stages_done: 1,
    });
    const fake = fakeDocClient({
      update: () => {
        throw conditionalCheckFailed();
      },
      get: () => ({ Item: current }),
    });

    const result = await advanceOrderStage({
      docClient: fake.client,
      tableName: TABLE,
      orderId: ORDER_ID,
      customerId: CUSTOMER_ID,
      stage: 'payment',
      result: 'DONE',
      now: NOW,
    });

    expect(result).toEqual({ order: current, orderStatus: 'PAID', applied: false });
    expect(fake.sent[1]).toBeInstanceOf(GetCommand);
  });

  it('COMPLETED の前提が未達なら StagePreconditionError を投げる（記録を落とさない）', async () => {
    const current = orderRecord({
      order_status: 'ALLOCATED',
      payment_status: 'DONE',
      allocation_status: 'DONE',
      stages_done: 2,
    });
    const fake = fakeDocClient({
      update: () => {
        throw conditionalCheckFailed();
      },
      get: () => ({ Item: current }),
    });

    await expect(
      advanceOrderStage({
        docClient: fake.client,
        tableName: TABLE,
        orderId: ORDER_ID,
        customerId: CUSTOMER_ID,
        stage: 'point',
        result: 'DONE',
        now: NOW,
      })
    ).rejects.toBeInstanceOf(StagePreconditionError);
  });

  it('注文が存在しない場合はエラーにする', async () => {
    const fake = fakeDocClient({
      update: () => {
        throw conditionalCheckFailed();
      },
      get: () => ({}),
    });

    await expect(
      advanceOrderStage({
        docClient: fake.client,
        tableName: TABLE,
        orderId: ORDER_ID,
        customerId: CUSTOMER_ID,
        stage: 'payment',
        result: 'DONE',
        now: NOW,
      })
    ).rejects.toThrow(/Order not found/);
  });

  it('条件失敗以外の例外はそのまま投げる（技術的な失敗として再試行させる）', async () => {
    const fake = fakeDocClient({
      update: () => {
        throw new Error('ThrottlingException');
      },
    });

    await expect(
      advanceOrderStage({
        docClient: fake.client,
        tableName: TABLE,
        orderId: ORDER_ID,
        customerId: CUSTOMER_ID,
        stage: 'payment',
        result: 'DONE',
        now: NOW,
      })
    ).rejects.toThrow('ThrottlingException');
    // 読み直しを発生させない
    expect(fake.sent).toHaveLength(1);
  });
});
