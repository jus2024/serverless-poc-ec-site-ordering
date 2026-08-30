/**
 * 並行計測 Lambda（`POST /measure/start` + 計測ワーカー。要件 12、design 論点 3 / §5.2）。
 *
 * ## 2 つの入口を持つ 1 つの関数
 *
 * ```
 * POST /measure/start ──▶ 実行レコードを作成（RUNNING）
 *                          自身を非同期 invoke
 *                          202 + 実行 ID を即座に返す（要件 12.1）
 *
 * 自己 invoke ─────────▶ 指定並行数で照会 API を叩き続ける
 *                          レイテンシを全件記録（要件 12.3）
 *                          エラーを分類（要件 12.2）
 *                          継続時間に達したら分位点を算出して COMPLETED
 * ```
 *
 * 開始 API が即座に応答するのは API Gateway の統合タイムアウト（上限 29 秒）を
 * 超える継続時間に対応するためである（design 論点 3）。判別は `isMeasureWorkerEvent`。
 *
 * ## API Gateway を経由して `order-query` を叩く（design 論点 3）
 *
 * `order-query` を直接 invoke すると API Gateway 層のスロットル（429）を
 * 見逃す。経路全体を HTTPS で測る。接続数上限の扱いは `query-client.ts` を参照。
 *
 * ## 並行数の実現: 並行数と同じ本数の送信ループ
 *
 * `Promise.all` で「並行数分のループ」を同時に走らせ、各ループは
 * 1 件送り終えたら次を送る。固定の待ち時間を挟まないので、
 * **常に並行数だけのリクエストが飛んでいる**状態になる。
 * 一定間隔で撃つ方式（レート指定）にしないのは、要件 12.7 が
 * 動かしたいのは並行数（同期パス側の需要）であり、
 * 応答が遅くなったときに需要が自然に詰まる方が現実の照会に近いからである。
 *
 * ## ワーカーは例外を投げ直さない
 *
 * 非同期 invoke された Lambda は失敗すると自動で再試行される（既定 2 回）。
 * 再試行されると同じ実行 ID で計測が二重に走り、スロットル件数が
 * 二重計上される（波及の判定を誤らせる）。例外は実行レコードを
 * `FAILED` にしてから飲み込む（design §E-6）。
 *
 * ## X-Ray
 *
 * リクエスト単位のアノテーションは付けない（`load-generator` と同じ理由）。
 * 1 回の invoke で数万件を撃つため、セグメントが破裂する。
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import {
  type ShardObservation,
  observeShardCount,
  requireOrdersStreamArn,
  toShardCountErrorReason,
} from '../load-generator/shard-count.js';
import { getDocumentClient } from '../shared/ddb.js';
import { ApiError, accepted, parseJsonBody, toErrorResponse } from '../shared/http.js';
import { requireTableName, resolveVerificationParams } from '../shared/runtime-config.js';
import { invokeSelfAsync } from '../shared/self-invoke.js';
import {
  buildCompletionUpdateInput,
  buildFailureUpdateInput,
  buildProgressUpdateInput,
  buildQueryImpactExecutionRecord,
  formatExecutionError,
  summarizeLatencies,
  toStartQueryImpactResponse,
} from './execution-record.js';
import {
  MAX_LATENCY_SAMPLES,
  PROGRESS_FLUSH_INTERVAL_MS,
  type MeasureFinishReason,
  resolveMeasureAction,
} from './measure-plan.js';
import { newQueryImpactId, parseStartMeasureRequest } from './measure-request.js';
import {
  type MeasureAgent,
  createMeasureAgent,
  resolveMaxSockets,
  sendQueryRequest,
} from './query-client.js';
import {
  buildQueryTargetUrl,
  describeQueryTarget,
  requireOrderApiBaseUrl,
} from './query-target.js';
import {
  type OutcomeCounters,
  countOutcome,
  createOutcomeCounters,
} from './request-outcome.js';
import { type MeasureWorkerEvent, buildMeasureWorkerEvent, isMeasureWorkerEvent } from './worker-event.js';

const SERVICE_NAME = 'query-impact-measure';

const logger = new Logger({ serviceName: SERVICE_NAME });

/** この関数が受け取り得るイベント */
export type QueryImpactMeasureEvent = APIGatewayProxyEvent | MeasureWorkerEvent;

export const handler = async (
  event: QueryImpactMeasureEvent,
  context: Context
): Promise<APIGatewayProxyResult | void> => {
  if (isMeasureWorkerEvent(event)) {
    await runWorker(event, context);
    return;
  }
  return startMeasurement(event);
};

/**
 * `POST /measure/start`（要件 12.1 / 12.7、design §E-6）。
 *
 * 実行レコードを作ってからワーカーを invoke する。順序を逆にすると、
 * ワーカーが先に走って存在しないレコードを更新しようとし、
 * `attribute_exists(execution_id)` の条件で失敗する。
 */
async function startMeasurement(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const startedAtMs = Date.now();
  // 環境変数の解決も try の中で行う。配線漏れを素の例外として投げると
  // API Gateway が 502 を返し、design §E-1 のエラー形から外れる
  let executionsTable: string | undefined;
  let executionId: string | undefined;

  try {
    executionsTable = requireTableName('executionsTableName');
    const verification = resolveVerificationParams();
    const params = parseStartMeasureRequest(parseJsonBody(event.body), verification);
    // ベース URL の解決を検証の後に置く。配線漏れ（500）よりも
    // リクエストの誤り（400）を先に返した方が、検証者が直せる
    const targetUrl = buildQueryTargetUrl(requireOrderApiBaseUrl(), params.target);

    // シャード数の観測（要件 19.1 / 12.5）。失敗しても計測は続ける（要件 19.5）
    const observation = await observeShardCountSafely();
    executionId = newQueryImpactId();

    const record = buildQueryImpactExecutionRecord({
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
      payload: buildMeasureWorkerEvent({ executionId, params, targetUrl, startedAtMs }),
    });

    logger.info('並行計測を開始しました', {
      executionId,
      concurrency: params.concurrency,
      durationSeconds: params.durationSeconds,
      target: describeQueryTarget(params.target),
      loadTestId: params.loadTestId,
      openShardCount: observation.openShardCount,
      shardCountError: observation.shardCountError,
      estimatedCapacityPerMinute: record.estimated_capacity_per_minute,
    });

    return accepted(toStartQueryImpactResponse(record, params));
  } catch (error) {
    if (error instanceof ApiError) {
      logger.warn('並行計測の開始を拒否しました', {
        errorCode: error.code,
        message: error.message,
        details: error.details,
      });
      return toErrorResponse(error);
    }

    logger.error('並行計測の開始に失敗しました', { error, executionId });
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
 * 計測ワーカー（要件 12.1〜12.3）。
 *
 * 1 回の invoke で測り切る（引き継がない。理由は `worker-event.ts` の注記）。
 * 並行数と同じ本数の送信ループを同時に走らせ、いずれかのループが
 * 打ち切り条件を見たら全ループが順に抜ける。
 */
async function runWorker(event: MeasureWorkerEvent, context: Context): Promise<void> {
  const counters = createOutcomeCounters();
  const latenciesMs: number[] = [];
  let executionsTable: string | undefined;
  let agent: MeasureAgent | undefined;

  try {
    executionsTable = requireTableName('executionsTableName');
    const { params } = event;
    // 接続数上限を明示的に引き上げる（design 論点 3）。
    // 既定のままだと接続待ちがレイテンシに混入し、指定並行数が実際には出ない
    agent = createMeasureAgent({ url: event.targetUrl, concurrency: params.concurrency });

    logger.info('並行計測ワーカーを開始しました', {
      executionId: event.executionId,
      concurrency: params.concurrency,
      maxSockets: resolveMaxSockets(params.concurrency),
      durationSeconds: params.durationSeconds,
      target: describeQueryTarget(params.target),
    });

    const state: WorkerState = {
      executionsTable,
      event,
      agent,
      counters,
      latenciesMs,
      finishReason: undefined,
      lastFlushAtMs: Date.now(),
    };

    await Promise.all(
      Array.from({ length: params.concurrency }, () => runSendLoop(state, context))
    );

    await completeMeasurement(state);
  } catch (error) {
    logger.error('並行計測ワーカーが失敗しました', {
      error,
      executionId: event.executionId,
      requestCount: counters.requestCount,
      throttleCount: counters.throttleCount,
      otherErrorCount: counters.otherErrorCount,
    });
    if (executionsTable !== undefined) {
      await markExecutionFailed({
        executionsTable,
        executionId: event.executionId,
        errorMessage: formatExecutionError(error),
        counters,
      });
    }
    // 投げ直さない（冒頭の注記。非同期 invoke の再試行で計測を二重に走らせないため）
  } finally {
    // keep-alive のソケットを残したまま invoke を終えると、
    // Lambda 実行環境が再利用されたときに古い接続が生き残る
    agent?.destroy();
  }
}

/** 送信ループの共有状態（並行数分のループが同じ集計を更新する） */
interface WorkerState {
  executionsTable: string;
  event: MeasureWorkerEvent;
  agent: MeasureAgent;
  counters: OutcomeCounters;
  latenciesMs: number[];
  finishReason: MeasureFinishReason | undefined;
  lastFlushAtMs: number;
}

/**
 * 1 本の送信ループ。1 件送り終えたら次を送る。
 *
 * 打ち切り条件は**送信の前**に確かめる。送信後に確かめると、
 * 継続時間を過ぎてから撃った 1 件が結果に混ざる。
 */
async function runSendLoop(state: WorkerState, context: Context): Promise<void> {
  for (;;) {
    const decision = resolveMeasureAction({
      elapsedMs: Date.now() - state.event.startedAtMs,
      durationSeconds: state.event.params.durationSeconds,
      remainingInvokeMs: context.getRemainingTimeInMillis(),
      sampleCount: state.latenciesMs.length,
    });

    if (decision.action === 'FINISH') {
      // 最初に打ち切りを見たループの理由を残す（後続のループは上書きしない）
      state.finishReason ??= decision.reason;
      return;
    }

    const result = await sendQueryRequest({
      url: state.event.targetUrl,
      agent: state.agent,
    });

    // 全件記録する（要件 12.3）。上限は `resolveMeasureAction` が見張っている
    state.latenciesMs.push(result.latencyMs);
    countOutcome(state.counters, result.outcome);

    await flushProgressIfDue(state);
  }
}

/**
 * 途中の内訳を実行レコードへ書き出す（要件 12.5 のポーリング表示のため）。
 *
 * 間隔は `load-generator` と同じ 5 秒。ここで待つ時間は計測対象への
 * リクエストが 1 本止まる時間なので、頻度を上げると並行数が実質的に下がる。
 * 書き出しの失敗は飲み込む。**進捗が書けないことで計測本体を落とすのは行き過ぎ**で、
 * 結果は完了時にまとめて書く（そこで失敗すれば `FAILED` になる）。
 */
async function flushProgressIfDue(state: WorkerState): Promise<void> {
  if (Date.now() - state.lastFlushAtMs < PROGRESS_FLUSH_INTERVAL_MS) {
    return;
  }
  // 先に時刻を進める。書き出しに時間が掛かっても、
  // 待っている間に他のループが同じ書き出しを始めないようにする
  state.lastFlushAtMs = Date.now();

  try {
    await getDocumentClient().send(
      new UpdateCommand(
        buildProgressUpdateInput({
          tableName: state.executionsTable,
          executionId: state.event.executionId,
          counters: state.counters,
        })
      )
    );
  } catch (error) {
    logger.warn('計測の進捗を書き出せませんでした', {
      error,
      executionId: state.event.executionId,
    });
  }
}

/** 分位点を算出して実行を `COMPLETED` にする（要件 12.2 / 12.3 / 12.6） */
async function completeMeasurement(state: WorkerState): Promise<void> {
  const latencyPercentiles = summarizeLatencies(state.latenciesMs);
  const finishedAtMs = Date.now();

  await getDocumentClient().send(
    new UpdateCommand(
      buildCompletionUpdateInput({
        tableName: state.executionsTable,
        executionId: state.event.executionId,
        counters: state.counters,
        latencyPercentiles,
        nowMs: finishedAtMs,
      })
    )
  );

  const log = {
    executionId: state.event.executionId,
    finishReason: state.finishReason,
    concurrency: state.event.params.concurrency,
    elapsedMs: finishedAtMs - state.event.startedAtMs,
    requestCount: state.counters.requestCount,
    successCount: state.counters.successCount,
    throttleCount: state.counters.throttleCount,
    otherErrorCount: state.counters.otherErrorCount,
    latencyPercentiles,
  };

  if (state.counters.throttleCount > 0) {
    // 波及が現れた実行。検証者が実行レコードを見る前にログでも気づけるようにする（要件 12.6）
    logger.warn('並行計測でスロットルを観測しました', log);
  } else if (state.finishReason === 'SAMPLE_LIMIT') {
    logger.warn('標本の上限に達したため計測を打ち切りました', {
      ...log,
      maxLatencySamples: MAX_LATENCY_SAMPLES,
    });
  } else {
    logger.info('並行計測が完了しました', log);
  }
}

/**
 * シャード数を観測する。**この関数は例外を投げない**（要件 19.5、design §E-8）。
 *
 * 実装は `load-generator/handler.ts` と同じ。並行計測でも観測するのは
 * 要件 12.5 が計測結果を実行条件（シャード数を含む）とともに記録することを
 * 求めているためである。
 *
 * **design §5.9 からの逸脱（配線済み）:** これには `dynamodb:DescribeStream`
 * （注文テーブルのストリーム）と `dynamodb:DescribeTable`（注文テーブル）の権限、
 * および `ORDERS_STREAM_ARN` の環境変数が必要である。design §5.9 の表は
 * これらを `load-generator` にだけ挙げているが、付与しないと全ての計測結果に
 * `shard_count_error = AccessDeniedException` が付き（計測自体は完走するため
 * 気づきにくい）、要件 12.5 を満たせない。
 * したがって `order-functions.ts` の `grantQueryImpactMeasurePermissions` で
 * `load-generator` と同じ 2 つを付与している。
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
 * ことによって元の失敗原因のログが上書きされる。
 */
async function markExecutionFailed(input: {
  executionsTable: string;
  executionId: string;
  errorMessage: string;
  counters?: OutcomeCounters;
}): Promise<void> {
  try {
    await getDocumentClient().send(
      new UpdateCommand(
        buildFailureUpdateInput({
          tableName: input.executionsTable,
          executionId: input.executionId,
          errorMessage: input.errorMessage,
          counters: input.counters,
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
