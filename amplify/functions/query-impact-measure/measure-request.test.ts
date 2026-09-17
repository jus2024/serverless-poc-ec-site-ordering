import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES, ApiError } from '../shared/http.js';
import { MAX_ID_LENGTH } from '../shared/order-keys.js';
import {
  DEFAULT_TARGET_CUSTOMER_ID,
  MAX_MEASURE_DURATION_SECONDS,
  MIN_CONCURRENCY,
  MIN_DURATION_SECONDS,
  QUERY_IMPACT_ID_PREFIX,
  newQueryImpactId,
  parseStartMeasureRequest,
  resolveMaxDurationSeconds,
} from './measure-request.js';

/**
 * `POST /measure/start` の検証規則の単体テスト（要件 12.1 / 12.7、design §8）。
 *
 * 確かめるのは 4 点。
 *
 * 1. 並行数・継続時間の上限超過が 400 `PARAMETER_OUT_OF_RANGE` になること
 * 2. 継続時間の上限が「環境変数の上限」と「1 invoke で測り切る上限」の厳しい方になること
 * 3. 対象の既定が顧客別一覧であること（既定で全件 404 にならないこと）
 * 4. 対象の二重指定を拒否すること
 */

const LIMITS = { maxMeasureConcurrency: 200, maxDurationSeconds: 3_600 };

function expectApiError(execute: () => unknown, code: string): ApiError {
  let caught: unknown;
  try {
    execute();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApiError);
  const apiError = caught as ApiError;
  expect(apiError.code).toBe(code);
  return apiError;
}

describe('newQueryImpactId', () => {
  it('MEASURE#{ULID} 形式である', () => {
    expect(newQueryImpactId()).toMatch(/^MEASURE#[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('接頭辞で並行計測の実行だと判別できる（実行管理テーブルは共用。design §4.3）', () => {
    expect(newQueryImpactId().startsWith(QUERY_IMPACT_ID_PREFIX)).toBe(true);
  });

  it('生成順にソートできる', () => {
    const ids = Array.from({ length: 200 }, () => newQueryImpactId());
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('resolveMaxDurationSeconds', () => {
  it('環境変数の上限が invoke の budget より緩い場合は budget が効く', () => {
    expect(resolveMaxDurationSeconds({ ...LIMITS, maxDurationSeconds: 7_200 })).toBe(
      MAX_MEASURE_DURATION_SECONDS
    );
  });

  it('環境変数の上限の方が厳しい場合はそちらが効く', () => {
    expect(resolveMaxDurationSeconds({ ...LIMITS, maxDurationSeconds: 60 })).toBe(60);
  });

  it('invoke の budget は Lambda のタイムアウト 15 分に収まる（design §5.2）', () => {
    expect(MAX_MEASURE_DURATION_SECONDS).toBeLessThan(15 * 60);
  });
});

describe('parseStartMeasureRequest', () => {
  it('指定した値をそのまま返す', () => {
    expect(
      parseStartMeasureRequest(
        { concurrency: 60, durationSeconds: 120, customerId: 'test-0042' },
        LIMITS
      )
    ).toEqual({
      concurrency: 60,
      durationSeconds: 120,
      target: { kind: 'ORDER_LIST', customerId: 'test-0042' },
    });
  });

  it('orderId を指定すると注文 1 件照会が対象になる', () => {
    const params = parseStartMeasureRequest(
      { concurrency: 10, durationSeconds: 60, orderId: 'ORD#01JABCDE' },
      LIMITS
    );
    expect(params.target).toEqual({ kind: 'ORDER_DETAIL', orderId: 'ORD#01JABCDE' });
  });

  it('対象を省略すると顧客別一覧になる（全件 404 にならない既定）', () => {
    const params = parseStartMeasureRequest({ concurrency: 10, durationSeconds: 60 }, LIMITS);
    expect(params.target).toEqual({
      kind: 'ORDER_LIST',
      customerId: DEFAULT_TARGET_CUSTOMER_ID,
    });
  });

  it('orderId と customerId の同時指定は 400 INVALID_REQUEST', () => {
    expectApiError(
      () =>
        parseStartMeasureRequest(
          {
            concurrency: 10,
            durationSeconds: 60,
            orderId: 'ORD#01JABCDE',
            customerId: 'test-0001',
          },
          LIMITS
        ),
      API_ERROR_CODES.INVALID_REQUEST
    );
  });

  it('空文字の対象は未指定として扱う', () => {
    const params = parseStartMeasureRequest(
      { concurrency: 10, durationSeconds: 60, orderId: '  ', customerId: '' },
      LIMITS
    );
    expect(params.target).toEqual({
      kind: 'ORDER_LIST',
      customerId: DEFAULT_TARGET_CUSTOMER_ID,
    });
  });

  it('loadTestId を指定すると保持する（要件 12.5 の突き合わせ用）', () => {
    const params = parseStartMeasureRequest(
      { concurrency: 10, durationSeconds: 60, loadTestId: 'LOAD#01JABCDE' },
      LIMITS
    );
    expect(params.loadTestId).toBe('LOAD#01JABCDE');
  });

  it('loadTestId を省略すると未設定のまま（自己申告の値を埋めない）', () => {
    const params = parseStartMeasureRequest({ concurrency: 10, durationSeconds: 60 }, LIMITS);
    expect(params.loadTestId).toBeUndefined();
  });

  it('concurrency の省略を許さない（既定の並行数で撃ち始めない）', () => {
    expectApiError(
      () => parseStartMeasureRequest({ durationSeconds: 60 }, LIMITS),
      API_ERROR_CODES.INVALID_REQUEST
    );
  });

  it('durationSeconds の省略を許さない', () => {
    expectApiError(
      () => parseStartMeasureRequest({ concurrency: 10 }, LIMITS),
      API_ERROR_CODES.INVALID_REQUEST
    );
  });

  it.each([
    ['文字列', '10'],
    ['真偽値', true],
    ['小数', 10.5],
    ['NaN', Number.NaN],
  ])('concurrency が %s なら 400 INVALID_REQUEST', (_label, value) => {
    expectApiError(
      () => parseStartMeasureRequest({ concurrency: value, durationSeconds: 60 }, LIMITS),
      API_ERROR_CODES.INVALID_REQUEST
    );
  });

  it('orderId が長すぎれば 400 INVALID_REQUEST', () => {
    expectApiError(
      () =>
        parseStartMeasureRequest(
          { concurrency: 10, durationSeconds: 60, orderId: 'x'.repeat(MAX_ID_LENGTH + 1) },
          LIMITS
        ),
      API_ERROR_CODES.INVALID_REQUEST
    );
  });
});

describe('parseStartMeasureRequest の上限（design §8 の緩和策）', () => {
  it('並行数が上限を超えたら 400 PARAMETER_OUT_OF_RANGE', () => {
    const error = expectApiError(
      () =>
        parseStartMeasureRequest(
          { concurrency: LIMITS.maxMeasureConcurrency + 1, durationSeconds: 60 },
          LIMITS
        ),
      API_ERROR_CODES.PARAMETER_OUT_OF_RANGE
    );
    expect(error.statusCode).toBe(400);
    expect(error.details).toEqual({
      concurrency: LIMITS.maxMeasureConcurrency + 1,
      min: MIN_CONCURRENCY,
      maxMeasureConcurrency: LIMITS.maxMeasureConcurrency,
    });
  });

  it('継続時間が上限を超えたら 400 PARAMETER_OUT_OF_RANGE', () => {
    const error = expectApiError(
      () =>
        parseStartMeasureRequest(
          { concurrency: 10, durationSeconds: MAX_MEASURE_DURATION_SECONDS + 1 },
          LIMITS
        ),
      API_ERROR_CODES.PARAMETER_OUT_OF_RANGE
    );
    expect(error.details).toEqual({
      durationSeconds: MAX_MEASURE_DURATION_SECONDS + 1,
      min: MIN_DURATION_SECONDS,
      maxDurationSeconds: MAX_MEASURE_DURATION_SECONDS,
    });
  });

  it('上限は引数で決まる（環境変数で下げた上限がそのまま効く）', () => {
    const tightened = { maxMeasureConcurrency: 10, maxDurationSeconds: 30 };
    expect(() =>
      parseStartMeasureRequest({ concurrency: 10, durationSeconds: 30 }, tightened)
    ).not.toThrow();
    expectApiError(
      () => parseStartMeasureRequest({ concurrency: 11, durationSeconds: 30 }, tightened),
      API_ERROR_CODES.PARAMETER_OUT_OF_RANGE
    );
    expectApiError(
      () => parseStartMeasureRequest({ concurrency: 10, durationSeconds: 31 }, tightened),
      API_ERROR_CODES.PARAMETER_OUT_OF_RANGE
    );
  });

  it('下限未満は 400 PARAMETER_OUT_OF_RANGE', () => {
    expectApiError(
      () => parseStartMeasureRequest({ concurrency: 0, durationSeconds: 60 }, LIMITS),
      API_ERROR_CODES.PARAMETER_OUT_OF_RANGE
    );
    expectApiError(
      () => parseStartMeasureRequest({ concurrency: 10, durationSeconds: 0 }, LIMITS),
      API_ERROR_CODES.PARAMETER_OUT_OF_RANGE
    );
  });

  it('design §10.2 の並行計測（2 分）は既定の上限で通る', () => {
    expect(
      parseStartMeasureRequest({ concurrency: 60, durationSeconds: 120 }, LIMITS)
        .durationSeconds
    ).toBe(120);
  });
});
