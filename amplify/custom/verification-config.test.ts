import { describe, expect, it } from 'vitest';
import {
  ASSUMED_OPEN_SHARD_COUNT,
  ASSUMED_STAGE_OVERHEAD_MS,
  VERIFICATION_DEFAULTS,
  VERIFICATION_ENV_VARS,
  VerificationConfigError,
  buildWarnings,
  estimateCapacityPerMinute,
  resolveVerificationConfig,
} from './verification-config.js';

/** 環境変数を明示的に渡し、警告出力は捨てる（テスト出力を汚さないため） */
function resolve(env: Record<string, string | undefined>) {
  return resolveVerificationConfig({ env, onWarning: null });
}

describe('resolveVerificationConfig: 既定値の解決', () => {
  it('環境変数が何も設定されていなければ design §10.1 の既定値になる', () => {
    const config = resolve({});

    expect(config.streamBatchSize).toBe(VERIFICATION_DEFAULTS.streamBatchSize);
    expect(config.streamParallelizationFactor).toBe(
      VERIFICATION_DEFAULTS.streamParallelizationFactor
    );
    expect(config.streamMaxRecordAgeSeconds).toBe(
      VERIFICATION_DEFAULTS.streamMaxRecordAgeSeconds
    );
    expect(config.paymentDelayMs).toBe(VERIFICATION_DEFAULTS.paymentDelayMs);
    expect(config.notificationDelayMs).toBe(VERIFICATION_DEFAULTS.notificationDelayMs);
    expect(config.paymentFailureRate).toBe(VERIFICATION_DEFAULTS.paymentFailureRate);
    expect(config.dataTtlDays).toBe(VERIFICATION_DEFAULTS.dataTtlDays);
    expect(config.maxOrdersPerMinute).toBe(VERIFICATION_DEFAULTS.maxOrdersPerMinute);
    expect(config.maxDurationSeconds).toBe(VERIFICATION_DEFAULTS.maxDurationSeconds);
    expect(config.maxMeasureConcurrency).toBe(
      VERIFICATION_DEFAULTS.maxMeasureConcurrency
    );
  });

  it('warm throughput は既定では未設定のまま（暗黙に値を入れない）', () => {
    const config = resolve({});

    expect(config.warmThroughputWriteUnitsPerSecond).toBeUndefined();
    expect(config.warmThroughputReadUnitsPerSecond).toBeUndefined();
    expect(config.warnings).toEqual([]);
  });

  it('空文字は未設定と同じ扱いにする（.env.example の `VAR=` 形式）', () => {
    const config = resolve({
      ORDER_WARM_THROUGHPUT_WRITE: '',
      ORDER_STREAM_BATCH_SIZE: '   ',
    });

    expect(config.warmThroughputWriteUnitsPerSecond).toBeUndefined();
    expect(config.streamBatchSize).toBe(VERIFICATION_DEFAULTS.streamBatchSize);
  });

  it('設定された値をそのまま採用する', () => {
    const config = resolve({
      ORDER_STREAM_BATCH_SIZE: '10',
      ORDER_STREAM_PARALLELIZATION_FACTOR: '10',
      ORDER_STREAM_MAX_RECORD_AGE_SECONDS: '604800',
      ORDER_PAYMENT_DELAY_MS: '100',
      ORDER_NOTIFICATION_DELAY_MS: '0',
      ORDER_PAYMENT_FAILURE_RATE: '0.25',
      ORDER_WARM_THROUGHPUT_WRITE: '40000',
      ORDER_WARM_THROUGHPUT_READ: '4000',
      ORDER_DATA_TTL_DAYS: '1',
      ORDER_MAX_ORDERS_PER_MINUTE: '100000',
      ORDER_MAX_DURATION_SECONDS: '7200',
      ORDER_MAX_MEASURE_CONCURRENCY: '1000',
    });

    expect(config.streamBatchSize).toBe(10);
    expect(config.streamParallelizationFactor).toBe(10);
    expect(config.streamMaxRecordAgeSeconds).toBe(604_800);
    expect(config.paymentDelayMs).toBe(100);
    expect(config.notificationDelayMs).toBe(0);
    expect(config.paymentFailureRate).toBe(0.25);
    expect(config.warmThroughputWriteUnitsPerSecond).toBe(40_000);
    expect(config.warmThroughputReadUnitsPerSecond).toBe(4_000);
    expect(config.dataTtlDays).toBe(1);
    expect(config.maxOrdersPerMinute).toBe(100_000);
    expect(config.maxDurationSeconds).toBe(7_200);
    expect(config.maxMeasureConcurrency).toBe(1_000);
  });

  it('-1 は maxRecordAge の特例値として許容する（無期限）', () => {
    expect(resolve({ ORDER_STREAM_MAX_RECORD_AGE_SECONDS: '-1' }).streamMaxRecordAgeSeconds)
      .toBe(-1);
  });

  it('design §10.1 の全変数を読み取り対象にしている', () => {
    expect(VERIFICATION_ENV_VARS).toEqual([
      'ORDER_STREAM_BATCH_SIZE',
      'ORDER_STREAM_PARALLELIZATION_FACTOR',
      'ORDER_STREAM_MAX_RECORD_AGE_SECONDS',
      'ORDER_PAYMENT_DELAY_MS',
      'ORDER_NOTIFICATION_DELAY_MS',
      'ORDER_PAYMENT_FAILURE_RATE',
      'ORDER_WARM_THROUGHPUT_WRITE',
      'ORDER_WARM_THROUGHPUT_READ',
      'ORDER_DATA_TTL_DAYS',
      'ORDER_MAX_ORDERS_PER_MINUTE',
      'ORDER_MAX_DURATION_SECONDS',
      'ORDER_MAX_MEASURE_CONCURRENCY',
    ]);
  });
});

describe('resolveVerificationConfig: 範囲外の値', () => {
  // design §10.1 の「範囲」列の境界のすぐ外側を並べる
  const outOfRange: Array<[string, string]> = [
    ['ORDER_STREAM_BATCH_SIZE', '0'],
    ['ORDER_STREAM_BATCH_SIZE', '10001'],
    ['ORDER_STREAM_PARALLELIZATION_FACTOR', '0'],
    ['ORDER_STREAM_PARALLELIZATION_FACTOR', '11'],
    ['ORDER_STREAM_MAX_RECORD_AGE_SECONDS', '59'],
    ['ORDER_STREAM_MAX_RECORD_AGE_SECONDS', '-2'],
    ['ORDER_STREAM_MAX_RECORD_AGE_SECONDS', '604801'],
    ['ORDER_PAYMENT_DELAY_MS', '-1'],
    ['ORDER_PAYMENT_DELAY_MS', '60001'],
    ['ORDER_NOTIFICATION_DELAY_MS', '60001'],
    ['ORDER_PAYMENT_FAILURE_RATE', '-0.1'],
    ['ORDER_PAYMENT_FAILURE_RATE', '1.1'],
    ['ORDER_WARM_THROUGHPUT_WRITE', '3999'],
    ['ORDER_WARM_THROUGHPUT_WRITE', '1000001'],
    ['ORDER_WARM_THROUGHPUT_READ', '3999'],
    ['ORDER_DATA_TTL_DAYS', '0'],
    ['ORDER_DATA_TTL_DAYS', '31'],
    ['ORDER_MAX_ORDERS_PER_MINUTE', '0'],
    ['ORDER_MAX_ORDERS_PER_MINUTE', '100001'],
    ['ORDER_MAX_DURATION_SECONDS', '0'],
    ['ORDER_MAX_DURATION_SECONDS', '7201'],
    ['ORDER_MAX_MEASURE_CONCURRENCY', '0'],
    ['ORDER_MAX_MEASURE_CONCURRENCY', '1001'],
  ];

  it.each(outOfRange)('%s=%s は例外になる', (name, value) => {
    expect(() => resolve({ [name]: value })).toThrow(VerificationConfigError);
    expect(() => resolve({ [name]: value })).toThrow(name);
  });

  it('境界値そのものは許容する', () => {
    expect(() =>
      resolve({
        ORDER_STREAM_BATCH_SIZE: '1',
        ORDER_STREAM_PARALLELIZATION_FACTOR: '10',
        ORDER_STREAM_MAX_RECORD_AGE_SECONDS: '60',
        ORDER_PAYMENT_DELAY_MS: '0',
        ORDER_PAYMENT_FAILURE_RATE: '1',
        ORDER_WARM_THROUGHPUT_WRITE: '1000000',
        ORDER_DATA_TTL_DAYS: '30',
      })
    ).not.toThrow();
  });

  it('数値として解釈できない値は既定値に落とさず例外にする（要件 10.5）', () => {
    expect(() => resolve({ ORDER_PAYMENT_DELAY_MS: 'fast' })).toThrow(
      VerificationConfigError
    );
  });

  it('整数を要求する項目に小数を渡すと例外になる', () => {
    expect(() => resolve({ ORDER_STREAM_PARALLELIZATION_FACTOR: '2.5' })).toThrow(
      /整数/
    );
  });

  it('小数を許す項目（失敗率）は小数を受け付ける', () => {
    expect(resolve({ ORDER_PAYMENT_FAILURE_RATE: '0.05' }).paymentFailureRate).toBe(0.05);
  });

  it('複数の不正値をまとめて報告する', () => {
    try {
      resolve({
        ORDER_STREAM_PARALLELIZATION_FACTOR: '99',
        ORDER_DATA_TTL_DAYS: '999',
      });
      expect.unreachable('例外が投げられていない');
    } catch (error) {
      expect(error).toBeInstanceOf(VerificationConfigError);
      expect((error as VerificationConfigError).issues).toHaveLength(2);
    }
  });
});

describe('warm throughput の警告（要件 10.8）', () => {
  it('設定されていれば引き下げ不可であることを警告する', () => {
    const messages: string[] = [];
    const config = resolveVerificationConfig({
      env: { ORDER_WARM_THROUGHPUT_WRITE: '40000' },
      onWarning: (message) => messages.push(message),
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('ORDER_WARM_THROUGHPUT_WRITE=40000');
    expect(messages[0]).toContain('下げられません');
    expect(config.warnings).toEqual(messages);
  });

  it('未設定なら警告しない', () => {
    const messages: string[] = [];
    resolveVerificationConfig({ env: {}, onWarning: (m) => messages.push(m) });

    expect(messages).toEqual([]);
  });

  it('書き込み・読み取りの両方を 1 つの警告にまとめる', () => {
    const warnings = buildWarnings({
      warmThroughputWriteUnitsPerSecond: 100_000,
      warmThroughputReadUnitsPerSecond: 4_000,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('ORDER_WARM_THROUGHPUT_WRITE=100000');
    expect(warnings[0]).toContain('ORDER_WARM_THROUGHPUT_READ=4000');
  });
});

/**
 * ここの 67 / 667 は **設計時の想定 D = 3,600ms**（擬似待機 3,500ms +
 * `ASSUMED_STAGE_OVERHEAD_MS` = 100ms）での値であり、design §2.2 が現在載せている
 * 数字ではない。実測 D = 3,652.57ms では式の値が 65.7/分 と 657/分 になる（タスク 14）。
 * **実測の壁の位置はさらに別で、P = 10 では式の 0.84〜0.85 倍（557.5〜569.6/分）である**
 * （design §2.2 の 7'）。P = 1 は式どおり（66.30/分）。
 *
 * この層が検証しているのは `ASSUMED_STAGE_OVERHEAD_MS` を使う合成時の見積もりであり、
 * 定数を変えない限りこの値が正しい。詳細は
 * `amplify/functions/shared/capacity.test.ts` の冒頭コメントを参照。
 */
describe('消費能力の見積もり（design §2.1）', () => {
  it('S × P ÷ D を毎分件数で返す（想定 D: S=4, P=10, D=3.6 秒 → 約 667/分）', () => {
    const capacity = estimateCapacityPerMinute({
      shardCount: 4,
      parallelizationFactor: 10,
      recordProcessingMs: 3_600,
    });

    expect(Math.round(capacity)).toBe(667);
  });

  it('P=1 では S=4, D=3.6 秒 で約 67/分（想定 D。実測 D では 65.7/分）', () => {
    const capacity = estimateCapacityPerMinute({
      shardCount: 4,
      parallelizationFactor: 1,
      recordProcessingMs: 3_600,
    });

    expect(Math.round(capacity)).toBe(67);
  });

  it('処理時間が 0 以下なら例外にする', () => {
    expect(() =>
      estimateCapacityPerMinute({
        shardCount: 4,
        parallelizationFactor: 1,
        recordProcessingMs: 0,
      })
    ).toThrow(RangeError);
  });

  it('既定値では D = 擬似待機 3500ms + オーバーヘッド想定 = 3600ms になる', () => {
    const { capacity } = resolve({});

    expect(capacity.pseudoDelayMs).toBe(3_500);
    expect(capacity.assumedOverheadMs).toBe(ASSUMED_STAGE_OVERHEAD_MS);
    expect(capacity.recordProcessingMs).toBe(3_600);
    expect(capacity.assumedShardCount).toBe(ASSUMED_OPEN_SHARD_COUNT);
    expect(Math.round(capacity.estimatedCapacityPerMinute)).toBe(67);
  });

  it('PF を上げると見積もりが比例して増える', () => {
    const { capacity } = resolve({ ORDER_STREAM_PARALLELIZATION_FACTOR: '10' });

    expect(capacity.parallelizationFactor).toBe(10);
    expect(Math.round(capacity.estimatedCapacityPerMinute)).toBe(667);
  });

  it('擬似処理時間を下げると見積もりが増える（シナリオ A6 の条件）', () => {
    const { capacity } = resolve({
      ORDER_STREAM_PARALLELIZATION_FACTOR: '10',
      ORDER_PAYMENT_DELAY_MS: '100',
    });

    // D = 100 + 500 + 100 = 700ms → 4 × 10 × 60000 / 700
    expect(capacity.recordProcessingMs).toBe(700);
    expect(Math.round(capacity.estimatedCapacityPerMinute)).toBe(3_429);
  });
});
