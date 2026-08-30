import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  ApiError,
  CORS_HEADERS,
  ERROR_STATUS_CODES,
  INTERNAL_ERROR_MESSAGE,
  accepted,
  created,
  errorResponse,
  executionNotFound,
  internalError,
  invalidRequest,
  jsonResponse,
  ok,
  orderNotFound,
  parameterOutOfRange,
  parseJsonBody,
  toErrorResponse,
  unknownSku,
} from './http.js';

/**
 * API レスポンス整形の単体テスト（design §E-1 / §5.8）。
 *
 * 検証の主眼は 3 点。
 *
 * 1. **全応答に CORS ヘッダーが付く**こと（付け忘れるとブラウザ側でステータスすら読めない）
 * 2. エラーコードとステータスの対応が design §E-1 の表どおりであること
 * 3. 500 応答が内部の事情を漏らさないこと（design §E-1「詳細はログのみ」）
 */

/** ヘッダーの取り出し（型を絞るための補助） */
function headersOf(response: { headers?: Record<string, unknown> }): Record<string, unknown> {
  return response.headers ?? {};
}

describe('CORS ヘッダー（design §E-1: 全応答に付ける）', () => {
  const responses = {
    'ok（200）': ok({ value: 1 }),
    'created（201）': created({ value: 1 }),
    'accepted（202）': accepted({ value: 1 }),
    'invalidRequest（400）': invalidRequest('不正'),
    'unknownSku（400）': unknownSku('未知の SKU'),
    'parameterOutOfRange（400）': parameterOutOfRange('範囲外'),
    'orderNotFound（404）': orderNotFound('見つからない'),
    'internalError（500）': internalError(),
    'jsonResponse（任意）': jsonResponse(418, {}),
  };

  for (const [label, response] of Object.entries(responses)) {
    it(`${label} に CORS ヘッダーが付く`, () => {
      expect(headersOf(response)).toMatchObject(CORS_HEADERS);
    });
  }

  it('全オリジンを許可する（検証用 API。design §8）', () => {
    expect(CORS_HEADERS['Access-Control-Allow-Origin']).toBe('*');
  });

  it('JSON の Content-Type を付ける', () => {
    expect(headersOf(ok({}))['Content-Type']).toBe('application/json');
  });
});

describe('エラーコードとステータスの対応（design §E-1）', () => {
  it('design §E-1 の表と一致する', () => {
    expect(ERROR_STATUS_CODES).toEqual({
      INVALID_REQUEST: 400,
      UNKNOWN_SKU: 400,
      ORDER_NOT_FOUND: 404,
      EXECUTION_NOT_FOUND: 404,
      PARAMETER_OUT_OF_RANGE: 400,
      INTERNAL_ERROR: 500,
    });
  });

  it('design §E-1 に無いコードを持たない', () => {
    expect(Object.keys(API_ERROR_CODES).sort()).toEqual([
      'EXECUTION_NOT_FOUND',
      'INTERNAL_ERROR',
      'INVALID_REQUEST',
      'ORDER_NOT_FOUND',
      'PARAMETER_OUT_OF_RANGE',
      'UNKNOWN_SKU',
    ]);
  });

  it('注文と実行の 404 を別のコードで返す（要件 2.4 / 11.6）', () => {
    // 同じ 404 でも `error` の値が異なる。フロントエンドはコードで分岐するため、
    // 実行状態のポーリングで「注文が無い」と案内しないことを担保する
    expect(orderNotFound('x').statusCode).toBe(404);
    expect(executionNotFound('x').statusCode).toBe(404);
    expect(JSON.parse(orderNotFound('x').body).error).toBe('ORDER_NOT_FOUND');
    expect(JSON.parse(executionNotFound('x').body).error).toBe('EXECUTION_NOT_FOUND');
  });

  it('各ヘルパーが対応するステータスを返す', () => {
    expect(invalidRequest('x').statusCode).toBe(400);
    expect(unknownSku('x').statusCode).toBe(400);
    expect(parameterOutOfRange('x').statusCode).toBe(400);
    expect(orderNotFound('x').statusCode).toBe(404);
    expect(executionNotFound('x').statusCode).toBe(404);
    expect(internalError().statusCode).toBe(500);
  });
});

describe('エラー本文の形（design §E-1: { error, message, details? }）', () => {
  it('error と message を含む', () => {
    const body = JSON.parse(errorResponse(API_ERROR_CODES.UNKNOWN_SKU, '未知の SKU').body);
    expect(body).toEqual({ error: 'UNKNOWN_SKU', message: '未知の SKU' });
  });

  it('details を渡したときだけ details を含む', () => {
    const body = JSON.parse(
      errorResponse(API_ERROR_CODES.UNKNOWN_SKU, '未知の SKU', { sku: 'ITEM#NOPE' }).body
    );
    expect(body).toEqual({
      error: 'UNKNOWN_SKU',
      message: '未知の SKU',
      details: { sku: 'ITEM#NOPE' },
    });
  });

  it('details を渡さないときはキー自体を持たない（null と区別するため）', () => {
    const body = JSON.parse(errorResponse(API_ERROR_CODES.INVALID_REQUEST, '不正').body);
    expect('details' in body).toBe(false);
  });

  it('details に null を渡したときは null として保持する', () => {
    const body = JSON.parse(
      errorResponse(API_ERROR_CODES.INVALID_REQUEST, '不正', null).body
    );
    expect(body.details).toBeNull();
  });
});

describe('toErrorResponse: 例外から応答への変換', () => {
  it('ApiError は宣言どおりのコード・ステータス・details で返る', () => {
    const response = toErrorResponse(
      new ApiError(API_ERROR_CODES.ORDER_NOT_FOUND, '注文が存在しません', {
        orderId: 'ORD#X',
      })
    );
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toEqual({
      error: 'ORDER_NOT_FOUND',
      message: '注文が存在しません',
      details: { orderId: 'ORD#X' },
    });
  });

  it('ApiError 以外は 500 INTERNAL_ERROR に丸める', () => {
    const response = toErrorResponse(new Error('ResourceNotFoundException: table foo'));
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      error: 'INTERNAL_ERROR',
      message: INTERNAL_ERROR_MESSAGE,
    });
  });

  it('丸めた例外のメッセージを応答に含めない（design §E-1: 詳細はログのみ）', () => {
    const secret = 'ResourceNotFoundException: kiro-roasters-orders-ab12cd34 が見つからない';
    const response = toErrorResponse(new Error(secret));
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain('details');
  });

  it('例外でない値（文字列など）を投げられても 500 で返す', () => {
    expect(toErrorResponse('落ちた').statusCode).toBe(500);
    expect(toErrorResponse(undefined).statusCode).toBe(500);
  });

  it('ApiError の statusCode はコードから導出される', () => {
    expect(new ApiError(API_ERROR_CODES.UNKNOWN_SKU, 'x').statusCode).toBe(400);
    expect(new ApiError(API_ERROR_CODES.INTERNAL_ERROR, 'x').statusCode).toBe(500);
  });
});

describe('parseJsonBody', () => {
  it('JSON オブジェクトを解釈する', () => {
    expect(parseJsonBody('{"customerId":"CUST#test-0001"}')).toEqual({
      customerId: 'CUST#test-0001',
    });
  });

  it('本文なし・空文字・空白のみは空オブジェクトとして扱う（要件 1.2）', () => {
    expect(parseJsonBody(null)).toEqual({});
    expect(parseJsonBody(undefined)).toEqual({});
    expect(parseJsonBody('')).toEqual({});
    expect(parseJsonBody('   ')).toEqual({});
  });

  it('不正な JSON は 400 INVALID_REQUEST の ApiError を投げる', () => {
    let thrown: unknown;
    try {
      parseJsonBody('{ items: ');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).code).toBe(API_ERROR_CODES.INVALID_REQUEST);
    expect((thrown as ApiError).statusCode).toBe(400);
  });

  it('配列・スカラーは JSON オブジェクトではないため弾く', () => {
    for (const body of ['[]', '"text"', '42', 'null']) {
      expect(() => parseJsonBody(body)).toThrow(ApiError);
    }
  });
});
