/**
 * 負荷生成 Lambda（`POST /load-test/start` + 自己再帰ワーカー。要件 11、design 論点 2 / §5.2）。
 *
 * ## 2 つの入口を持つ 1 つの関数
 *
 * ```
 * POST /load-test/start ──▶ 実行レコードを作成（RUNNING）
 *                           自身を非同期 invoke
 *                           202 + 実行 ID を即座に返す（要件 11.9）
 *
 * 自己 invoke ──────────▶ 1 秒刻みで BatchWriteItem（要件 11.1〜11.4）
 *                           残り時間が閾値を切ったら自身を invoke して引き継ぐ
 *                           継続時間に達したら COMPLETED（実測レートを記録。要件 11.11）
 * ```
 *
 * ## 末尾の端数取りこぼし修正（`planBackfill`）
 *
 * FINISH（継続時間到達）はループ先頭で判定され、従来はその刻みで投入せずに
 * `completeExecution` していた。このため「継続時間ちょうどの最後の刻みで
 * 投入されるはずだった端数」が落ち、低レートほど割合が大きくなっていた
 * （2 件/分 × 60 秒 で実測が目標の半分）。最終世代の FINISH では
 * `completeExecution` の前に `planBackfill` で「理論総数 − これまでの計画総数
 * （`plannedTotal`）」をまとめて投入する。差が負なら 0 なので過剰投入せず、
 * 大量・長時間の実行では `plannedTotal` がほぼ理論総数に一致するため
 * 補填は 0〜1 件に収まり、既存の実測結果に実質影響しない。`plannedTotal` は
 * `carry` と同様に世代を跨いで引き継ぐ（`worker-event.ts`）。
 *
 * 開始 API が即座に応答するのは API Gateway の統合タイムアウト（上限 29 秒）を
 * 超える継続時間に対応するためである（要件 11.9）。判別は `isLoadWorkerEvent`。
 *
 * ## 注文テーブルへ直接書き込む（要件 11.10）
 *
 * `order-accept` を経由しない。理由と代償は `order-batch.ts` の冒頭を参照。
 *
 * ## ワーカーは例外を投げ直さない
 *
 * 非同期 invoke された Lambda は失敗すると**自動で再試行される**（既定 2 回）。
 * 投入途中で落ちたワーカーが再試行されると、同じ実行 ID で負荷が二重に流れ、
 * 実測レートが目標の 2 倍になる（要件 11.11 の記録が信用できなくなる）。
 * 例外は実行レコードを `FAILED` にしてから飲み込み、再試行させない（design §E-6）。
 * 検証者は実行状態のポーリングで失敗を知る（要件 11.6）。
 *
 * ## X-Ray
 *
 * 注文単位のアノテーション（要件 13.4）は付けない。1 回の invoke で
 * 数千件を投入するため、注文 ID を注釈にするとセグメントが破裂する。
 * 負荷生成は「投入した」ことだけが関心であり、追跡すべき単位は実行 ID である。
 */

import { Logger } from '@aws-lambda-powertools/logger';
import {
  BatchWriteCommand,
  type BatchWriteCommandInput,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { getDocumentClient } from '../shared/ddb.js';
import { ApiError, accepted, parseJsonBody, toErrorResponse } from '../shared/http.js';
import { requireTableName, resolveVerificationParams } from '../shared/runtime-config.js';
import { invokeSelfAsync } from '../shared/self-invoke.js';
import {
  buildCompletionUpdateInput,
  buildFailureUpdateInput,
  buildLoadTestExecutionRecord,
  buildProgressUpdateInput,
  formatExecutionError,
  toStartLoadTestResponse,
} from './execution-record.js';
import {
  PROGRESS_FLUSH_INTERVAL_MS,
  TICK_INTERVAL_MS,
  evaluateRate,
  planBackfill,
  planTick,
  resolveTickAction,
} from './load-plan.js';
import { newLoadTestId, parseStartLoadTestRequest } from './load-test-request.js';
import {
  MAX_UNPROCESSED_RETRIES,
  UNPROCESSED_RETRY_DELAY_MS,
  buildLoadTestOrders,
  chunkOrderWriteInputs,
  countBatchWriteItems,
  toRetryBatch,
} from './order-batch.js';
import {
  type ShardObservation,
  observeShardCount,
  requireOrdersStreamArn,
  toShardCountErrorReason,
} from './shard-count.js';
import {
  type LoadWorkerEvent,
  assertWorkerGeneration,
  buildFirstWorkerEvent,
  buildNextWorkerEvent,
  isLoadWorkerEvent,
} from './worker-event.js';

const SERVICE_NAME = 'load-generator';

const logger = new Logger({ serviceName: SERVICE_NAME });

/** この関数が受け取り得るイベント */
export type LoadGeneratorEvent = APIGatewayProxyEvent | LoadWorkerEvent;

export const handler = async (
  event: LoadGeneratorEvent,
  context: Context
): Promise<APIGatewayProxyResult | void> => {
  if (isLoadWorkerEvent(event)) {
    await runWorker(event, context);
    return;
  }
  return startLoadTest(event);
};

/**
 * `POST /load-test/start`（要件 11.1 / 11.5 / 11.9、design §E-6）。
 *
 * 実行レコードを作ってからワーカーを invoke する。順序を逆にすると、
 * ワーカーが先に走って存在しないレコードを更新しようとし、
 * `attribute_exists(execution_id)` の条件で失敗する（`execution-record.ts` の注記）。
 */
async function startLoadTest(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const startedAtMs = Date.now();
  // 環境変数の解決も try の中で行う。配線漏れ（RuntimeConfigError）を
  // 素の例外として投げると API Gateway が 502 を返し、design §E-1 の
  // エラー形（`{ error, message }`）から外れる
  let executionsTable: string | undefined;
  let executionId: string | undefined;

  try {
    executionsTable = requireTableName('executionsTableName');
    const verification = resolveVerificationParams();
    const params = parseStartLoadTestRequest(parseJsonBody(event.body), verification);

    // シャード数の観測（要件 19.1）。失敗しても投入は続ける（要件 19.5）
    const observation = await observeShardCountSafely();
    executionId = newLoadTestId();

    const record = buildLoadTestExecutionRecord({
      executionId,
      params,
      observation,
      verification,
      nowMs: startedAtMs,
    });

    await getDocumentClient().send(
      new PutCommand({ TableName: executionsTable, Item: record })
    );

    await invokeSelfAsync({
      payload: buildFirstWorkerEvent({ executionId, params, startedAtMs }),
    });

    logger.info('負荷生成を開始しました', {
      executionId,
      targetOrdersPerMinute: params.ordersPerMinute,
      durationSeconds: params.durationSeconds,
      useRampCurve: params.useRampCurve,
      openShardCount: observation.openShardCount,
      shardCountError: observation.shardCountError,
      estimatedCapacityPerMinute: record.estimated_capacity_per_minute,
    });

    return accepted(toStartLoadTestResponse(record));
  } catch (error) {
    if (error instanceof ApiError) {
      logger.warn('負荷生成の開始を拒否しました', {
        errorCode: error.code,
        message: error.message,
        details: error.details,
      });
      return toErrorResponse(error);
    }

    logger.error('負荷生成の開始に失敗しました', { error, executionId });
    // 実行レコードを作った後の失敗（多くは自己 invoke の失敗）は
    // RUNNING のまま放置せず FAILED にする（design §E-6）
    if (executionsTable !== undefined && executionId !== undefined) {
      await markExecutionFailed({
        executionsTable,
        executionId,
        errorMessage: formatExecutionError(error),
      });
    }
    return toErrorResponse(error);
  }
}

/**
 * 自己再帰ワーカー（要件 11.1〜11.4 / 11.9 / 11.11）。
 *
 * 1 刻み（既定 1 秒）ごとに投入件数を決めて書き込み、刻みの残り時間だけ待つ。
 * 刻みの長さには**前の刻みからの実経過時間**を渡す（`planTick` の注記）。
 */
async function runWorker(event: LoadWorkerEvent, context: Context): Promise<void> {
  let submittedCount = event.submittedCount;
  let submitErrorCount = event.submitErrorCount;
  let carry = event.carry;
  // この実行全体で計画（投入試行）した件数の累計。FINISH の補填で
  // 「理論総数 − plannedTotal」を求めるために carry と同様に世代を跨いで持ち回る
  let plannedTotal = event.plannedTotal;
  // 実行レコードのテーブル名を先に解決する。これが解決できない失敗だけは
  // `FAILED` を記録できず、CloudWatch のエラーログにしか現れない
  let executionsTable: string | undefined;

  try {
    executionsTable = requireTableName('executionsTableName');
    const ordersTable = requireTableName('ordersTableName');
    assertWorkerGeneration(event.generation);
    const verification = resolveVerificationParams();
    const { params } = event;

    let lastTickAtMs = Date.now();
    let lastFlushAtMs = Date.now();

    for (;;) {
      const tickStartedAtMs = Date.now();
      const action = resolveTickAction({
        elapsedMs: tickStartedAtMs - event.startedAtMs,
        durationSeconds: params.durationSeconds,
        remainingInvokeMs: context.getRemainingTimeInMillis(),
      });

      if (action === 'FINISH') {
        // 理論総数と実計画数（plannedTotal）の差を最後にまとめて投入する。
        // 差が負なら 0 なので過剰投入しない（planBackfill の注記）。
        // HANDOFF 経路は plannedTotal を次世代へ引き継ぐため、補填は最終世代の
        // FINISH でのみ起き、二重投入にはならない。
        const backfill = planBackfill({
          targetOrdersPerMinute: params.ordersPerMinute,
          durationSeconds: params.durationSeconds,
          useRampCurve: params.useRampCurve,
          plannedTotal,
        });
        if (backfill.orders > 0) {
          const result = await submitOrders({
            ordersTable,
            count: backfill.orders,
            loadTestId: event.executionId,
            dataTtlDays: verification.dataTtlDays,
          });
          submittedCount += result.submittedCount;
          submitErrorCount += result.submitErrorCount;
        }

        await completeExecution({
          executionsTable,
          event,
          submittedCount,
          submitErrorCount,
          finishedAtMs: tickStartedAtMs,
        });
        return;
      }

      if (action === 'HANDOFF') {
        await handOffToNextGeneration({
          executionsTable,
          event,
          submittedCount,
          submitErrorCount,
          carry,
          plannedTotal,
        });
        return;
      }

      const tickElapsedMs = tickStartedAtMs - event.startedAtMs;
      const plan = planTick({
        targetOrdersPerMinute: params.ordersPerMinute,
        elapsedMs: tickElapsedMs,
        durationSeconds: params.durationSeconds,
        useRampCurve: params.useRampCurve,
        carry,
        tickMs: tickStartedAtMs - lastTickAtMs,
      });
      carry = plan.carry;
      lastTickAtMs = tickStartedAtMs;
      // 計画した件数をこの実行全体の累計に足す（FINISH の補填基準）。
      // 書き込みの成否によらず「計画した数」を数える（planBackfill の注記）
      plannedTotal += plan.orders;

      if (plan.orders > 0) {
        const result = await submitOrders({
          ordersTable,
          count: plan.orders,
          loadTestId: event.executionId,
          dataTtlDays: verification.dataTtlDays,
        });
        submittedCount += result.submittedCount;
        submitErrorCount += result.submitErrorCount;
      }

      if (Date.now() - lastFlushAtMs >= PROGRESS_FLUSH_INTERVAL_MS) {
        await getDocumentClient().send(
          new UpdateCommand(
            buildProgressUpdateInput({
              tableName: executionsTable,
              executionId: event.executionId,
              submittedCount,
              submitErrorCount,
            })
          )
        );
        lastFlushAtMs = Date.now();
      }

      await sleepRestOfTick(tickStartedAtMs);
    }
  } catch (error) {
    logger.error('負荷生成ワーカーが失敗しました', {
      error,
      executionId: event.executionId,
      generation: event.generation,
      submittedCount,
      submitErrorCount,
    });
    if (executionsTable !== undefined) {
      await markExecutionFailed({
        executionsTable,
        executionId: event.executionId,
        errorMessage: formatExecutionError(error),
        submittedCount,
        submitErrorCount,
      });
    }
    // 投げ直さない（冒頭の注記。非同期 invoke の再試行で負荷を二重に流さないため）
  }
}

/** 実行を `COMPLETED` にし、実測投入レートを記録する（要件 11.11） */
async function completeExecution(input: {
  executionsTable: string;
  event: LoadWorkerEvent;
  submittedCount: number;
  submitErrorCount: number;
  finishedAtMs: number;
}): Promise<void> {
  const { event } = input;
  const rate = evaluateRate({
    targetOrdersPerMinute: event.params.ordersPerMinute,
    useRampCurve: event.params.useRampCurve,
    submittedCount: input.submittedCount,
    elapsedMs: input.finishedAtMs - event.startedAtMs,
  });

  await getDocumentClient().send(
    new UpdateCommand(
      buildCompletionUpdateInput({
        tableName: input.executionsTable,
        executionId: event.executionId,
        submittedCount: input.submittedCount,
        submitErrorCount: input.submitErrorCount,
        rate,
        nowMs: input.finishedAtMs,
      })
    )
  );

  const log = {
    executionId: event.executionId,
    generation: event.generation,
    submittedCount: input.submittedCount,
    submitErrorCount: input.submitErrorCount,
    targetOrdersPerMinute: event.params.ordersPerMinute,
    ...rate,
  };
  if (rate.rateDeviationWarning) {
    // 乖離した実行の結果は design §2.4 の算術に使えない（Property 11）。
    // 検証者が実行レコードを見る前にログでも気づけるようにする
    logger.warn('投入レートが目標から乖離しました', log);
  } else {
    logger.info('負荷生成が完了しました', log);
  }
}

/** 残り時間が閾値を切ったので次の世代へ引き継ぐ（要件 11.9） */
async function handOffToNextGeneration(input: {
  executionsTable: string;
  event: LoadWorkerEvent;
  submittedCount: number;
  submitErrorCount: number;
  carry: number;
  plannedTotal: number;
}): Promise<void> {
  const { event } = input;

  // 引き継ぎ前に進捗を確定させる。invoke が失敗した場合でも
  // 「どこまで投入したか」が実行レコードに残るようにするため
  await getDocumentClient().send(
    new UpdateCommand(
      buildProgressUpdateInput({
        tableName: input.executionsTable,
        executionId: event.executionId,
        submittedCount: input.submittedCount,
        submitErrorCount: input.submitErrorCount,
      })
    )
  );

  const next = buildNextWorkerEvent(event, {
    submittedCount: input.submittedCount,
    submitErrorCount: input.submitErrorCount,
    carry: input.carry,
    plannedTotal: input.plannedTotal,
  });
  await invokeSelfAsync({ payload: next });

  logger.info('負荷生成を次の世代へ引き継ぎました', {
    executionId: event.executionId,
    generation: next.generation,
    submittedCount: input.submittedCount,
    submitErrorCount: input.submitErrorCount,
  });
}

/** 1 刻み分の注文を投入する。バッチは並列に送る（要件 11.7 の到達レートのため） */
async function submitOrders(input: {
  ordersTable: string;
  count: number;
  loadTestId: string;
  dataTtlDays: number;
}): Promise<{ submittedCount: number; submitErrorCount: number }> {
  const records = buildLoadTestOrders({
    count: input.count,
    loadTestId: input.loadTestId,
    dataTtlDays: input.dataTtlDays,
  });
  const batches = chunkOrderWriteInputs(input.ordersTable, records);

  // 16,000 件/分（267 件/秒 = 11 バッチ）を 1 秒の刻みに収めるには並列送信が必要。
  // 直列に送ると往復時間の合計が刻みを超え、目標レートに届かない
  const results = await Promise.all(batches.map((batch) => writeBatch(batch)));

  return results.reduce(
    (total, result) => ({
      submittedCount: total.submittedCount + result.submittedCount,
      submitErrorCount: total.submitErrorCount + result.submitErrorCount,
    }),
    { submittedCount: 0, submitErrorCount: 0 }
  );
}

/**
 * 1 バッチを書き込む。`UnprocessedItems` は上限回数だけ再送し、残りはエラーに数える。
 *
 * 例外（スロットル、権限不足など）でもワーカーを止めない。投入エラーは
 * **それ自体が観測対象**であり（書き込み側が壁になっているかの判断材料）、
 * 1 バッチの失敗で実行全体を `FAILED` にすると、
 * 壁に当たった瞬間に計測が終わってしまう。
 */
async function writeBatch(
  batch: BatchWriteCommandInput
): Promise<{ submittedCount: number; submitErrorCount: number }> {
  const client = getDocumentClient();
  const total = countBatchWriteItems(batch);
  let pending: BatchWriteCommandInput | undefined = batch;
  let attempt = 0;

  while (pending !== undefined) {
    try {
      const output = await client.send(new BatchWriteCommand(pending));
      const next = toRetryBatch(output.UnprocessedItems);

      if (next === undefined) {
        return { submittedCount: total, submitErrorCount: 0 };
      }
      if (attempt >= MAX_UNPROCESSED_RETRIES) {
        const remaining = countBatchWriteItems(next);
        logger.warn('BatchWriteItem の書き残しを投入エラーとして数えます', {
          remaining,
          attempts: attempt,
        });
        return { submittedCount: total - remaining, submitErrorCount: remaining };
      }

      attempt += 1;
      await sleep(UNPROCESSED_RETRY_DELAY_MS);
      pending = next;
    } catch (error) {
      const remaining = countBatchWriteItems(pending);
      logger.warn('BatchWriteItem が失敗しました', { error, remaining });
      return { submittedCount: total - remaining, submitErrorCount: remaining };
    }
  }

  return { submittedCount: total, submitErrorCount: 0 };
}

/**
 * シャード数を観測する。**この関数は例外を投げない**（要件 19.5、design §E-8）。
 *
 * `observeShardCount` 自体も例外を投げないが、その手前の
 * ストリーム ARN の解決（環境変数の配線漏れ）は例外になる。
 * 配線漏れで負荷生成そのものが始まらないのは行き過ぎなので、
 * ここで理由に変換して投入を続ける。
 */
async function observeShardCountSafely(): Promise<ShardObservation> {
  let streamArn: string;
  try {
    streamArn = requireOrdersStreamArn();
  } catch (error) {
    logger.warn('ストリーム ARN を解決できませんでした', { error });
    return { shardCountError: toShardCountErrorReason(error), pageCount: 0 };
  }

  return observeShardCount({
    streamArn,
    tableName: requireTableName('ordersTableName'),
    onError: (context, error) => {
      logger.warn('シャード数の観測に失敗しました', { context, error });
    },
  });
}

/**
 * 実行レコードを `FAILED` にする（design §E-6）。
 *
 * この更新自体の失敗は飲み込む。ここで例外を投げると、失敗を記録できなかった
 * ことによって**元の失敗原因のログが上書きされる**（呼び出し側の catch は
 * 既に通過している）。記録できなかった事実だけを残して戻る。
 */
async function markExecutionFailed(input: {
  executionsTable: string;
  executionId: string;
  errorMessage: string;
  submittedCount?: number;
  submitErrorCount?: number;
}): Promise<void> {
  try {
    await getDocumentClient().send(
      new UpdateCommand(
        buildFailureUpdateInput({
          tableName: input.executionsTable,
          executionId: input.executionId,
          errorMessage: input.errorMessage,
          submittedCount: input.submittedCount,
          submitErrorCount: input.submitErrorCount,
        })
      )
    );
  } catch (error) {
    logger.error('実行レコードを FAILED にできませんでした', {
      error,
      executionId: input.executionId,
    });
  }
}

/** 刻みの残り時間だけ待つ。刻みが長引いた場合は待たない（次の刻みで自己補正する） */
async function sleepRestOfTick(tickStartedAtMs: number): Promise<void> {
  const remainingMs = TICK_INTERVAL_MS - (Date.now() - tickStartedAtMs);
  if (remainingMs > 0) {
    await sleep(remainingMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
