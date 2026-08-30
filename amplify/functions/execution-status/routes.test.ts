import type { APIGatewayProxyEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES, ApiError } from '../shared/http.js';
import { MAX_ID_LENGTH } from '../shared/order-keys.js';
import { EXECUTION_STATUS_RESOURCE, resolveExecutionId } from './routes.js';

/**
 * 実行 ID の取り出しの単体テスト（要件 11.6 / 12.5、design §5.8）。
 *
 * 主眼は実行 ID に含まれる `#` が壊れないこと。
 * `LOAD#{ULID}` は URL で percent-encode されて届くため、
 * デコードの有無を取り違えると**正しい実行 ID が 404 になる**。
 */

const LOAD_TEST_ID = 'LOAD#01J000000000000000000000';

function buildEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    resource: EXECUTION_STATUS_RESOURCE,
    path: '/executions/LOAD%2301J000000000000000000000',
    pathParameters: { executionId: LOAD_TEST_ID },
    queryStringParameters: null,
    ...overrides,
  } as APIGatewayProxyEvent;
}

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

describe('resolveExecutionId', () => {
  it('pathParameters を優先する', () => {
    expect(resolveExecutionId(buildEvent())).toBe(LOAD_TEST_ID);
  });

  /**
   * タスク 13 で実測した API Gateway の実挙動（`order-query` と同じ）。
   * REST API は `pathParameters` をデコードせずに渡す。
   */
  it('pathParameters が percent-encode されたまま届いてもデコードする', () => {
    expect(
      resolveExecutionId(
        buildEvent({ pathParameters: { executionId: 'LOAD%2301J000000000000000000000' } })
      )
    ).toBe(LOAD_TEST_ID);
  });

  it('pathParameters が無ければパスセグメントをデコードする', () => {
    const executionId = resolveExecutionId(
      buildEvent({
        resource: undefined,
        pathParameters: null,
        path: '/executions/LOAD%2301J000000000000000000000',
      })
    );
    expect(executionId).toBe(LOAD_TEST_ID);
  });

  it('デコード済みのパスをそのまま渡しても壊さない（二重デコードしない）', () => {
    const executionId = resolveExecutionId(
      buildEvent({ pathParameters: null, path: `/executions/${LOAD_TEST_ID}` })
    );
    expect(executionId).toBe(LOAD_TEST_ID);
  });

  it('前後の空白を落とす', () => {
    expect(
      resolveExecutionId(buildEvent({ pathParameters: { executionId: ` ${LOAD_TEST_ID} ` } }))
    ).toBe(LOAD_TEST_ID);
  });

  it('接頭辞を検証しない（並行計測の実行 ID も通す。design §4.3）', () => {
    // 実行管理テーブルは 2 種類の実行を共有する。ここで接頭辞を列挙すると
    // タスク 18 の接頭辞を足し忘れたときに正しい ID を 400 で弾いてしまう
    expect(
      resolveExecutionId(buildEvent({ pathParameters: { executionId: 'MEASURE#01J' } }))
    ).toBe('MEASURE#01J');
  });

  it('末尾のスラッシュを気にしない', () => {
    expect(
      resolveExecutionId(
        buildEvent({ pathParameters: null, path: `/executions/${LOAD_TEST_ID}/` })
      )
    ).toBe(LOAD_TEST_ID);
  });
});

describe('resolveExecutionId: 400 になる入力', () => {
  it('実行 ID が空', () => {
    expectApiError(
      () => resolveExecutionId(buildEvent({ pathParameters: { executionId: '  ' } })),
      API_ERROR_CODES.INVALID_REQUEST
    );
  });

  it('`{executionId}` が素通りしている（マッピング漏れ）', () => {
    expectApiError(
      () =>
        resolveExecutionId(
          buildEvent({ pathParameters: { executionId: '{executionId}' } })
        ),
      API_ERROR_CODES.INVALID_REQUEST
    );
  });

  it('パスが /executions/{id} の形でない', () => {
    expectApiError(
      () => resolveExecutionId(buildEvent({ pathParameters: null, path: '/executions' })),
      API_ERROR_CODES.INVALID_REQUEST
    );
  });

  it(`実行 ID が ${MAX_ID_LENGTH} 文字を超える`, () => {
    expectApiError(
      () =>
        resolveExecutionId(
          buildEvent({ pathParameters: { executionId: 'L'.repeat(MAX_ID_LENGTH + 1) } })
        ),
      API_ERROR_CODES.INVALID_REQUEST
    );
  });

  it(`${MAX_ID_LENGTH} 文字ちょうどは通す（境界）`, () => {
    const executionId = 'L'.repeat(MAX_ID_LENGTH);
    expect(
      resolveExecutionId(buildEvent({ pathParameters: { executionId } }))
    ).toBe(executionId);
  });
});
