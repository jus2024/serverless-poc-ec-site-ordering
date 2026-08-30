/**
 * 初期在庫投入 Lambda（`POST /inventory/seed`。要件 5.7 / 5.9、design 論点 6 / §5.2）。
 *
 * ## なぜ専用の関数が必要なのか
 *
 * 引当は `quantity >= :qty` の条件付き減算で行う（要件 5.5）。在庫レコードが
 * 存在しない場合も在庫不足と同じ扱いになる（要件 5.6）ため、**在庫を入れずに
 * 検証を始めると全注文が `ALLOCATION_FAILED` で終わる**。決済までは通るので
 * 一見動いているように見え、原因に気づくまで時間を取られる。
 * 検証の前提を整える操作なので、シナリオ実行の手順（design §13）にも組み込む。
 *
 * ## 検証者が手で 1 度叩く API である
 *
 * 負荷は掛からない（240 件の投入が 10 回の `BatchWriteItem` で終わる）。
 * 冪等性の仕組み（Powertools）も使わない。二重に叩かれても同じ値で
 * 上書きされるだけで、`PutRequest` の性質からそれ自体が冪等である。
 *
 * タイムアウトを 15 分・メモリ 512MB で取る想定（design §5.2）だが、
 * これは在庫数を大きくしても、あるいは将来 SKU を増やしても
 * 途中で切れないようにするための余裕であり、実測は 1 秒未満で終わる。
 *
 * ## 応答に投入件数を含める（要件 5.7）
 *
 * 「何件入ったか」を返さないと、検証者は在庫テーブルを別途覗くまで
 * 投入が完了したのか分からない。`retryCount` も返しているのは、
 * 0 でなければテーブル側が詰まっていた（= 容量に余裕がない状態から
 * 検証を始めようとしている）という手掛かりになるからである。
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { BatchWriteCommand, type BatchWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDocumentClient } from '../shared/ddb.js';
import { ApiError, ok, parseJsonBody, toErrorResponse } from '../shared/http.js';
import { requireTableName } from '../shared/runtime-config.js';
import type { SeedInventoryResponse } from '../shared/types.js';
import {
  MAX_UNPROCESSED_RETRIES,
  buildInventoryRecords,
  chunkIntoBatchWriteInputs,
  countBatchWriteItems,
  parseSeedInventoryRequest,
  retryDelayMs,
  toRetryInput,
} from './seed-plan.js';

const SERVICE_NAME = 'inventory-seed';

const logger = new Logger({ serviceName: SERVICE_NAME });

/**
 * `UnprocessedItems` が再送上限まで残ったときの例外。
 *
 * `ApiError` にしない（= 500 `INTERNAL_ERROR` に丸める）。
 * 呼び出し側のリクエストは正しく、直せるのは検証者ではなくテーブルの状態であるため、
 * 400 系で返すのは誤った案内になる。詳細はログにだけ出す（design §E-1）。
 */
class UnprocessedItemsRemainingError extends Error {
  constructor(readonly remainingCount: number) {
    super(
      `初期在庫の投入に失敗しました（${MAX_UNPROCESSED_RETRIES} 回の再送後も ${remainingCount} 件が未処理）`
    );
    this.name = 'UnprocessedItemsRemainingError';
  }
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const startedAt = Date.now();

  try {
    const params = parseSeedInventoryRequest(parseJsonBody(event.body));
    const records = buildInventoryRecords(params);
    const batches = chunkIntoBatchWriteInputs(
      requireTableName('inventoryTableName'),
      records
    );

    let retryCount = 0;
    // バッチは直列に送る。10 リクエストしかなく、並列化しても体感は変わらない。
    // 並列に投げると自分でスロットルを作り、UnprocessedItems の再送が増えるだけである。
    for (const batch of batches) {
      retryCount += await writeBatchWithRetry(batch);
    }

    const response: SeedInventoryResponse = {
      warehouseId: params.warehouseId,
      initialQuantity: params.initialQuantity,
      seededCount: records.length,
      batchCount: batches.length,
      retryCount,
      seedLatencyMs: Date.now() - startedAt,
    };

    logger.info('初期在庫を投入しました', { ...response });
    return ok(response);
  } catch (error) {
    // order-accept / order-query と同じ方針。呼び出し側の入力ミスは warn に留め、
    // ERROR ログの件数を「システム側の異常」の指標として使えるようにする
    if (error instanceof ApiError) {
      logger.warn('初期在庫の投入を拒否しました', {
        errorCode: error.code,
        message: error.message,
        details: error.details,
      });
    } else {
      logger.error('初期在庫の投入に失敗しました', { error });
    }
    return toErrorResponse(error);
  }
};

/**
 * 1 バッチを送り、`UnprocessedItems` が返ったら再送する。
 *
 * @returns 再送した回数（0 なら 1 回で書けた）
 * @throws {UnprocessedItemsRemainingError} 再送上限まで書き残しが消えなかった場合
 */
async function writeBatchWithRetry(batch: BatchWriteCommandInput): Promise<number> {
  const client = getDocumentClient();
  let pending: BatchWriteCommandInput | undefined = batch;
  let retryCount = 0;

  while (pending !== undefined) {
    const output = await client.send(new BatchWriteCommand(pending));
    const next = toRetryInput(output.UnprocessedItems);

    if (next === undefined) {
      return retryCount;
    }

    const remainingCount = countBatchWriteItems(next);
    if (retryCount >= MAX_UNPROCESSED_RETRIES) {
      throw new UnprocessedItemsRemainingError(remainingCount);
    }

    retryCount += 1;
    logger.warn('BatchWriteItem に未処理の書き込みが残りました。再送します', {
      attempt: retryCount,
      remainingCount,
    });
    await sleep(retryDelayMs(retryCount));
    pending = next;
  }

  return retryCount;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
