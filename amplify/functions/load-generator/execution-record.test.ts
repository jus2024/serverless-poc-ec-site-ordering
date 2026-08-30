import { describe, expect, it } from 'vitest';
import { buildCapacityEstimate } from '../shared/capacity.js';
import {
  MAX_ERROR_MESSAGE_LENGTH,
  buildCompletionUpdateInput,
  buildFailureUpdateInput,
  buildLoadTestExecutionRecord,
  buildProgressUpdateInput,
  formatExecutionError,
  toStartLoadTestResponse,
} from './execution-record.js';
import { evaluateRate } from './load-plan.js';
import type { LoadTestParams } from './load-test-request.js';
import type { ShardObservation } from './shard-count.js';

/**
 * 実行レコードの単体テスト（design §4.3 / §E-6、要件 11.11 / 19.3 / 19.5）。
 *
 * DynamoDB へは接続しない。確かめるのは 4 点。
 *
 * 1. design §4.3 の属性がすべて記録されること（Property 10 の自己記述性）
 * 2. 消費能力が**実測シャード数のときだけ**記録されること（要件 19.3）
 * 3. `status` を予約語として扱っていること（`#status`）
 * 4. 失敗時に `FAILED` と理由が残ること（design §E-6）
 */

const EXECUTIONS_TABLE = 'kiro-roasters-order-executions-test';
const EXECUTION_ID = 'LOAD#01JC0000000000000000000000';
const NOW_MS = Date.UTC(2025, 0, 1, 12, 0, 0);

const PARAMS: LoadTestParams = {
  ordersPerMinute: 2_000,
  durationSeconds: 600,
  useRampCurve: false,
};

const VERIFICATION = {
  streamParallelizationFactor: 2,
  paymentDelayMs: 3_000,
  notificationDelayMs: 500,
  dataTtlDays: 7,
};

const MEASURED: ShardObservation = {
  openShardCount: 4,
  warmThroughputWrite: 12_000,
  pageCount: 1,
};

const FAILED_OBSERVATION: ShardObservation = {
  shardCountError: 'AccessDeniedException: dynamodb:DescribeStream が拒否されました',
  pageCount: 0,
};

function buildRecord(observation: ShardObservation = MEASURED) {
  return buildLoadTestExecutionRecord({
    executionId: EXECUTION_ID,
    params: PARAMS,
    observation,
    verification: VERIFICATION,
    nowMs: NOW_MS,
  });
}

describe('buildLoadTestExecutionRecord（design §4.3、Property 10）', () => {
  it('実行条件と観測条件を記録する', () => {
    const record = buildRecord();
    expect(record).toMatchObject({
      execution_id: EXECUTION_ID,
      execution_type: 'LOAD_TEST',
      status: 'RUNNING',
      target_orders_per_minute: 2_000,
      duration_seconds: 600,
      use_ramp_curve: false,
      submitted_count: 0,
      submit_error_count: 0,
      open_shard_count: 4,
      parallelization_factor: 2,
      stage_delays_ms: { payment: 3_000, notification: 500 },
      warm_throughput_write: 12_000,
      started_at: '2025-01-01T12:00:00.000Z',
    });
  });

  it('TTL を保持日数から算出する（design 論点 5）', () => {
    expect(buildRecord().expires_at).toBe(NOW_MS / 1_000 + 7 * 24 * 60 * 60);
  });

  it('実測シャード数から消費能力を算出する（要件 19.3）', () => {
    const record = buildRecord();
    const expected = buildCapacityEstimate({
      parallelizationFactor: VERIFICATION.streamParallelizationFactor,
      stageDelaysMs: { payment: 3_000, notification: 500 },
      openShardCount: 4,
    });
    expect(expected.shardCountSource).toBe('MEASURED');
    expect(record.estimated_capacity_per_minute).toBe(
      expected.estimatedCapacityPerMinute
    );
  });

  it('シャード数が取れなければ消費能力を記録しない（暫定値で埋めない。要件 19.3）', () => {
    const record = buildRecord(FAILED_OBSERVATION);
    expect(record.open_shard_count).toBeUndefined();
    expect(record.estimated_capacity_per_minute).toBeUndefined();
    expect(record.shard_count_error).toBe(FAILED_OBSERVATION.shardCountError);
  });

  it('シャード数が取れた実行には失敗理由を残さない（両者は排他）', () => {
    expect(buildRecord().shard_count_error).toBeUndefined();
  });

  it('warm throughput が未設定なら属性を作らない', () => {
    const record = buildRecord({ openShardCount: 4, pageCount: 1 });
    expect(record).not.toHaveProperty('warm_throughput_write');
  });

  it('開始時点では実測レートと完了時刻を持たない（Property 11）', () => {
    const record = buildRecord();
    expect(record.actual_orders_per_minute).toBeUndefined();
    expect(record.rate_deviation_warning).toBeUndefined();
    expect(record.finished_at).toBeUndefined();
  });
});

describe('toStartLoadTestResponse（要件 11.9）', () => {
  it('実行 ID と観測条件を返す', () => {
    const record = buildRecord();
    expect(toStartLoadTestResponse(record)).toEqual({
      executionId: EXECUTION_ID,
      status: 'RUNNING',
      targetOrdersPerMinute: 2_000,
      durationSeconds: 600,
      useRampCurve: false,
      startedAt: '2025-01-01T12:00:00.000Z',
      openShardCount: 4,
      shardCountError: null,
      estimatedCapacityPerMinute: record.estimated_capacity_per_minute,
    });
  });

  it('シャード数の取得に失敗しても応答を返す（要件 19.5。投入は継続する）', () => {
    const response = toStartLoadTestResponse(buildRecord(FAILED_OBSERVATION));
    expect(response.openShardCount).toBeNull();
    expect(response.estimatedCapacityPerMinute).toBeNull();
    expect(response.shardCountError).toBe(FAILED_OBSERVATION.shardCountError);
  });
});

describe('buildProgressUpdateInput（要件 11.6）', () => {
  const input = buildProgressUpdateInput({
    tableName: EXECUTIONS_TABLE,
    executionId: EXECUTION_ID,
    submittedCount: 1_234,
    submitErrorCount: 5,
  });

  it('累積値を代入する（加算にしない。二重実行で二重計上しないため）', () => {
    expect(input.UpdateExpression).toBe(
      'SET submitted_count = :submitted, submit_error_count = :submitErrors'
    );
    expect(input.ExpressionAttributeValues).toEqual({
      ':submitted': 1_234,
      ':submitErrors': 5,
    });
  });

  it('存在しないレコードを作らない（TTL 削除済みの実行を復活させない）', () => {
    expect(input.ConditionExpression).toBe('attribute_exists(execution_id)');
  });

  it('status を書き換えない', () => {
    expect(input.UpdateExpression).not.toContain('status');
  });

  it('PK だけをキーにする（実行管理テーブルは PK のみ。design §4.1）', () => {
    expect(input.Key).toEqual({ execution_id: EXECUTION_ID });
    expect(input.TableName).toBe(EXECUTIONS_TABLE);
  });
});

describe('buildCompletionUpdateInput（要件 11.6 / 11.11）', () => {
  const rate = evaluateRate({
    targetOrdersPerMinute: PARAMS.ordersPerMinute,
    useRampCurve: PARAMS.useRampCurve,
    submittedCount: 20_000,
    elapsedMs: 600_000,
  });
  const input = buildCompletionUpdateInput({
    tableName: EXECUTIONS_TABLE,
    executionId: EXECUTION_ID,
    submittedCount: 20_000,
    submitErrorCount: 3,
    rate,
    nowMs: NOW_MS,
  });

  it('status を予約語として扱う（直接書くと ValidationException になる）', () => {
    expect(input.ExpressionAttributeNames).toEqual({ '#status': 'status' });
    expect(input.UpdateExpression).toContain('#status = :status');
    expect(input.ExpressionAttributeValues?.[':status']).toBe('COMPLETED');
  });

  it('実測投入レートを記録する（要件 11.11）', () => {
    expect(input.ExpressionAttributeValues?.[':actualRate']).toBe(2_000);
    expect(input.UpdateExpression).toContain('actual_orders_per_minute = :actualRate');
  });

  it('乖離が無くても警告属性を書く（「評価していない」と区別する）', () => {
    expect(input.ExpressionAttributeValues?.[':rateWarning']).toBe(false);
  });

  it('乖離した実行では警告を true にする（design 論点 10）', () => {
    const deviated = buildCompletionUpdateInput({
      tableName: EXECUTIONS_TABLE,
      executionId: EXECUTION_ID,
      submittedCount: 10_000,
      submitErrorCount: 0,
      rate: evaluateRate({
        targetOrdersPerMinute: PARAMS.ordersPerMinute,
        useRampCurve: PARAMS.useRampCurve,
        submittedCount: 10_000,
        elapsedMs: 600_000,
      }),
      nowMs: NOW_MS,
    });
    expect(deviated.ExpressionAttributeValues?.[':rateWarning']).toBe(true);
  });

  it('完了時刻と投入件数を記録する', () => {
    expect(input.ExpressionAttributeValues?.[':finishedAt']).toBe(
      '2025-01-01T12:00:00.000Z'
    );
    expect(input.ExpressionAttributeValues?.[':submitted']).toBe(20_000);
    expect(input.ExpressionAttributeValues?.[':submitErrors']).toBe(3);
  });
});

describe('buildFailureUpdateInput（design §E-6）', () => {
  it('FAILED と理由を記録する', () => {
    const input = buildFailureUpdateInput({
      tableName: EXECUTIONS_TABLE,
      executionId: EXECUTION_ID,
      errorMessage: 'SelfInvokeError: 自己 invoke に失敗しました',
      nowMs: NOW_MS,
    });
    expect(input.ExpressionAttributeValues?.[':status']).toBe('FAILED');
    expect(input.ExpressionAttributeValues?.[':errorMessage']).toBe(
      'SelfInvokeError: 自己 invoke に失敗しました'
    );
    expect(input.ExpressionAttributeNames).toEqual({ '#status': 'status' });
    expect(input.ConditionExpression).toBe('attribute_exists(execution_id)');
  });

  it('投入件数が分かっていれば一緒に書く', () => {
    const input = buildFailureUpdateInput({
      tableName: EXECUTIONS_TABLE,
      executionId: EXECUTION_ID,
      errorMessage: 'Error: 失敗',
      submittedCount: 100,
      submitErrorCount: 2,
      nowMs: NOW_MS,
    });
    expect(input.UpdateExpression).toContain('submitted_count = :submitted');
    expect(input.UpdateExpression).toContain('submit_error_count = :submitErrors');
  });

  it('投入前の失敗では件数を書かない（0 件で上書きしない）', () => {
    const input = buildFailureUpdateInput({
      tableName: EXECUTIONS_TABLE,
      executionId: EXECUTION_ID,
      errorMessage: 'Error: 失敗',
      nowMs: NOW_MS,
    });
    expect(input.UpdateExpression).not.toContain('submitted_count');
  });

  it('実測レートを書かない（中断した実行を §2.4 の算術に使わせない。Property 11）', () => {
    const input = buildFailureUpdateInput({
      tableName: EXECUTIONS_TABLE,
      executionId: EXECUTION_ID,
      errorMessage: 'Error: 失敗',
      submittedCount: 100,
      nowMs: NOW_MS,
    });
    expect(input.UpdateExpression).not.toContain('actual_orders_per_minute');
    expect(input.UpdateExpression).not.toContain('rate_deviation_warning');
  });

  it('長すぎる理由を切り詰める', () => {
    const input = buildFailureUpdateInput({
      tableName: EXECUTIONS_TABLE,
      executionId: EXECUTION_ID,
      errorMessage: 'x'.repeat(MAX_ERROR_MESSAGE_LENGTH * 2),
      nowMs: NOW_MS,
    });
    const message = input.ExpressionAttributeValues?.[':errorMessage'] as string;
    expect(message).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);
    expect(message.endsWith('…')).toBe(true);
  });
});

describe('formatExecutionError', () => {
  it('例外の名前を残す（IAM の配線漏れとテーブル名の誤りを見分けるため）', () => {
    const error = new Error('dynamodb:BatchWriteItem が拒否されました');
    error.name = 'AccessDeniedException';
    expect(formatExecutionError(error)).toBe(
      'AccessDeniedException: dynamodb:BatchWriteItem が拒否されました'
    );
  });

  it('例外でない値も記録できる形にする', () => {
    expect(formatExecutionError('文字列で throw された')).toBe(
      'UnknownError: 文字列で throw された'
    );
  });

  it('改行を 1 行に畳む（スタックトレースを持ち込まない）', () => {
    expect(formatExecutionError(new Error('1 行目\n  2 行目'))).toBe(
      'Error: 1 行目 2 行目'
    );
  });
});
