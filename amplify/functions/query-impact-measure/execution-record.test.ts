import { describe, expect, it } from 'vitest';
import { buildCapacityEstimate } from '../shared/capacity.js';
import type { QueryImpactExecutionRecord } from '../shared/types.js';
import type { ExecutionVerificationParams } from '../load-generator/execution-record.js';
import {
  buildCompletionUpdateInput,
  buildFailureUpdateInput,
  buildProgressUpdateInput,
  buildQueryImpactExecutionRecord,
  summarizeLatencies,
  toStartQueryImpactResponse,
} from './execution-record.js';
import type { MeasureParams } from './measure-request.js';
import { createOutcomeCounters } from './request-outcome.js';

/**
 * 並行計測の実行レコードの単体テスト（design §4.3、要件 12.2 / 12.3 / 12.5 / 12.6 / 19.3）。
 *
 * 確かめるのは 4 点。
 *
 * 1. 実行条件（PF・擬似処理時間・シャード数・並行数）がレコードに刻まれること（要件 12.5）
 * 2. シャード数が実測でなければ消費能力を書かないこと（要件 19.3 / Property 10）
 * 3. エラー件数は 0 でも書くこと（波及が無かったことを記録する。要件 12.6）
 * 4. 更新式が `status` を予約語として扱い、条件式でレコードの復活を防ぐこと
 */

const TABLE = 'kiro-order-executions-test';
const NOW_MS = Date.UTC(2025, 0, 15, 3, 0, 0);

const VERIFICATION: ExecutionVerificationParams = {
  streamParallelizationFactor: 2,
  paymentDelayMs: 3_000,
  notificationDelayMs: 500,
  dataTtlDays: 7,
};

const PARAMS: MeasureParams = {
  concurrency: 60,
  durationSeconds: 120,
  target: { kind: 'ORDER_LIST', customerId: 'test-0001' },
};

function buildRecord(
  overrides: {
    params?: Partial<MeasureParams>;
    observation?: Parameters<typeof buildQueryImpactExecutionRecord>[0]['observation'];
  } = {}
): QueryImpactExecutionRecord {
  return buildQueryImpactExecutionRecord({
    executionId: 'MEASURE#01JABCDE',
    params: { ...PARAMS, ...overrides.params },
    observation: overrides.observation ?? { openShardCount: 4, pageCount: 1 },
    verification: VERIFICATION,
    nowMs: NOW_MS,
  });
}

describe('buildQueryImpactExecutionRecord: 実行条件（要件 12.5 / 19.3）', () => {
  it('PF・擬似処理時間・シャード数・並行数を刻む', () => {
    const record = buildRecord();

    expect(record.execution_type).toBe('QUERY_IMPACT');
    expect(record.status).toBe('RUNNING');
    expect(record.concurrency).toBe(60);
    expect(record.duration_seconds).toBe(120);
    expect(record.parallelization_factor).toBe(2);
    expect(record.stage_delays_ms).toEqual({ payment: 3_000, notification: 500 });
    expect(record.open_shard_count).toBe(4);
  });

  it('消費能力を実測シャード数から算出する（`shared/capacity.ts` と同じ値）', () => {
    const expected = buildCapacityEstimate({
      parallelizationFactor: VERIFICATION.streamParallelizationFactor,
      stageDelaysMs: { payment: 3_000, notification: 500 },
      openShardCount: 4,
    }).estimatedCapacityPerMinute;

    expect(buildRecord().estimated_capacity_per_minute).toBe(expected);
  });

  it('シャード数が取れなかった実行には消費能力を書かない（暫定値で埋めない）', () => {
    const record = buildRecord({
      observation: { shardCountError: 'AccessDeniedException: denied', pageCount: 0 },
    });

    expect(record.open_shard_count).toBeUndefined();
    expect(record.estimated_capacity_per_minute).toBeUndefined();
    expect(record.shard_count_error).toBe('AccessDeniedException: denied');
  });

  it('warm throughput が取れれば記録する（軸 B の追跡用）', () => {
    const record = buildRecord({
      observation: { openShardCount: 8, pageCount: 1, warmThroughputWrite: 40_000 },
    });
    expect(record.warm_throughput_write).toBe(40_000);
  });

  it('負荷生成の実行 ID を記録する（投入レートの出典。要件 12.5）', () => {
    expect(buildRecord({ params: { loadTestId: 'LOAD#01JZZZ' } }).load_test_id).toBe(
      'LOAD#01JZZZ'
    );
  });

  it('負荷生成の実行 ID を省略した場合は属性を作らない', () => {
    expect(buildRecord().load_test_id).toBeUndefined();
  });
});

describe('buildQueryImpactExecutionRecord: 初期値', () => {
  it('エラー件数とリクエスト数を 0 で作る（0 と未計測を区別する。要件 12.6）', () => {
    const record = buildRecord();
    expect(record.throttle_count).toBe(0);
    expect(record.other_error_count).toBe(0);
    expect(record.request_count).toBe(0);
  });

  it('分位点は書かない（まだ測れていないことを属性の不在で表す）', () => {
    expect(buildRecord().latency_percentiles).toBeUndefined();
  });

  it('完了時刻は書かない', () => {
    expect(buildRecord().finished_at).toBeUndefined();
  });

  it('TTL を設定する（要件 17.6 / design 論点 5）', () => {
    expect(buildRecord().expires_at).toBe(
      Math.floor(NOW_MS / 1000) + VERIFICATION.dataTtlDays * 24 * 60 * 60
    );
  });
});

describe('toStartQueryImpactResponse（202 Accepted。要件 12.1）', () => {
  it('計測対象と実行条件を返す', () => {
    expect(toStartQueryImpactResponse(buildRecord(), PARAMS)).toEqual({
      executionId: 'MEASURE#01JABCDE',
      status: 'RUNNING',
      concurrency: 60,
      durationSeconds: 120,
      target: 'GET /orders?customerId=test-0001',
      loadTestId: null,
      startedAt: new Date(NOW_MS).toISOString(),
      openShardCount: 4,
      shardCountError: null,
      estimatedCapacityPerMinute: buildRecord().estimated_capacity_per_minute ?? null,
    });
  });

  it('未設定の属性は null で返す（属性の不在を表す）', () => {
    const record = buildRecord({
      observation: { shardCountError: 'AccessDeniedException: denied', pageCount: 0 },
    });
    const response = toStartQueryImpactResponse(record, PARAMS);

    expect(response.openShardCount).toBeNull();
    expect(response.estimatedCapacityPerMinute).toBeNull();
    expect(response.shardCountError).toBe('AccessDeniedException: denied');
  });
});

describe('buildProgressUpdateInput', () => {
  const counters = { requestCount: 120, successCount: 118, throttleCount: 1, otherErrorCount: 1 };

  it('代入で更新する（二重実行でも値が同じになる）', () => {
    const input = buildProgressUpdateInput({
      tableName: TABLE,
      executionId: 'MEASURE#01JABCDE',
      counters,
    });

    expect(input.UpdateExpression).not.toContain('ADD');
    expect(input.ExpressionAttributeValues).toEqual({
      ':throttles': 1,
      ':otherErrors': 1,
      ':requests': 120,
    });
  });

  it('レコードが無ければ更新しない（TTL で消えた実行を復活させない）', () => {
    const input = buildProgressUpdateInput({
      tableName: TABLE,
      executionId: 'MEASURE#01JABCDE',
      counters,
    });
    expect(input.ConditionExpression).toBe('attribute_exists(execution_id)');
  });

  it('status は変えない', () => {
    const input = buildProgressUpdateInput({
      tableName: TABLE,
      executionId: 'MEASURE#01JABCDE',
      counters,
    });
    expect(input.UpdateExpression).not.toContain('#status');
  });
});

describe('buildCompletionUpdateInput（要件 12.2 / 12.3）', () => {
  const counters = { requestCount: 500, successCount: 495, throttleCount: 3, otherErrorCount: 2 };
  const percentiles = { p50: 12, p95: 40, p99: 120, max: 300 };

  it('status を予約語として扱う（直書きは ValidationException になる）', () => {
    const input = buildCompletionUpdateInput({
      tableName: TABLE,
      executionId: 'MEASURE#01JABCDE',
      counters,
      latencyPercentiles: percentiles,
      nowMs: NOW_MS,
    });

    expect(input.ExpressionAttributeNames).toEqual({ '#status': 'status' });
    expect(input.UpdateExpression).toContain('#status = :status');
    expect(input.ExpressionAttributeValues?.[':status']).toBe('COMPLETED');
  });

  it('分位点とエラー件数を 1 回の更新で書く', () => {
    const input = buildCompletionUpdateInput({
      tableName: TABLE,
      executionId: 'MEASURE#01JABCDE',
      counters,
      latencyPercentiles: percentiles,
      nowMs: NOW_MS,
    });

    expect(input.ExpressionAttributeValues).toEqual({
      ':status': 'COMPLETED',
      ':finishedAt': new Date(NOW_MS).toISOString(),
      ':throttles': 3,
      ':otherErrors': 2,
      ':requests': 500,
      ':percentiles': percentiles,
    });
  });

  it('スロットル 0 件でも書く（波及が無かったことを記録する。要件 12.6）', () => {
    const input = buildCompletionUpdateInput({
      tableName: TABLE,
      executionId: 'MEASURE#01JABCDE',
      counters: { requestCount: 500, successCount: 500, throttleCount: 0, otherErrorCount: 0 },
      latencyPercentiles: percentiles,
      nowMs: NOW_MS,
    });

    expect(input.ExpressionAttributeValues?.[':throttles']).toBe(0);
    expect(input.ExpressionAttributeValues?.[':otherErrors']).toBe(0);
  });

  it('標本 0 件なら分位点を書かない（0ms を観測したと読めてしまう）', () => {
    const input = buildCompletionUpdateInput({
      tableName: TABLE,
      executionId: 'MEASURE#01JABCDE',
      counters: createOutcomeCounters(),
      latencyPercentiles: null,
      nowMs: NOW_MS,
    });

    expect(input.UpdateExpression).not.toContain('latency_percentiles');
    expect(input.ExpressionAttributeValues).not.toHaveProperty(':percentiles');
  });

  it('レコードが無ければ更新しない', () => {
    const input = buildCompletionUpdateInput({
      tableName: TABLE,
      executionId: 'MEASURE#01JABCDE',
      counters,
      latencyPercentiles: percentiles,
      nowMs: NOW_MS,
    });
    expect(input.ConditionExpression).toBe('attribute_exists(execution_id)');
  });
});

describe('buildFailureUpdateInput（design §E-6）', () => {
  it('FAILED と理由を書く', () => {
    const input = buildFailureUpdateInput({
      tableName: TABLE,
      executionId: 'MEASURE#01JABCDE',
      errorMessage: 'SelfInvokeError: 自己 invoke に失敗しました',
      nowMs: NOW_MS,
    });

    expect(input.ExpressionAttributeValues?.[':status']).toBe('FAILED');
    expect(input.ExpressionAttributeValues?.[':errorMessage']).toBe(
      'SelfInvokeError: 自己 invoke に失敗しました'
    );
    expect(input.ExpressionAttributeNames).toEqual({ '#status': 'status' });
  });

  it('分位点は書かない（途中までの標本から出た値を完走した結果と並べない）', () => {
    const input = buildFailureUpdateInput({
      tableName: TABLE,
      executionId: 'MEASURE#01JABCDE',
      errorMessage: 'Error: boom',
      counters: { requestCount: 10, successCount: 8, throttleCount: 1, otherErrorCount: 1 },
      nowMs: NOW_MS,
    });
    expect(input.UpdateExpression).not.toContain('latency_percentiles');
  });

  it('内訳が分かっていれば書く', () => {
    const input = buildFailureUpdateInput({
      tableName: TABLE,
      executionId: 'MEASURE#01JABCDE',
      errorMessage: 'Error: boom',
      counters: { requestCount: 10, successCount: 8, throttleCount: 1, otherErrorCount: 1 },
      nowMs: NOW_MS,
    });

    expect(input.ExpressionAttributeValues?.[':requests']).toBe(10);
    expect(input.ExpressionAttributeValues?.[':throttles']).toBe(1);
    expect(input.ExpressionAttributeValues?.[':otherErrors']).toBe(1);
  });

  it('内訳が無ければ件数の属性に触らない（1 件も撃てていない失敗）', () => {
    const input = buildFailureUpdateInput({
      tableName: TABLE,
      executionId: 'MEASURE#01JABCDE',
      errorMessage: 'Error: boom',
      nowMs: NOW_MS,
    });

    expect(input.UpdateExpression).not.toContain('throttle_count');
    expect(input.UpdateExpression).not.toContain('request_count');
  });
});

describe('summarizeLatencies（要件 12.3）', () => {
  it('標本から p50 / p95 / p99 / 最大を返す', () => {
    const latencies = Array.from({ length: 100 }, (_unused, index) => index + 1);
    expect(summarizeLatencies(latencies)).toEqual({ p50: 50, p95: 95, p99: 99, max: 100 });
  });

  it('標本 0 件なら null（計測が空振りした事実を消さない）', () => {
    expect(summarizeLatencies([])).toBeNull();
  });

  it('標本 1 件なら全ての分位点が同じ値になる', () => {
    expect(summarizeLatencies([42])).toEqual({ p50: 42, p95: 42, p99: 42, max: 42 });
  });
});
