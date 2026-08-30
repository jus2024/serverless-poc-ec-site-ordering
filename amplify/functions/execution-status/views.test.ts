import { describe, expect, it } from 'vitest';
import type {
  ExecutionRecord,
  LoadTestExecutionRecord,
  QueryImpactExecutionRecord,
} from '../shared/types.js';
import {
  UnknownExecutionTypeError,
  buildExecutionGetInput,
  resolveElapsedMs,
  toExecutionStatusResponse,
} from './views.js';

/**
 * 実行状態の整形の単体テスト（要件 11.6 / 12.5、design §4.3）。
 *
 * 検証の主眼は 3 点。
 *
 * 1. **両方の `execution_type` を扱えること**（並行計測の実行 ID で壊れない）
 * 2. 未完了の属性を 0 / false で埋めないこと（Property 11。実測レートの信頼性）
 * 3. 経過時間が「完了済みは実測、実行中は現在時刻まで」で算出されること（要件 11.6）
 */

const STARTED_AT = '2025-01-01T00:00:00.000Z';
const STARTED_AT_MS = Date.parse(STARTED_AT);

/** 実行中の負荷生成レコード（開始直後の形。`load-generator/execution-record.ts` と同じ） */
function runningLoadTest(
  overrides: Partial<LoadTestExecutionRecord> = {}
): LoadTestExecutionRecord {
  return {
    execution_id: 'LOAD#01J000000000000000000000',
    execution_type: 'LOAD_TEST',
    status: 'RUNNING',
    duration_seconds: 300,
    target_orders_per_minute: 2000,
    use_ramp_curve: false,
    submitted_count: 0,
    submit_error_count: 0,
    parallelization_factor: 1,
    stage_delays_ms: { payment: 3000, notification: 500 },
    started_at: STARTED_AT,
    expires_at: 1_800_000_000,
    ...overrides,
  };
}

function runningQueryImpact(
  overrides: Partial<QueryImpactExecutionRecord> = {}
): QueryImpactExecutionRecord {
  return {
    execution_id: 'MEASURE#01J000000000000000000000',
    execution_type: 'QUERY_IMPACT',
    status: 'RUNNING',
    duration_seconds: 120,
    concurrency: 20,
    throttle_count: 0,
    other_error_count: 0,
    parallelization_factor: 2,
    stage_delays_ms: { payment: 3000, notification: 500 },
    started_at: STARTED_AT,
    expires_at: 1_800_000_000,
    ...overrides,
  };
}

describe('buildExecutionGetInput（design §4.1 / §5.9）', () => {
  it('PK のみでキーを組み立てる（SK を持たないテーブル）', () => {
    expect(
      buildExecutionGetInput({ tableName: 'executions', executionId: 'LOAD#01J' })
    ).toEqual({
      TableName: 'executions',
      Key: { execution_id: 'LOAD#01J' },
      ConsistentRead: true,
    });
  });

  it('強い整合性で読む（完了直後の実行が RUNNING に見えないようにするため）', () => {
    const input = buildExecutionGetInput({ tableName: 't', executionId: 'LOAD#01J' });
    expect(input.ConsistentRead).toBe(true);
  });
});

describe('toExecutionStatusResponse: LOAD_TEST（要件 11.6）', () => {
  it('実行中は投入件数と経過時間を返し、実測レートは null にする', () => {
    const response = toExecutionStatusResponse(
      runningLoadTest({ submitted_count: 1200, submit_error_count: 3 }),
      STARTED_AT_MS + 30_000
    );

    expect(response).toEqual({
      executionId: 'LOAD#01J000000000000000000000',
      executionType: 'LOAD_TEST',
      status: 'RUNNING',
      durationSeconds: 300,
      startedAt: STARTED_AT,
      finishedAt: null,
      elapsedMs: 30_000,
      errorMessage: null,
      targetOrdersPerMinute: 2000,
      // 完了まで実測レートは書かれない。0 で埋めると「レート 0 だった」に化ける
      actualOrdersPerMinute: null,
      rateDeviationWarning: null,
      useRampCurve: false,
      submittedCount: 1200,
      submitErrorCount: 3,
      conditions: {
        openShardCount: null,
        shardCountError: null,
        parallelizationFactor: 1,
        stageDelaysMs: { payment: 3000, notification: 500 },
        estimatedCapacityPerMinute: null,
        warmThroughputWrite: null,
      },
    });
  });

  it('完了した実行は実測レートと乖離警告をそのまま返す（要件 11.11）', () => {
    const response = toExecutionStatusResponse(
      runningLoadTest({
        status: 'COMPLETED',
        finished_at: '2025-01-01T00:05:00.000Z',
        submitted_count: 9800,
        actual_orders_per_minute: 1960,
        rate_deviation_warning: true,
      }),
      STARTED_AT_MS + 999_999
    );

    expect(response.status).toBe('COMPLETED');
    expect(response.finishedAt).toBe('2025-01-01T00:05:00.000Z');
    // 完了済みなら現在時刻ではなく finished_at までの経過を返す
    expect(response.elapsedMs).toBe(300_000);
    expect(response).toMatchObject({
      actualOrdersPerMinute: 1960,
      rateDeviationWarning: true,
    });
  });

  it('乖離が無かった実行は false を返す（未評価の null と区別する）', () => {
    const response = toExecutionStatusResponse(
      runningLoadTest({
        status: 'COMPLETED',
        finished_at: '2025-01-01T00:05:00.000Z',
        actual_orders_per_minute: 2000,
        rate_deviation_warning: false,
      })
    );

    expect(response).toMatchObject({ rateDeviationWarning: false });
  });

  it('失敗した実行は理由を返す（design §E-6）', () => {
    const response = toExecutionStatusResponse(
      runningLoadTest({
        status: 'FAILED',
        finished_at: '2025-01-01T00:00:10.000Z',
        error_message: 'AccessDeniedException: not authorized',
      })
    );

    expect(response).toMatchObject({
      status: 'FAILED',
      errorMessage: 'AccessDeniedException: not authorized',
      actualOrdersPerMinute: null,
    });
  });

  it('観測条件を実行レコードの値のまま返す（要件 19.3 / Property 10）', () => {
    const response = toExecutionStatusResponse(
      runningLoadTest({
        open_shard_count: 4,
        parallelization_factor: 5,
        estimated_capacity_per_minute: 667,
        warm_throughput_write: 40_000,
      })
    );

    expect(response.conditions).toEqual({
      openShardCount: 4,
      shardCountError: null,
      parallelizationFactor: 5,
      stageDelaysMs: { payment: 3000, notification: 500 },
      estimatedCapacityPerMinute: 667,
      warmThroughputWrite: 40_000,
    });
  });

  it('シャード数を取れなかった実行は理由を返し、消費能力を null にする（要件 19.5）', () => {
    const response = toExecutionStatusResponse(
      runningLoadTest({ shard_count_error: 'AccessDeniedException: DescribeStream' })
    );

    expect(response.conditions).toMatchObject({
      openShardCount: null,
      shardCountError: 'AccessDeniedException: DescribeStream',
      estimatedCapacityPerMinute: null,
    });
  });
});

describe('toExecutionStatusResponse: QUERY_IMPACT（要件 12.5）', () => {
  it('計測中は分位点を null にし、エラー件数は 0 から積み上げる', () => {
    const response = toExecutionStatusResponse(
      runningQueryImpact({ throttle_count: 12, other_error_count: 1 }),
      STARTED_AT_MS + 5_000
    );

    expect(response).toEqual({
      executionId: 'MEASURE#01J000000000000000000000',
      executionType: 'QUERY_IMPACT',
      status: 'RUNNING',
      durationSeconds: 120,
      startedAt: STARTED_AT,
      finishedAt: null,
      elapsedMs: 5_000,
      errorMessage: null,
      concurrency: 20,
      latencyPercentiles: null,
      throttleCount: 12,
      otherErrorCount: 1,
      requestCount: 0,
      loadTestId: null,
      conditions: {
        openShardCount: null,
        shardCountError: null,
        parallelizationFactor: 2,
        stageDelaysMs: { payment: 3000, notification: 500 },
        estimatedCapacityPerMinute: null,
        warmThroughputWrite: null,
      },
    });
  });

  it('完了した計測は分位点を返す（要件 12.3）', () => {
    const response = toExecutionStatusResponse(
      runningQueryImpact({
        status: 'COMPLETED',
        finished_at: '2025-01-01T00:02:00.000Z',
        latency_percentiles: { p50: 42, p95: 120, p99: 350, max: 980 },
      })
    );

    expect(response).toMatchObject({
      latencyPercentiles: { p50: 42, p95: 120, p99: 350, max: 980 },
      elapsedMs: 120_000,
    });
  });

  it('リクエスト総数と負荷生成の実行 ID を返す（要件 12.1 / 12.5）', () => {
    // エラー率の分母（requestCount）が無いと、フロントエンドは
    // スロットル件数の増加が並行数の増加によるものか率の悪化かを区別できない。
    // 投入レートは loadTestId で負荷生成の実行レコードを引いて得る
    const response = toExecutionStatusResponse(
      runningQueryImpact({
        throttle_count: 30,
        other_error_count: 2,
        request_count: 4000,
        load_test_id: 'LOAD#01J000000000000000000000',
      })
    );

    expect(response).toMatchObject({
      requestCount: 4000,
      loadTestId: 'LOAD#01J000000000000000000000',
    });
  });

  it('属性が無い場合は 0 / null に寄せる（開始直後・単独実行）', () => {
    const response = toExecutionStatusResponse(runningQueryImpact());

    expect(response).toMatchObject({ requestCount: 0, loadTestId: null });
  });
});

describe('toExecutionStatusResponse: 未知の種別', () => {
  it('design §4.3 に無い execution_type は UnknownExecutionTypeError にする', () => {
    const record = {
      ...runningLoadTest(),
      execution_type: 'SOMETHING_ELSE',
    } as unknown as ExecutionRecord;

    expect(() => toExecutionStatusResponse(record)).toThrow(UnknownExecutionTypeError);
  });
});

describe('resolveElapsedMs（要件 11.6）', () => {
  it('実行中は現在時刻までの経過を返す', () => {
    expect(resolveElapsedMs(runningLoadTest(), STARTED_AT_MS + 1_500)).toBe(1_500);
  });

  it('継続時間を超えた実行中の経過を丸めない（ワーカーが落ちた兆候を消さない）', () => {
    const record = runningLoadTest({ duration_seconds: 10 });
    expect(resolveElapsedMs(record, STARTED_AT_MS + 60_000)).toBe(60_000);
  });

  it('時刻の逆転では 0 を返す（負の経過時間を返さない）', () => {
    expect(resolveElapsedMs(runningLoadTest(), STARTED_AT_MS - 5_000)).toBe(0);
  });

  it('started_at が解釈できなければ null（0 と区別する）', () => {
    expect(resolveElapsedMs(runningLoadTest({ started_at: 'not-a-date' }))).toBeNull();
  });

  it('finished_at が解釈できなければ null', () => {
    const record = runningLoadTest({ status: 'COMPLETED', finished_at: 'not-a-date' });
    expect(resolveElapsedMs(record, STARTED_AT_MS + 1_000)).toBeNull();
  });
});
