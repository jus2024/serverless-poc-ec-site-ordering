/**
 * `POST /measure/start` のリクエスト検証と実行 ID の生成（要件 12.1 / 12.5 / 12.7、design §8）。
 *
 * `load-generator/load-test-request.ts` と同じ方針で、上限の判定を AWS クライアント抜きで
 * 単体テストできる純粋関数として切り出している（design §12）。
 *
 * ## 省略を許さない（既定値を持たない）
 *
 * `concurrency` と `durationSeconds` は**必須**にしている。並行計測は
 * 照会 API に負荷を掛ける装置であり、空の POST が「なんらかの既定の並行数で」
 * リクエストを撃ち始める挙動は避けたい（`load-generator` と同じ判断）。
 *
 * ## 継続時間の上限が 2 つある
 *
 * | 上限 | 出典 | 理由 |
 * |------|------|------|
 * | `maxDurationSeconds` | 環境変数（design §10.1） | 課金の暴走を防ぐ（design §8） |
 * | `MAX_MEASURE_DURATION_SECONDS` | 本モジュールの定数 | 1 回の invoke で測り切るため |
 *
 * 後者は**レイテンシを全件記録して分位点を出す**（要件 12.3）という要求から来ている。
 * 詳細は `MAX_MEASURE_DURATION_SECONDS` の注記を参照。
 * 厳しい方が効くため、両方を満たす値だけを受け付ける。
 */

import { monotonicFactory } from 'ulid';
import { API_ERROR_CODES, ApiError } from '../shared/http.js';
import { MAX_ID_LENGTH } from '../shared/order-keys.js';
import type { StartQueryImpactRequest } from '../shared/types.js';
import type { QueryTarget } from './query-target.js';

/**
 * 並行計測の実行 ID の接頭辞。
 *
 * 実行管理テーブルは負荷生成と共有する（design §4.3）ため、PK を見ただけで
 * どちらの実行か分かるようにしている（`LOAD#` と対になる）。
 */
export const QUERY_IMPACT_ID_PREFIX = 'MEASURE#';

/** 並行数の下限。0 並行の計測は成立しない */
export const MIN_CONCURRENCY = 1;

/** 継続時間の下限（秒） */
export const MIN_DURATION_SECONDS = 1;

/**
 * 1 回の invoke で測り切れる継続時間の上限（秒）。
 *
 * `query-impact-measure` のタイムアウトは 15 分（design §5.2）。
 * そこから分位点の算出と実行レコードの更新に使う余裕を差し引いた 14 分にしている。
 *
 * ## なぜ自己再帰で伸ばさないのか
 *
 * `load-generator` は残り時間が尽きると自身を非同期 invoke して引き継ぐ
 * （`load-generator/load-plan.ts`）。並行計測で同じことをすると
 * **分位点が正しく出せない。**
 *
 * 要件 12.3 の分位点は全リクエストのレイテンシから算出する必要がある
 * （`shared/percentiles.ts` は最近順位法で、標本の集合そのものを必要とする）。
 * 世代を跨ぐには標本を非同期 invoke のペイロードで持ち回ることになるが、
 * その上限は 256KB であり、2 分の計測で出る数万件を載せられない。
 * 標本を世代ごとに切って分位点を取れば、それは
 * 「実行全体の p99」ではなく「最後の世代の p99」になる。
 * 波及の裾を見るための指標（要件 12.3）が別物にすり替わる。
 *
 * したがって並行計測は**1 回の invoke で完結させ**、収まらない継続時間は
 * 受け付けない（400 `PARAMETER_OUT_OF_RANGE`）。design §10.2 の
 * 並行計測は 2 分なので、実際のシナリオはすべてこの範囲に収まる。
 */
export const MAX_MEASURE_DURATION_SECONDS = 840;

/**
 * 対象を省略したときに照会する顧客 ID。
 *
 * `shared/catalog.ts` の `randomCustomerId` が割り当てる範囲
 * （`test-0001`〜`test-0500`）の先頭。負荷生成が投入した注文は
 * この範囲に散るため、既定の対象でも実データのある一覧照会になる。
 *
 * 既定を顧客別一覧（`GET /orders?customerId=`）にして注文 1 件照会にしないのは、
 * **存在しない注文 ID を既定にすると全リクエストが 404 になる**からである。
 * 404 は要件 12.2 の分類では「その他のエラー」に入るため、
 * 対象を指定し忘れた計測が「エラー率 100%」として記録されてしまう。
 * 一覧照会は該当が 0 件でも 200 を返し、GSI への `Query` は実際に走る。
 */
export const DEFAULT_TARGET_CUSTOMER_ID = 'test-0001';

/** 検証済みの並行計測パラメータ */
export interface MeasureParams {
  /** 並行数（要件 12.7） */
  concurrency: number;
  /** 継続時間（秒） */
  durationSeconds: number;
  /** 計測対象の照会 API */
  target: QueryTarget;
  /**
   * 並行して走らせている負荷生成の実行 ID（要件 12.5）。
   *
   * 投入レートそのものをこのレコードに書き写さない理由は
   * `execution-record.ts` の注記を参照。
   */
  loadTestId?: string;
}

/** 上限（`shared/runtime-config.ts` の `RuntimeVerificationParams` から渡す） */
export interface MeasureLimits {
  maxMeasureConcurrency: number;
  maxDurationSeconds: number;
}

/**
 * ULID 生成器（実行 ID 用）。
 * 単調増加版を使う理由は `load-generator/load-test-request.ts` と同じ。
 */
const nextUlid = monotonicFactory();

/** 新しい並行計測の実行 ID を生成する */
export function newQueryImpactId(): string {
  return `${QUERY_IMPACT_ID_PREFIX}${nextUlid()}`;
}

/**
 * 有効な継続時間の上限を返す（環境変数の上限と invoke の budget の厳しい方）。
 */
export function resolveMaxDurationSeconds(limits: MeasureLimits): number {
  return Math.min(limits.maxDurationSeconds, MAX_MEASURE_DURATION_SECONDS);
}

/**
 * リクエスト本文を検証する。
 *
 * @param body `parseJsonBody` が返した JSON オブジェクト
 * @param limits デプロイ済みの上限（`resolveVerificationParams` の戻り値から渡す）
 * @throws {ApiError} 400 `INVALID_REQUEST`（必須項目の欠落・型の誤り・対象の二重指定）
 * @throws {ApiError} 400 `PARAMETER_OUT_OF_RANGE`（上限超過・下限未満。design §8）
 */
export function parseStartMeasureRequest(
  body: Record<string, unknown>,
  limits: MeasureLimits
): MeasureParams {
  const request = body as StartQueryImpactRequest;

  const params: MeasureParams = {
    concurrency: requireBoundedInteger({
      value: request.concurrency,
      field: 'concurrency',
      min: MIN_CONCURRENCY,
      max: limits.maxMeasureConcurrency,
      maxField: 'maxMeasureConcurrency',
    }),
    durationSeconds: requireBoundedInteger({
      value: request.durationSeconds,
      field: 'durationSeconds',
      min: MIN_DURATION_SECONDS,
      max: resolveMaxDurationSeconds(limits),
      maxField: 'maxDurationSeconds',
    }),
    target: resolveTarget(request),
  };

  const loadTestId = readOptionalId(request.loadTestId, 'loadTestId');
  if (loadTestId !== undefined) {
    params.loadTestId = loadTestId;
  }

  return params;
}

/**
 * 計測対象を決める。
 *
 * `orderId` と `customerId` の同時指定は**拒否する**。どちらを優先しても
 * 「指定したのに測られていない対象」が生まれ、計測結果を読み違える。
 * 実行レコードには対象が残らない（design §4.3 に対象の属性が無い）ため、
 * 取り違えを後から検知できないことが拒否する決め手である。
 */
function resolveTarget(request: StartQueryImpactRequest): QueryTarget {
  const orderId = readOptionalId(request.orderId, 'orderId');
  const customerId = readOptionalId(request.customerId, 'customerId');

  if (orderId !== undefined && customerId !== undefined) {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      'orderId と customerId は同時に指定できません（計測対象を 1 つに絞ってください）'
    );
  }
  if (orderId !== undefined) {
    return { kind: 'ORDER_DETAIL', orderId };
  }
  return { kind: 'ORDER_LIST', customerId: customerId ?? DEFAULT_TARGET_CUSTOMER_ID };
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
 * 必須の整数パラメータを読み、範囲を検証する
 * （`load-generator/load-test-request.ts` と同じ規則・同じ `details` の形）。
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

/**
 * 省略可能な ID を読む。空文字は未指定として扱う
 * （`.env` 経由で組み立てたリクエストで `""` が入りやすいため）。
 */
function readOptionalId(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      `${field} は文字列で指定してください`
    );
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (trimmed.length > MAX_ID_LENGTH) {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      `${field} が長すぎます（上限 ${MAX_ID_LENGTH} 文字）`
    );
  }
  return trimmed;
}
