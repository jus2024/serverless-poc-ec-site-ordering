/**
 * 後続処理 Lambda（Streams コンシューマ。要件 9.1 / 9.2 / 9.8、design §5.2 / §5.5）。
 *
 * ## この関数が本 PoC の測定対象である
 *
 * 消費能力 `S × P ÷ D` の D は**この関数 1 回の実行時間**である（design §2.1）。
 * したがってハンドラに置く処理は、段階の実行と観測に必要なものだけに絞る。
 * ここに 1 回 DynamoDB の読み取りを足すと、それが全シナリオの
 * 消費能力に乗り、壁の位置がずれる（design §13 の未確定事項 #2）。
 * 注文テーブルを読み直さないのも同じ理由である（`stream-record.ts`）。
 *
 * ## 部分バッチ応答の作り方（design §5.5、要件 9.8）
 *
 * DynamoDB Streams は順序を保証するため、**最初に技術的な失敗が出たレコードで
 * 処理を止め、そのレコード以降をまとめて再試行対象にする**。
 * 先へ進んでから後でまとめて報告すると、再試行時に成功済みのレコードを
 * もう一度処理することになる（冪等性が効くので害はないが、
 * 処理時間 D を二重に消費して消費能力の観測を汚す）。
 *
 * 既定は `BatchSize = 1`（design §5.6）なので、通常この分岐は
 * 「1 件を再試行するか否か」に縮む。`BatchSize` を上げる検証のために
 * 順序の扱いを正しく実装しておく。
 *
 * ## メトリクスは必ず出す
 *
 * `flushMetrics()` を `finally` に置く。技術的な失敗で抜ける経路でも
 * 段階所要時間（EMF）を残さないと、失敗が混ざったシナリオで
 * 処理時間の分布が歪む（`shared/metrics.ts` の注記）。
 *
 * ## X-Ray（要件 13.4、design §6.3）
 *
 * `order_id` をアノテーションに付ける。API 側（`order-accept` / `order-query`）と
 * Streams 側のトレースは自動では連結されないため、注文 ID で突き合わせる。
 * 注釈は `shared/tracing.ts` の `withOrderSubsegment` で付ける
 * （ファサードセグメントに直接付けると黙って捨てられる。理由は同モジュールの注記）。
 *
 * **サブセグメントはレコード単位で開く。** `BatchSize > 1` でも注文ごとに
 * 注釈が分かれる（1 トレースに複数注文が乗っても、どのサブセグメントが
 * どの注文かが分かる）。レコードは直列に処理する（design §5.5）ため、
 * 現在のセグメントを差し替えても他のレコードの計装と混ざらない。
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import type {
  Context,
  DynamoDBBatchResponse,
  DynamoDBRecord,
  DynamoDBStreamEvent,
} from 'aws-lambda';
import { registerIdempotencyLambdaContext } from '../shared/idempotency.js';
import { flushMetrics, recordOrdersProcessed } from '../shared/metrics.js';
import { getVerificationParams, resolveTableNames } from '../shared/runtime-config.js';
import { withOrderSubsegment } from '../shared/tracing.js';
import {
  classifyProcessingFailure,
  type FailureDisposition,
  type FailureKind,
} from './failure-policy.js';
import { processOrder, type StageContext } from './stages.js';
import {
  buildBatchItemFailures,
  isProcessedEvent,
  sequenceNumberOf,
  toStreamOrder,
} from './stream-record.js';

const SERVICE_NAME = 'order-processor';

const logger = new Logger({ serviceName: SERVICE_NAME });
const tracer = new Tracer({ serviceName: SERVICE_NAME });

/** 注文 1 件の処理を表すサブセグメントの名前（design §6.3） */
export const ORDER_SUBSEGMENT_NAME = '## processOrder';

export const handler = async (
  event: DynamoDBStreamEvent,
  context: Context
): Promise<DynamoDBBatchResponse> => {
  // 登録しないと `INPROGRESS` の冪等レコードに失効時刻が入らず、
  // タイムアウトで落ちた注文が再試行で永久に進めなくなる（shared/idempotency.ts）
  registerIdempotencyLambdaContext(context);

  const stageContext: StageContext = {
    tables: resolveTableNames(),
    params: getVerificationParams(),
    logger,
  };

  /** ストリームから去ることが確定した件数（完了 + 業務的な失敗で終端） */
  let processedCount = 0;
  /** 最初に技術的な失敗が出たレコードの位置。-1 は失敗なし */
  let firstFailedIndex = -1;
  let firstError: unknown;

  try {
    for (const [index, record] of event.Records.entries()) {
      try {
        if (await processRecord(record, stageContext)) {
          processedCount += 1;
        }
      } catch (error) {
        const { disposition, kind } = classifyProcessingFailure(error);
        logRecordFailure(record, kind, disposition, error);

        if (disposition === 'RETRY') {
          firstFailedIndex = index;
          firstError = error;
          // 以降のレコードも再試行対象になるため、ここで処理を止める
          break;
        }
      }
    }

    if (processedCount > 0) {
      recordOrdersProcessed(processedCount);
    }

    if (firstFailedIndex < 0) {
      return { batchItemFailures: [] };
    }

    const batchItemFailures = buildBatchItemFailures(event.Records, firstFailedIndex);
    if (batchItemFailures === null) {
      // シーケンス番号を持たないレコードがある。一部だけ報告すると
      // 報告できなかったレコードが成功扱いで失われる（stream-record.ts）
      logger.error('再試行対象を特定できないため、バッチ全体を失敗させます', {
        firstFailedIndex,
        recordCount: event.Records.length,
      });
      throw firstError;
    }

    return { batchItemFailures };
  } finally {
    flushMetrics();
  }
};

/**
 * 1 レコードを処理する。
 *
 * @returns このレコードがストリームから去ることが確定したか
 *   （`false` は処理対象外のイベント。件数に数えない）
 * @throws 技術的な失敗、および処理できないレコード（呼び出し側が分類する）
 */
async function processRecord(
  record: DynamoDBRecord,
  stageContext: StageContext
): Promise<boolean> {
  if (!isProcessedEvent(record)) {
    // 本来は ESM のイベントフィルタが届けない（design §5.6 / Property 8）。
    // ここに来るのはフィルタの設定漏れであり、放置すると 1 周ごとに
    // 4 倍でイベントが増える無限ループになる
    logger.warn('INSERT 以外のイベントを受け取りました（ESM のフィルタ設定を確認）', {
      eventName: record.eventName,
      sequenceNumber: sequenceNumberOf(record),
    });
    return false;
  }

  const order = toStreamOrder(record);

  const outcome = await withOrderSubsegment(
    { tracer, name: ORDER_SUBSEGMENT_NAME, orderId: order.orderId },
    () => processOrder(order, stageContext)
  );

  if (outcome.status === 'TERMINATED') {
    // 業務的な失敗。再試行しない（要件 16.7）。段階の詳細は stages.ts が
    // 段階名つきで warn に残しているので、ここでは打ち切りの事実だけ記録する
    logger.info('業務的な失敗により後続段階を実行せず終了しました', {
      orderId: order.orderId,
      loadTestId: order.loadTestId,
      stage: outcome.stage,
      reason: outcome.reason,
    });
    return true;
  }

  logger.info('全段階が完了しました', {
    orderId: order.orderId,
    loadTestId: order.loadTestId,
    pointEarned: outcome.pointEarned,
  });
  return true;
}

/**
 * レコード単位の失敗をログに残す。
 *
 * 再試行するものは ERROR、しないもの（`SKIP`）も ERROR にする。
 * `SKIP` はレコードの形が想定と違う場合だけで（`failure-policy.ts`）、
 * これは注文レコードの実装不整合を意味する。**静かに捨ててはならない**。
 */
function logRecordFailure(
  record: DynamoDBRecord,
  kind: FailureKind,
  disposition: FailureDisposition,
  error: unknown
): void {
  logger.error('ストリームレコードの処理に失敗しました', {
    sequenceNumber: sequenceNumberOf(record),
    failureKind: kind,
    disposition,
    error,
  });
}
