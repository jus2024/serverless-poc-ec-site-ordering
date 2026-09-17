/**
 * API レスポンスの生成とエラー整形（design §E-1 / §5.8）。
 *
 * ## CORS を全応答に付ける
 *
 * フロントエンドは Amplify Hosting（または `next dev`）から
 * API Gateway の別オリジンを叩くため、**エラー応答にも** CORS ヘッダーが必要である。
 * 付け忘れるとブラウザ側ではステータスコードすら読めず、
 * 「400 が返っている」ことに気づけない。ヘッダー付与を関数に閉じ込め、
 * ハンドラが素の `statusCode` / `body` を組み立てないようにしている。
 *
 * オリジンは全許可（`*`）にする。検証用の API で認証を掛けていないため
 * 絞る意味がなく、検証者のローカルホストとホスティング環境の双方から叩ける必要がある
 * （design §8 に記載の割り切り）。
 *
 * ## エラーコードは design §E-1 の表がすべて
 *
 * コードを増やすときは design を先に更新する。フロントエンドは
 * `error` の値で分岐するため、勝手なコードを足すと画面側が無言で「想定外」に落ちる。
 */

import type { APIGatewayProxyResult } from 'aws-lambda';
import type { ErrorResponse } from './types.js';

/** 全応答に付けるヘッダー（design §E-1「全応答に CORS ヘッダーを付ける」） */
export const CORS_HEADERS: Readonly<Record<string, string>> = {
  'Access-Control-Allow-Origin': '*',
  // `Authorization` は Cognito 認証（方式 A）で全リクエストに付く。
  // プリフライトの許可内容（`order-api.ts` の `ORDER_API_CORS.allowHeaders`）と揃える
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
} as const;

/** JSON 応答の共通ヘッダー */
const JSON_HEADERS: Readonly<Record<string, string>> = {
  ...CORS_HEADERS,
  'Content-Type': 'application/json',
} as const;

/**
 * エラーコード（design §E-1 の表と 1 対 1）。
 *
 * | コード | 状況 | ステータス |
 * |-------|------|----------|
 * | `INVALID_REQUEST` | リクエスト本文が不正な JSON、必須項目の欠落 | 400 |
 * | `UNKNOWN_SKU` | 商品マスタに存在しない SKU（要件 1.8） | 400 |
 * | `ORDER_NOT_FOUND` | 注文が存在しない（要件 2.4） | 404 |
 * | `EXECUTION_NOT_FOUND` | 実行が存在しない（要件 11.6 / 12.5） | 404 |
 * | `PARAMETER_OUT_OF_RANGE` | 検証パラメータが上限超過（design §8 の緩和策） | 400 |
 * | `INTERNAL_ERROR` | 想定外の例外。詳細はログのみ | 500 |
 *
 * `EXECUTION_NOT_FOUND` を `ORDER_NOT_FOUND` と分けているのは、
 * 実行 ID が見つからない原因が注文とは異なるためである。
 * 実行レコードは TTL（既定 7 日。design 論点 5）で消えるため、
 * 「打ち間違い」と「保持期限を過ぎた実行の照会」の双方がこのコードに来る。
 * フロントエンドは `error` の値で分岐する（design §E-1）ので、
 * 注文の 404 と同じコードにすると実行状態のポーリング（要件 11.6）で
 * 「注文が無い」という誤った案内を出すことになる。
 */
export const API_ERROR_CODES = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNKNOWN_SKU: 'UNKNOWN_SKU',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  EXECUTION_NOT_FOUND: 'EXECUTION_NOT_FOUND',
  PARAMETER_OUT_OF_RANGE: 'PARAMETER_OUT_OF_RANGE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

/** エラーコードから HTTP ステータスへの対応（design §E-1） */
export const ERROR_STATUS_CODES: Readonly<Record<ApiErrorCode, number>> = {
  INVALID_REQUEST: 400,
  UNKNOWN_SKU: 400,
  ORDER_NOT_FOUND: 404,
  EXECUTION_NOT_FOUND: 404,
  PARAMETER_OUT_OF_RANGE: 400,
  INTERNAL_ERROR: 500,
} as const;

/**
 * 業務的に説明できるエラー。ハンドラはこれを投げ、境界で `toErrorResponse` に渡す。
 *
 * `details` はクライアントに返る。返してよい情報だけを入れること
 * （不足していた SKU の一覧、範囲外だったパラメータ名など）。
 * スタックトレースや SDK の生エラーは入れない。
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = ERROR_STATUS_CODES[code];
    this.details = details;
  }
}

/** JSON 応答を組み立てる。ヘッダーの付与を強制するための唯一の入口 */
export function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { ...JSON_HEADERS },
    body: JSON.stringify(body),
  };
}

/** 200 OK */
export function ok(body: unknown): APIGatewayProxyResult {
  return jsonResponse(200, body);
}

/** 201 Created（`POST /orders` など、資源を作った応答） */
export function created(body: unknown): APIGatewayProxyResult {
  return jsonResponse(201, body);
}

/** 202 Accepted（負荷生成・並行計測の開始。処理は非同期に続く） */
export function accepted(body: unknown): APIGatewayProxyResult {
  return jsonResponse(202, body);
}

/**
 * エラー応答を組み立てる（本文は `{ error, message, details? }`。design §E-1）。
 *
 * `details` が `undefined` のときはキー自体を含めない。
 * `"details": null` を返すと、クライアント側で「詳細が無い」と
 * 「詳細が null だった」の区別がつかなくなる。
 */
export function errorResponse(
  code: ApiErrorCode,
  message: string,
  details?: unknown
): APIGatewayProxyResult {
  const body: ErrorResponse = { error: code, message };
  if (details !== undefined) {
    body.details = details;
  }
  return jsonResponse(ERROR_STATUS_CODES[code], body);
}

/** 400 `INVALID_REQUEST` */
export function invalidRequest(message: string, details?: unknown): APIGatewayProxyResult {
  return errorResponse(API_ERROR_CODES.INVALID_REQUEST, message, details);
}

/** 400 `UNKNOWN_SKU`（要件 1.8。注文を作成しないこと） */
export function unknownSku(message: string, details?: unknown): APIGatewayProxyResult {
  return errorResponse(API_ERROR_CODES.UNKNOWN_SKU, message, details);
}

/** 404 `ORDER_NOT_FOUND`（要件 2.4） */
export function orderNotFound(message: string, details?: unknown): APIGatewayProxyResult {
  return errorResponse(API_ERROR_CODES.ORDER_NOT_FOUND, message, details);
}

/** 404 `EXECUTION_NOT_FOUND`（要件 11.6 / 12.5。TTL で消えた実行の照会もここに来る） */
export function executionNotFound(
  message: string,
  details?: unknown
): APIGatewayProxyResult {
  return errorResponse(API_ERROR_CODES.EXECUTION_NOT_FOUND, message, details);
}

/** 400 `PARAMETER_OUT_OF_RANGE`（design §8 の緩和策） */
export function parameterOutOfRange(
  message: string,
  details?: unknown
): APIGatewayProxyResult {
  return errorResponse(API_ERROR_CODES.PARAMETER_OUT_OF_RANGE, message, details);
}

/** 想定外の例外に返す固定メッセージ。内部の事情を漏らさない（design §E-1） */
export const INTERNAL_ERROR_MESSAGE = '内部エラーが発生しました';

/**
 * 500 `INTERNAL_ERROR`。**詳細は返さない**（design §E-1「詳細はログのみ」）。
 *
 * 例外の内容はテーブル名・キー・スタックトレースを含み得るため、
 * 認証のない API では応答に載せない（design §8）。
 */
export function internalError(): APIGatewayProxyResult {
  return errorResponse(API_ERROR_CODES.INTERNAL_ERROR, INTERNAL_ERROR_MESSAGE);
}

/**
 * 捕捉した例外を応答へ変換する。ハンドラの `catch` はこれ 1 つを呼ぶ。
 *
 * `ApiError` は宣言どおりのコードと `details` で返し、
 * それ以外は 500 `INTERNAL_ERROR` に丸める。**丸めた例外は呼び出し側でログに出すこと**
 * （この関数はログを出さない。ログの出し方をハンドラ側の構造化ログに委ねるため）。
 */
export function toErrorResponse(error: unknown): APIGatewayProxyResult {
  if (error instanceof ApiError) {
    return errorResponse(error.code, error.message, error.details);
  }
  return internalError();
}

/**
 * リクエスト本文を JSON として読む。
 *
 * 本文なし（`null` / 空文字）は `{}` として扱う。
 * 引数を全て省略できる API（`POST /orders` は明細を省略するとランダム生成する。要件 1.2）で
 * 本文が空のリクエストを正当なものとして受けるためである。
 *
 * @throws {ApiError} JSON として解釈できない、またはオブジェクトでない場合（400 `INVALID_REQUEST`）
 */
export function parseJsonBody(body: string | null | undefined): Record<string, unknown> {
  if (body === null || body === undefined || body.trim() === '') {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      'リクエスト本文が JSON として解釈できません'
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      'リクエスト本文は JSON オブジェクトである必要があります'
    );
  }
  return parsed as Record<string, unknown>;
}
