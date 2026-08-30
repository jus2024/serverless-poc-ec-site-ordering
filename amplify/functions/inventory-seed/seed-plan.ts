/**
 * `POST /inventory/seed` のリクエスト検証と投入計画の組み立て（要件 5.7 / 5.9、design 論点 6）。
 *
 * ハンドラ（`handler.ts`）から純粋関数として切り出しているのは、
 * 「何件を、どのキーで、いくつずつ書くのか」を AWS クライアント抜きで
 * 単体テストするためである（design §12）。この層は DynamoDB を呼ばず、
 * `BatchWriteItem` の**入力を作るところまで**で終わる。
 *
 * ## なぜ `BatchWriteItem` なのか
 *
 * 商品マスタは 240 SKU（`shared/catalog.ts`）あり、単一倉庫（要件 5.9）なので
 * 投入するレコードも 240 件である。`PutItem` を 240 回叩くと往復が 240 回になる。
 * `BatchWriteItem` は 1 回に 25 件まで積めるので 10 回で済む（design §5.9 の
 * 権限も `BatchWriteItem` を前提にしている）。
 *
 * ## 上書きになることは仕様である
 *
 * `PutRequest` なので既存の在庫レコードは**丸ごと置き換わる**。
 * 検証を繰り返すたびに在庫を既定値へ戻したいので、これが望ましい挙動である
 * （前回の実行で減った在庫が残っていると、次の実行の途中で在庫不足に転じ、
 * 「壁の位置」とは無関係な `ALLOCATION_FAILED` が混ざる）。
 * 差分更新にしたい場面は本 Spec には無い。
 *
 * ## `UnprocessedItems` を落とさない
 *
 * `BatchWriteItem` は**部分的に成功する**。容量が足りなければ書けなかった分を
 * `UnprocessedItems` として返し、リクエスト自体は 200 で返る。
 * ここを無視すると「投入件数 240 件」と応答しながら実際は 200 件しか入っておらず、
 * 引当が特定 SKU だけ失敗する状態になる。原因の切り分けが極めて難しくなるため、
 * 再送は必須である（再送のループは時間を扱うのでハンドラ側。判定と遅延の算出はここ）。
 */

import type { BatchWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { CATALOG } from '../shared/catalog.js';
import { API_ERROR_CODES, ApiError } from '../shared/http.js';
import { DEFAULT_WAREHOUSE_ID, inventoryKey } from '../shared/inventory-keys.js';
import type { InventoryRecord, SeedInventoryRequest } from '../shared/types.js';

/** `BatchWriteItem` の 1 リクエストあたりの上限件数（DynamoDB の仕様） */
export const BATCH_WRITE_MAX_ITEMS = 25;

/**
 * 在庫数の既定値（design 論点 6）。
 *
 * 最大規模のシナリオ B3（16,000 件/分 × 10 分）でも
 * 1 SKU あたりの消費は約 2,000 個であり、この値なら全シナリオで枯渇しない。
 * 「在庫が減ったこと」自体は検証の対象ではないので、余裕を大きく取る。
 */
export const DEFAULT_INITIAL_QUANTITY = 10_000_000;

/**
 * 在庫数の上限。
 *
 * 業務上の意味はなく、桁を打ち間違えた投入を弾くためだけの上限である。
 * 既定値（1,000 万）の 100 倍を取っている。
 */
export const MAX_INITIAL_QUANTITY = 1_000_000_000;

/**
 * `UnprocessedItems` の再送回数の上限。
 *
 * 240 件の投入で容量が枯れることは通常ないため、ここに達するのは
 * テーブル側に継続的な問題がある場合である。無限に粘らず打ち切って
 * 500 で返し、検証者に気づかせる方が早い（design §E-1）。
 */
export const MAX_UNPROCESSED_RETRIES = 5;

/** 再送の基準待ち時間（ミリ秒） */
const RETRY_BASE_DELAY_MS = 50;

/** 再送の待ち時間の上限（ミリ秒） */
const RETRY_MAX_DELAY_MS = 1_000;

/** 検証済みの投入条件 */
export interface SeedPlanParams {
  /** 適用する在庫数 */
  initialQuantity: number;
  /** 投入先の倉庫 ID（固定値。要件 5.9） */
  warehouseId: string;
}

/**
 * リクエスト本文を検証する（要件 5.7）。
 *
 * 本文が空なら既定値で投入する（`POST /inventory/seed` を引数なしで叩ける）。
 *
 * @throws {ApiError} 400 `INVALID_REQUEST`（型が不正）
 * @throws {ApiError} 400 `PARAMETER_OUT_OF_RANGE`（範囲外。design §8）
 */
export function parseSeedInventoryRequest(body: Record<string, unknown>): SeedPlanParams {
  return {
    initialQuantity: parseInitialQuantity(body.initialQuantity),
    warehouseId: DEFAULT_WAREHOUSE_ID,
  };
}

/**
 * 投入する在庫レコードを組み立てる（design §4.4）。
 *
 * 商品マスタ全 SKU × 単一倉庫。件数は `CATALOG.length` と必ず一致する。
 *
 * @param nowMs `lastUpdated` の起点（ミリ秒）。既定は現在時刻
 */
export function buildInventoryRecords(
  params: SeedPlanParams,
  nowMs: number = Date.now()
): InventoryRecord[] {
  const lastUpdated = new Date(nowMs).toISOString();

  return CATALOG.map((product) => ({
    ...inventoryKey(product.sku, params.warehouseId),
    itemName: product.name,
    quantity: params.initialQuantity,
    unitPrice: product.price,
    lastUpdated,
  }));
}

/**
 * 在庫レコードを `BatchWriteItem` の入力へ 25 件ずつ分割する。
 *
 * 分割の単位を守るのはこの関数だけの責務にしている。26 件目を積んだ
 * リクエストは `ValidationException` で**リクエストごと**失敗するため、
 * 分割漏れは「一部が入らない」ではなく「そのバッチが全滅する」形で現れる。
 */
export function chunkIntoBatchWriteInputs(
  tableName: string,
  records: readonly InventoryRecord[]
): BatchWriteCommandInput[] {
  const inputs: BatchWriteCommandInput[] = [];

  for (let offset = 0; offset < records.length; offset += BATCH_WRITE_MAX_ITEMS) {
    const chunk = records.slice(offset, offset + BATCH_WRITE_MAX_ITEMS);
    inputs.push({
      RequestItems: {
        [tableName]: chunk.map((record) => ({ PutRequest: { Item: { ...record } } })),
      },
    });
  }

  return inputs;
}

/** `BatchWriteItem` の入力に含まれる書き込み要求の件数を数える（テスト・ログ用） */
export function countBatchWriteItems(input: BatchWriteCommandInput): number {
  return Object.values(input.RequestItems ?? {}).reduce(
    (total, requests) => total + requests.length,
    0
  );
}

/**
 * `UnprocessedItems` を次の再送入力に変換する。書き残しが無ければ `undefined`。
 *
 * DynamoDB は空の `RequestItems` を許さないため、「再送すべきものが無い」ことを
 * 型で表せるようにしている（呼び出し側は `undefined` でループを抜ける）。
 */
export function toRetryInput(
  unprocessedItems: BatchWriteCommandInput['RequestItems'] | undefined
): BatchWriteCommandInput | undefined {
  if (unprocessedItems === undefined) {
    return undefined;
  }

  const remaining = Object.entries(unprocessedItems).filter(
    ([, requests]) => requests.length > 0
  );
  if (remaining.length === 0) {
    return undefined;
  }

  return { RequestItems: Object.fromEntries(remaining) };
}

/**
 * 再送前の待ち時間（ミリ秒）。指数バックオフ。
 *
 * ジッタは入れない。投入は検証者が 1 度だけ叩く操作であり、
 * 競合する書き込み手がいないため散らす相手がいない。
 * 再現性のある待ち時間の方が、詰まったときの読み解きが簡単である。
 *
 * @param attempt 何回目の再送か（1 以上）
 */
export function retryDelayMs(attempt: number): number {
  const exponent = Math.max(1, Math.floor(attempt)) - 1;
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** exponent, RETRY_MAX_DELAY_MS);
}

/**
 * `initialQuantity` を検証する。
 *
 * 0 を許すのは、全注文を在庫不足で失敗させる検証（要件 5.3）に使えるからである。
 * 「未指定」と「0」は別物として扱う（0 を既定値へ読み替えない）。
 */
function parseInitialQuantity(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_INITIAL_QUANTITY;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      'initialQuantity は数値で指定してください'
    );
  }
  if (!Number.isInteger(value)) {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      'initialQuantity は整数で指定してください'
    );
  }
  if (value < 0 || value > MAX_INITIAL_QUANTITY) {
    throw new ApiError(
      API_ERROR_CODES.PARAMETER_OUT_OF_RANGE,
      `initialQuantity が範囲外です（範囲: 0〜${MAX_INITIAL_QUANTITY}）`,
      { initialQuantity: value, maxInitialQuantity: MAX_INITIAL_QUANTITY }
    );
  }

  return value;
}
