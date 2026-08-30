import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES, ApiError } from '../shared/http.js';
import { MAX_ID_LENGTH } from '../shared/order-keys.js';
import {
  LOAD_TEST_ID_PREFIX,
  MIN_DURATION_SECONDS,
  MIN_ORDERS_PER_MINUTE,
  newLoadTestId,
  parseStartLoadTestRequest,
} from './load-test-request.js';

/**
 * `POST /load-test/start` の検証規則の単体テスト（要件 11.1〜11.3 / 11.5、design §8）。
 *
 * 確かめるのは 3 点。
 *
 * 1. 上限超過が 400 `PARAMETER_OUT_OF_RANGE` になること（design §8 の緩和策）
 * 2. 上限が引数の値から決まること（環境変数で変わるため定数で焼き込んでいないこと）
 * 3. 必須項目の省略で負荷生成が始まらないこと
 */

const LIMITS = { maxOrdersPerMinute: 20_000, maxDurationSeconds: 3_600 };

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

describe('newLoadTestId（要件 11.5）', () => {
  it('LOAD#{ULID} 形式である', () => {
    expect(newLoadTestId()).toMatch(/^LOAD#[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('注文レコードの load_test_id に収まる長さである', () => {
    expect(newLoadTestId().length).toBeLessThanOrEqual(MAX_ID_LENGTH);
  });

  it('生成順にソートできる（実行レコードを PK で並べたときに開始順になる）', () => {
    const ids = Array.from({ length: 200 }, () => newLoadTestId());
    expect([...ids].sort()).toEqual(ids);
  });

  it('接頭辞で負荷テストの実行だと判別できる（実行管理テーブルは共用。design §4.3）', () => {
    expect(newLoadTestId().startsWith(LOAD_TEST_ID_PREFIX)).toBe(true);
  });
});

describe('parseStartLoadTestRequest（要件 11.1〜11.3）', () => {
  it('指定した値をそのまま返す', () => {
    expect(
      parseStartLoadTestRequest(
        { ordersPerMinute: 2_000, durationSeconds: 600, useRampCurve: true },
        LIMITS
      )
    ).toEqual({ ordersPerMinute: 2_000, durationSeconds: 600, useRampCurve: true });
  });

  it('useRampCurve の既定は false（定常負荷。要件 11.3、design 論点 2）', () => {
    const params = parseStartLoadTestRequest(
      { ordersPerMinute: 100, durationSeconds: 60 },
      LIMITS
    );
    expect(params.useRampCurve).toBe(false);
  });

  it('ordersPerMinute の省略を許さない（既定レートで投入を始めない）', () => {
    expectApiError(
      () => parseStartLoadTestRequest({ durationSeconds: 60 }, LIMITS),
      API_ERROR_CODES.INVALID_REQUEST
    );
  });

  it('durationSeconds の省略を許さない', () => {
    expectApiError(
      () => parseStartLoadTestRequest({ ordersPerMinute: 100 }, LIMITS),
      API_ERROR_CODES.INVALID_REQUEST
    );
  });

  it.each([
    ['文字列', '100'],
    ['真偽値', true],
    ['小数', 10.5],
    ['NaN', Number.NaN],
  ])('ordersPerMinute が %s なら 400 INVALID_REQUEST', (_label, value) => {
    expectApiError(
      () =>
        parseStartLoadTestRequest(
          { ordersPerMinute: value, durationSeconds: 60 },
          LIMITS
        ),
      API_ERROR_CODES.INVALID_REQUEST
    );
  });

  it('useRampCurve が真偽値でなければ 400 INVALID_REQUEST（"true" を受け付けない）', () => {
    expectApiError(
      () =>
        parseStartLoadTestRequest(
          { ordersPerMinute: 100, durationSeconds: 60, useRampCurve: 'true' },
          LIMITS
        ),
      API_ERROR_CODES.INVALID_REQUEST
    );
  });
});

describe('parseStartLoadTestRequest の上限（design §8 の緩和策）', () => {
  it('投入レートが上限を超えたら 400 PARAMETER_OUT_OF_RANGE', () => {
    const error = expectApiError(
      () =>
        parseStartLoadTestRequest(
          { ordersPerMinute: LIMITS.maxOrdersPerMinute + 1, durationSeconds: 60 },
          LIMITS
        ),
      API_ERROR_CODES.PARAMETER_OUT_OF_RANGE
    );
    expect(error.statusCode).toBe(400);
    expect(error.details).toEqual({
      ordersPerMinute: LIMITS.maxOrdersPerMinute + 1,
      min: MIN_ORDERS_PER_MINUTE,
      maxOrdersPerMinute: LIMITS.maxOrdersPerMinute,
    });
  });

  it('継続時間が上限を超えたら 400 PARAMETER_OUT_OF_RANGE', () => {
    const error = expectApiError(
      () =>
        parseStartLoadTestRequest(
          { ordersPerMinute: 100, durationSeconds: LIMITS.maxDurationSeconds + 1 },
          LIMITS
        ),
      API_ERROR_CODES.PARAMETER_OUT_OF_RANGE
    );
    expect(error.details).toEqual({
      durationSeconds: LIMITS.maxDurationSeconds + 1,
      min: MIN_DURATION_SECONDS,
      maxDurationSeconds: LIMITS.maxDurationSeconds,
    });
  });

  it('上限は引数で決まる（環境変数で下げた上限がそのまま効く）', () => {
    const tightened = { maxOrdersPerMinute: 100, maxDurationSeconds: 60 };
    expect(() =>
      parseStartLoadTestRequest({ ordersPerMinute: 100, durationSeconds: 60 }, tightened)
    ).not.toThrow();
    expectApiError(
      () =>
        parseStartLoadTestRequest(
          { ordersPerMinute: 101, durationSeconds: 60 },
          tightened
        ),
      API_ERROR_CODES.PARAMETER_OUT_OF_RANGE
    );
  });

  it('上限ちょうどは許可する', () => {
    expect(
      parseStartLoadTestRequest(
        {
          ordersPerMinute: LIMITS.maxOrdersPerMinute,
          durationSeconds: LIMITS.maxDurationSeconds,
        },
        LIMITS
      )
    ).toEqual({
      ordersPerMinute: LIMITS.maxOrdersPerMinute,
      durationSeconds: LIMITS.maxDurationSeconds,
      useRampCurve: false,
    });
  });

  it('下限未満は 400 PARAMETER_OUT_OF_RANGE（0 件/分の実行を作らない）', () => {
    expectApiError(
      () => parseStartLoadTestRequest({ ordersPerMinute: 0, durationSeconds: 60 }, LIMITS),
      API_ERROR_CODES.PARAMETER_OUT_OF_RANGE
    );
    expectApiError(
      () => parseStartLoadTestRequest({ ordersPerMinute: 100, durationSeconds: 0 }, LIMITS),
      API_ERROR_CODES.PARAMETER_OUT_OF_RANGE
    );
  });

  it('要件 11.7 の範囲（2〜16,000 件/分）を既定の上限で通せる', () => {
    for (const ordersPerMinute of [2, 16_000]) {
      expect(
        parseStartLoadTestRequest({ ordersPerMinute, durationSeconds: 600 }, LIMITS)
          .ordersPerMinute
      ).toBe(ordersPerMinute);
    }
  });
});
