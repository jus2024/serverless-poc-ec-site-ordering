import { afterEach, describe, expect, it } from 'vitest';
import { ORDER_TABLE_ENV_KEYS } from '../../custom/order-tables.js';
import { VERIFICATION_ENV_VARS } from '../../custom/verification-config.js';
import {
  RUNTIME_DEFAULTS,
  RUNTIME_ENV_VARS,
  RUNTIME_TABLE_ENV_KEYS,
  RuntimeConfigError,
  expiresAtFromNow,
  getVerificationParams,
  requireTableName,
  resetRuntimeConfigCache,
  resolveRuntimeConfig,
  resolveTableNames,
  resolveVerificationParams,
} from './runtime-config.js';

/**
 * 実行時設定の単体テスト（design §10.1 / §5.3、要件 10.5 / 16.4）。
 *
 * 検証の主眼は 3 点。
 *
 * 1. **環境変数のキー名が合成側と一致していること**。
 *    ここが食い違うと合成は通り、デプロイも成功し、実行時にだけ静かに壊れる
 * 2. テーブル名が未設定なら**声を上げて落ちること**（既定名を推測しない）
 * 3. 範囲外の検証パラメータを既定値へ読み替えないこと（要件 10.5）
 */

/** 必須のテーブル名だけを埋めた環境変数 */
const TABLES_ENV: Record<string, string> = {
  ORDERS_TABLE_NAME: 'kiro-roasters-orders-ab12cd34',
  ORDER_INVENTORY_TABLE_NAME: 'kiro-roasters-order-inventory-ab12cd34',
  ORDER_IDEMPOTENCY_TABLE_NAME: 'kiro-roasters-order-idempotency-ab12cd34',
  ORDER_EXECUTIONS_TABLE_NAME: 'kiro-roasters-order-executions-ab12cd34',
  ORDERS_CUSTOMER_INDEX_NAME: 'customer-orders-index',
};

afterEach(() => {
  resetRuntimeConfigCache();
});

describe('環境変数キーの同期（合成側との重複）', () => {
  it('テーブル名のキーが order-tables.ts の ORDER_TABLE_ENV_KEYS と一致する', () => {
    // 重複した定義が同じ値を指していることを機械的に確かめる。
    // どちらかを変えたらこのテストが落ちる
    expect(RUNTIME_TABLE_ENV_KEYS).toEqual(ORDER_TABLE_ENV_KEYS);
  });

  it('検証パラメータのキーは design §10.1（verification-config.ts）の部分集合である', () => {
    const verificationKeys = new Set(VERIFICATION_ENV_VARS);
    const tableKeys = new Set<string>(Object.values(RUNTIME_TABLE_ENV_KEYS));
    const paramKeys = RUNTIME_ENV_VARS.filter((key) => !tableKeys.has(key));

    expect(paramKeys.length).toBeGreaterThan(0);
    for (const key of paramKeys) {
      expect(verificationKeys.has(key), `${key} が design §10.1 に存在しない`).toBe(true);
    }
  });

  it('実行時に読む環境変数はテーブル名と検証パラメータの和集合である', () => {
    expect(new Set(RUNTIME_ENV_VARS).size).toBe(RUNTIME_ENV_VARS.length);
    for (const key of Object.values(RUNTIME_TABLE_ENV_KEYS)) {
      expect(RUNTIME_ENV_VARS).toContain(key);
    }
  });
});

describe('テーブル名の解決', () => {
  it('設定された物理名をそのまま返す', () => {
    expect(requireTableName('ordersTableName', { env: TABLES_ENV })).toBe(
      TABLES_ENV.ORDERS_TABLE_NAME
    );
    expect(resolveTableNames({ env: TABLES_ENV })).toEqual({
      orders: TABLES_ENV.ORDERS_TABLE_NAME,
      inventory: TABLES_ENV.ORDER_INVENTORY_TABLE_NAME,
      idempotency: TABLES_ENV.ORDER_IDEMPOTENCY_TABLE_NAME,
      executions: TABLES_ENV.ORDER_EXECUTIONS_TABLE_NAME,
      ordersCustomerIndex: TABLES_ENV.ORDERS_CUSTOMER_INDEX_NAME,
    });
  });

  it('前後の空白を落とす', () => {
    expect(requireTableName('ordersTableName', { env: { ORDERS_TABLE_NAME: '  t  ' } })).toBe(
      't'
    );
  });

  it('未設定なら例外を投げる（既定名を推測しない）', () => {
    expect(() => requireTableName('ordersTableName', { env: {} })).toThrow(RuntimeConfigError);
    expect(() => requireTableName('ordersTableName', { env: {} })).toThrow(
      /ORDERS_TABLE_NAME/
    );
  });

  it('空文字も未設定と同じ扱いにする', () => {
    expect(() => requireTableName('ordersTableName', { env: { ORDERS_TABLE_NAME: '  ' } })).toThrow(
      RuntimeConfigError
    );
  });

  it('未設定のキーをまとめて報告する（配線漏れを 1 回で洗い出す）', () => {
    let thrown: unknown;
    try {
      resolveTableNames({ env: { ORDERS_TABLE_NAME: 'orders' } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RuntimeConfigError);
    expect((thrown as RuntimeConfigError).issues).toHaveLength(4);
    expect((thrown as RuntimeConfigError).message).toContain('ORDER_INVENTORY_TABLE_NAME');
    expect((thrown as RuntimeConfigError).message).toContain('ORDERS_CUSTOMER_INDEX_NAME');
  });
});

describe('検証パラメータの既定値（design §10.1 の「既定」列）', () => {
  it('未設定なら既定値を返す', () => {
    expect(resolveVerificationParams({ env: {} })).toEqual({
      paymentDelayMs: 3000,
      notificationDelayMs: 500,
      paymentFailureRate: 0,
      dataTtlDays: 7,
      maxOrdersPerMinute: 20000,
      maxDurationSeconds: 3600,
      maxMeasureConcurrency: 200,
      streamBatchSize: 1,
      streamParallelizationFactor: 1,
    });
  });

  it('RUNTIME_DEFAULTS がそのまま解決結果になる', () => {
    expect(resolveVerificationParams({ env: {} })).toEqual({ ...RUNTIME_DEFAULTS });
  });

  it('空文字は未設定と同じ扱い（.env.example の `KEY=` 形式）', () => {
    expect(resolveVerificationParams({ env: { ORDER_PAYMENT_DELAY_MS: '' } }).paymentDelayMs).toBe(
      3000
    );
  });

  it('設定された値を採用する', () => {
    const params = resolveVerificationParams({
      env: {
        ORDER_PAYMENT_DELAY_MS: '100',
        ORDER_NOTIFICATION_DELAY_MS: '0',
        ORDER_PAYMENT_FAILURE_RATE: '0.25',
        ORDER_DATA_TTL_DAYS: '1',
        ORDER_STREAM_PARALLELIZATION_FACTOR: '10',
        ORDER_STREAM_BATCH_SIZE: '5',
      },
    });
    expect(params.paymentDelayMs).toBe(100);
    expect(params.notificationDelayMs).toBe(0);
    expect(params.paymentFailureRate).toBe(0.25);
    expect(params.dataTtlDays).toBe(1);
    expect(params.streamParallelizationFactor).toBe(10);
    expect(params.streamBatchSize).toBe(5);
  });
});

describe('検証パラメータの不正値（要件 10.5: 既定値へ読み替えない）', () => {
  const invalidCases: [string, Record<string, string>][] = [
    ['数値でない', { ORDER_PAYMENT_DELAY_MS: 'fast' }],
    ['上限超過（決済遅延）', { ORDER_PAYMENT_DELAY_MS: '60001' }],
    ['負値（決済遅延）', { ORDER_PAYMENT_DELAY_MS: '-1' }],
    ['小数（整数指定）', { ORDER_PAYMENT_DELAY_MS: '100.5' }],
    ['失敗率が 1 を超える', { ORDER_PAYMENT_FAILURE_RATE: '1.5' }],
    ['TTL が 0 日', { ORDER_DATA_TTL_DAYS: '0' }],
    ['TTL が 31 日', { ORDER_DATA_TTL_DAYS: '31' }],
    ['PF が 11（AWS の上限超過）', { ORDER_STREAM_PARALLELIZATION_FACTOR: '11' }],
    ['batchSize が 0', { ORDER_STREAM_BATCH_SIZE: '0' }],
    ['投入レート上限が 100001', { ORDER_MAX_ORDERS_PER_MINUTE: '100001' }],
    ['継続時間上限が 7201 秒', { ORDER_MAX_DURATION_SECONDS: '7201' }],
    ['並行数上限が 1001', { ORDER_MAX_MEASURE_CONCURRENCY: '1001' }],
    ['Infinity', { ORDER_PAYMENT_DELAY_MS: 'Infinity' }],
  ];

  for (const [label, env] of invalidCases) {
    it(`${label} は例外になる`, () => {
      expect(() => resolveVerificationParams({ env })).toThrow(RuntimeConfigError);
    });
  }

  it('境界値は受け付ける', () => {
    expect(() =>
      resolveVerificationParams({
        env: {
          ORDER_PAYMENT_DELAY_MS: '60000',
          ORDER_NOTIFICATION_DELAY_MS: '0',
          ORDER_PAYMENT_FAILURE_RATE: '1',
          ORDER_DATA_TTL_DAYS: '30',
          ORDER_STREAM_PARALLELIZATION_FACTOR: '1',
          ORDER_STREAM_BATCH_SIZE: '10000',
          ORDER_MAX_ORDERS_PER_MINUTE: '100000',
          ORDER_MAX_DURATION_SECONDS: '7200',
          ORDER_MAX_MEASURE_CONCURRENCY: '1000',
        },
      })
    ).not.toThrow();
  });

  it('複数の誤りをまとめて報告する', () => {
    let thrown: unknown;
    try {
      resolveVerificationParams({
        env: { ORDER_PAYMENT_DELAY_MS: '-1', ORDER_DATA_TTL_DAYS: '99' },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RuntimeConfigError);
    expect((thrown as RuntimeConfigError).issues).toHaveLength(2);
  });

  it('メッセージに受け取った値と許容範囲を含める', () => {
    let thrown: unknown;
    try {
      resolveVerificationParams({ env: { ORDER_STREAM_PARALLELIZATION_FACTOR: '42' } });
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as RuntimeConfigError).message;
    expect(message).toContain('ORDER_STREAM_PARALLELIZATION_FACTOR');
    expect(message).toContain('42');
    expect(message).toContain('1〜10');
  });
});

describe('resolveRuntimeConfig', () => {
  it('テーブル名と検証パラメータをまとめて返す', () => {
    const config = resolveRuntimeConfig({ env: { ...TABLES_ENV, ORDER_DATA_TTL_DAYS: '3' } });
    expect(config.tables.orders).toBe(TABLES_ENV.ORDERS_TABLE_NAME);
    expect(config.params.dataTtlDays).toBe(3);
  });

  it('テーブル名が欠けていれば検証パラメータが正しくても失敗する', () => {
    expect(() => resolveRuntimeConfig({ env: { ORDER_DATA_TTL_DAYS: '3' } })).toThrow(
      RuntimeConfigError
    );
  });
});

describe('getVerificationParams: キャッシュ', () => {
  it('同じインスタンスを返す（実行環境の再利用中は再解決しない）', () => {
    expect(getVerificationParams()).toBe(getVerificationParams());
  });

  it('キャッシュを破棄すると再解決する', () => {
    const first = getVerificationParams();
    resetRuntimeConfigCache();
    const second = getVerificationParams();
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });
});

describe('expiresAtFromNow: TTL（要件 17.6 / design 論点 5）', () => {
  it('起点から指定日数後の Unix 秒を返す', () => {
    const nowMs = Date.UTC(2025, 0, 1, 0, 0, 0);
    expect(expiresAtFromNow(7, nowMs)).toBe(nowMs / 1000 + 7 * 86_400);
  });

  it('既定の 7 日は 604800 秒後', () => {
    const nowMs = 1_700_000_000_000;
    expect(expiresAtFromNow(RUNTIME_DEFAULTS.dataTtlDays, nowMs) - nowMs / 1000).toBe(604_800);
  });

  it('秒未満を切り捨てる（DynamoDB の TTL は秒精度）', () => {
    expect(expiresAtFromNow(1, 1_700_000_000_999)).toBe(1_700_000_000 + 86_400);
  });

  it('整数を返す', () => {
    expect(Number.isInteger(expiresAtFromNow(30, Date.now()))).toBe(true);
  });
});
