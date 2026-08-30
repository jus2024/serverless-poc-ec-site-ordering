/**
 * `POST /load-test/start` のリクエスト検証と実行 ID の生成（要件 11.1〜11.3 / 11.5、design §8）。
 *
 * ハンドラから純粋関数として切り出しているのは、上限の判定を
 * AWS クライアント抜きで単体テストするためである（design §12）。
 *
 * ## 省略を許さない（既定値を持たない）
 *
 * 他の API（`POST /orders`、`POST /inventory/seed`）は引数を省略できるが、
 * この API は `ordersPerMinute` と `durationSeconds` を**必須**にしている。
 * 負荷生成は課金の支配要因（design §7.3）であり、空の POST が
 * 「なんらかの既定レートで」注文を投入し始める挙動は避けたい。
 * 何件/分を何秒流すのかは、検証者が毎回明示する。
 *
 * `useRampCurve` だけは省略可（既定 false = 定常負荷）。
 * 壁の位置を測るシナリオでは定常負荷を使うのが原則であり（design 論点 2）、
 * 省略時に原則側へ寄せる方が事故が少ない。
 *
 * ## 上限は実行時設定から受け取る
 *
 * `maxOrdersPerMinute` / `maxDurationSeconds` は環境変数で変えられる
 * （`shared/runtime-config.ts`）。上限をこのモジュールに定数で焼き込むと、
 * デプロイ済みの設定と検証結果が食い違う。上限は引数で渡す。
 */

import { monotonicFactory } from 'ulid';
import { API_ERROR_CODES, ApiError } from '../shared/http.js';
import type { StartLoadTestRequest } from '../shared/types.js';

/**
 * 負荷テスト実行 ID の接頭辞。
 *
 * 実行管理テーブルは負荷生成と並行計測で共有する（design §4.3）ため、
 * PK を見ただけでどちらの実行か分かるようにしている
 * （`execution_type` を読まずに判別できる。ログを追うときに効く）。
 *
 * `#` を含む ID は URL パスに入れる際にエスケープが必要になるが、
 * 注文 ID（`ORD#{ULID}`）と同じ規則であり、照会側は
 * `order-query/routes.ts` と同様に `decodeURIComponent` で受ける。
 */
export const LOAD_TEST_ID_PREFIX = 'LOAD#';

/** 投入レートの下限（件/分）。0 件/分の実行は意味を持たない */
export const MIN_ORDERS_PER_MINUTE = 1;

/** 継続時間の下限（秒） */
export const MIN_DURATION_SECONDS = 1;

/** 検証済みの負荷生成パラメータ */
export interface LoadTestParams {
  /** 目標投入レート（件/分。要件 11.1） */
  ordersPerMinute: number;
  /** 継続時間（秒） */
  durationSeconds: number;
  /** true なら負荷カーブ（要件 11.2）、false なら定常負荷（要件 11.3） */
  useRampCurve: boolean;
}

/** 上限（`shared/runtime-config.ts` の `RuntimeVerificationParams` から渡す） */
export interface LoadTestLimits {
  maxOrdersPerMinute: number;
  maxDurationSeconds: number;
}

/**
 * ULID 生成器（実行 ID 用）。
 *
 * 注文 ID と同じ理由で単調増加版を使う（`shared/order-record.ts` の注記）。
 * 実行 ID は毎分数件しか作らないので衝突の心配はないが、
 * 実行レコードを PK でソートしたときに開始順に並ぶ方が読みやすい。
 */
const nextUlid = monotonicFactory();

/** 新しい負荷テスト実行 ID を生成する（要件 11.5） */
export function newLoadTestId(): string {
  return `${LOAD_TEST_ID_PREFIX}${nextUlid()}`;
}

/**
 * リクエスト本文を検証する。
 *
 * @param body `parseJsonBody` が返した JSON オブジェクト
 * @param limits デプロイ済みの上限（`resolveVerificationParams` の戻り値から渡す）
 * @throws {ApiError} 400 `INVALID_REQUEST`（必須項目の欠落・型の誤り）
 * @throws {ApiError} 400 `PARAMETER_OUT_OF_RANGE`（上限超過・下限未満。design §8）
 */
export function parseStartLoadTestRequest(
  body: Record<string, unknown>,
  limits: LoadTestLimits
): LoadTestParams {
  const request = body as StartLoadTestRequest;

  return {
    ordersPerMinute: requireBoundedInteger({
      value: request.ordersPerMinute,
      field: 'ordersPerMinute',
      min: MIN_ORDERS_PER_MINUTE,
      max: limits.maxOrdersPerMinute,
      maxField: 'maxOrdersPerMinute',
    }),
    durationSeconds: requireBoundedInteger({
      value: request.durationSeconds,
      field: 'durationSeconds',
      min: MIN_DURATION_SECONDS,
      max: limits.maxDurationSeconds,
      maxField: 'maxDurationSeconds',
    }),
    useRampCurve: readOptionalBoolean(request.useRampCurve, 'useRampCurve') ?? false,
  };
}

interface BoundedIntegerInput {
  value: unknown;
  field: string;
  min: number;
  max: number;
  /** 上限の出典（環境変数由来であることを応答の `details` で示す） */
  maxField: string;
}

/**
 * 必須の整数パラメータを読み、範囲を検証する。
 *
 * 範囲外は `PARAMETER_OUT_OF_RANGE`（400）で返し、`details` に
 * 受け取った値と有効な上限を載せる。上限はデプロイ済みの環境変数で決まるので、
 * 検証者が「どこを直せばよいか」を応答だけで判断できるようにしている。
 */
function requireBoundedInteger(input: BoundedIntegerInput): number {
  const { value, field, min, max, maxField } = input;

  if (value === undefined || value === null) {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      `${field} は必須です（範囲: ${min}〜${max}）`
    );
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      `${field} は数値で指定してください`
    );
  }
  if (!Number.isInteger(value)) {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      `${field} は整数で指定してください`
    );
  }
  if (value < min || value > max) {
    throw new ApiError(
      API_ERROR_CODES.PARAMETER_OUT_OF_RANGE,
      `${field} が範囲外です（範囲: ${min}〜${max}）`,
      { [field]: value, min, [maxField]: max }
    );
  }

  return value;
}

/** 省略可能な真偽値を読む。文字列の "true" は受け付けない（型の揺れを許さない） */
function readOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      `${field} は真偽値で指定してください`
    );
  }
  return value;
}
