/**
 * 並行計測の実行レコードの組み立て（design §4.3、要件 12.2 / 12.3 / 12.5 / 12.6 / 19.3）。
 *
 * `load-generator/execution-record.ts` と同じ方針で、`UpdateItem` の入力を
 * AWS クライアント抜きで単体テストできる純粋関数として組み立てる（design §12）。
 * 共通の部品（`toStageDelaysMs` / `formatExecutionError`）はそちらから読み込む。
 * 実行管理テーブルは 1 つであり、`status` の書き方や条件式が
 * 2 種類の実行で食い違うと `execution-status` の読み側が破綻する。
 *
 * ## 「波及しなかった」ことも成果として残す（要件 12.6）
 *
 * `throttle_count` と `other_error_count` は**0 でも必ず書く。**
 * 属性を省略して「エラーが無かった」を表すと、`execution-status` 側で
 * 0 に補われた値（`?? 0`）と区別できず、
 * 「計測が空振りした」のか「本当に 0 件だった」のかが判別できない。
 * 軸 A ではゼロの実証そのものが成果なので、0 を明示的に記録する。
 *
 * ## 投入レートをこのレコードに書き写さない（要件 12.5）
 *
 * 要件 12.5 は計測結果を「実行条件（投入レート、処理時間、PF、シャード数）とともに」
 * 記録することを求めている。このうち処理時間・PF・シャード数は
 * `ExecutionRecordBase` に入るが、**投入レートは並行計測の属性ではない。**
 * 投入レートは同時に走っている負荷生成の性質であり、その実行レコードには
 * 目標値だけでなく**実測値**（`actual_orders_per_minute`。要件 11.11）がある。
 *
 * ここに呼び出し側の申告値を書き写すと、レートの出典が 2 つになる。
 * 一方は実測、他方は自己申告で、しかも**乖離警告（design 論点 10）が
 * 付いていない方**が計測結果の隣に並ぶ。Property 11 は
 * 「実測レートが記録されていない実行結果は §2.4 の算術に使わない」と定めており、
 * 申告値はその判定をすり抜けてしまう。
 *
 * したがって記録するのは `load_test_id`（負荷生成の実行 ID）だけにする。
 * レートはその ID で負荷生成の実行レコードを引けば、実測値と警告付きで得られる。
 */

import type { UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import { buildCapacityEstimate } from '../shared/capacity.js';
import { calculatePercentiles } from '../shared/percentiles.js';
import { expiresAtFromNow } from '../shared/runtime-config.js';
import type {
  ExecutionStatus,
  LatencyPercentiles,
  QueryImpactExecutionRecord,
  StartQueryImpactResponse,
} from '../shared/types.js';
import {
  type ExecutionVerificationParams,
  formatExecutionError,
  toStageDelaysMs,
} from '../load-generator/execution-record.js';
import type { ShardObservation } from '../load-generator/shard-count.js';
import type { MeasureParams } from './measure-request.js';
import { describeQueryTarget } from './query-target.js';
import type { OutcomeCounters } from './request-outcome.js';

export { formatExecutionError };

export interface BuildQueryImpactRecordInput {
  executionId: string;
  params: MeasureParams;
  /** シャード数の観測結果（要件 19.1 / 19.5） */
  observation: ShardObservation;
  verification: ExecutionVerificationParams;
  /** 開始時刻（ミリ秒）。既定は現在時刻 */
  nowMs?: number;
}

/**
 * 計測開始時のレコードを組み立てる（`status = RUNNING`）。
 *
 * 消費能力（`estimated_capacity_per_minute`）を実測シャード数のときだけ書く理由は
 * `load-generator/execution-record.ts` と同じ。暫定値で埋めると、
 * 実行レコードを見た検証者がそれを実測と誤読する。
 *
 * `latency_percentiles` は開始時点では書かない。「まだ測れていない」ことを
 * 属性の不在で表す（`execution-status` は null として返す）。
 */
export function buildQueryImpactExecutionRecord(
  input: BuildQueryImpactRecordInput
): QueryImpactExecutionRecord {
  const nowMs = input.nowMs ?? Date.now();
  const { params, observation, verification } = input;
  const stageDelaysMs = toStageDelaysMs(verification);

  const record: QueryImpactExecutionRecord = {
    execution_id: input.executionId,
    execution_type: 'QUERY_IMPACT',
    status: 'RUNNING',
    duration_seconds: params.durationSeconds,
    concurrency: params.concurrency,
    throttle_count: 0,
    other_error_count: 0,
    request_count: 0,
    parallelization_factor: verification.streamParallelizationFactor,
    stage_delays_ms: stageDelaysMs,
    started_at: new Date(nowMs).toISOString(),
    expires_at: expiresAtFromNow(verification.dataTtlDays, nowMs),
  };

  if (params.loadTestId !== undefined) {
    record.load_test_id = params.loadTestId;
  }
  if (observation.openShardCount !== undefined) {
    record.open_shard_count = observation.openShardCount;
    record.estimated_capacity_per_minute = buildCapacityEstimate({
      parallelizationFactor: verification.streamParallelizationFactor,
      stageDelaysMs,
      openShardCount: observation.openShardCount,
    }).estimatedCapacityPerMinute;
  }
  if (observation.shardCountError !== undefined) {
    record.shard_count_error = observation.shardCountError;
  }
  if (observation.warmThroughputWrite !== undefined) {
    record.warm_throughput_write = observation.warmThroughputWrite;
  }

  return record;
}

/** 開始 API の応答（202 Accepted。要件 12.1） */
export function toStartQueryImpactResponse(
  record: QueryImpactExecutionRecord,
  params: MeasureParams
): StartQueryImpactResponse {
  return {
    executionId: record.execution_id,
    status: record.status,
    concurrency: record.concurrency,
    durationSeconds: record.duration_seconds,
    target: describeQueryTarget(params.target),
    loadTestId: record.load_test_id ?? null,
    startedAt: record.started_at,
    openShardCount: record.open_shard_count ?? null,
    shardCountError: record.shard_count_error ?? null,
    estimatedCapacityPerMinute: record.estimated_capacity_per_minute ?? null,
  };
}

export interface ProgressUpdateInput {
  tableName: string;
  executionId: string;
  counters: OutcomeCounters;
}

/**
 * 途中の内訳を書き出す（`status` は変えない）。
 *
 * `load-generator` と同じく**加算（`ADD`）ではなく代入（`SET`）**にする。
 * 書き込む値は計測開始からの累積なので、同じワーカーが二重に走っても
 * 値が同じになる（冪等）。加算にすると、非同期 invoke の再試行で
 * スロットル件数が二重計上され、波及の判定（要件 12.6）を誤らせる。
 *
 * `attribute_exists(execution_id)` を付けるのは、`UpdateItem` が既定で
 * レコードを新規作成するためである。TTL で消えた実行を
 * `status` を持たない歪な形で復活させない。
 */
export function buildProgressUpdateInput(input: ProgressUpdateInput): UpdateCommandInput {
  return {
    TableName: input.tableName,
    Key: { execution_id: input.executionId },
    UpdateExpression: [
      'SET throttle_count = :throttles',
      'other_error_count = :otherErrors',
      'request_count = :requests',
    ].join(', '),
    ConditionExpression: 'attribute_exists(execution_id)',
    ExpressionAttributeValues: {
      ':throttles': input.counters.throttleCount,
      ':otherErrors': input.counters.otherErrorCount,
      ':requests': input.counters.requestCount,
    },
  };
}

export interface CompletionUpdateInput extends ProgressUpdateInput {
  /** レイテンシの分位点（要件 12.3）。標本 0 件なら null */
  latencyPercentiles: LatencyPercentiles | null;
  /** 完了時刻（ミリ秒）。既定は現在時刻 */
  nowMs?: number;
}

/**
 * 計測を `COMPLETED` にする（要件 12.2 / 12.3 / 12.5）。
 *
 * 分位点は**標本が 1 件以上あるときだけ書く。** `calculatePercentiles` が
 * 0 件に対して null を返すのと同じ理由で、0ms を並べた分位点を書くと
 * 「レイテンシ 0ms を観測した」と読めてしまい、計測が空振りした事実が消える
 * （`shared/percentiles.ts` の注記）。
 */
export function buildCompletionUpdateInput(
  input: CompletionUpdateInput
): UpdateCommandInput {
  const nowMs = input.nowMs ?? Date.now();
  const setExpressions = [
    '#status = :status',
    'finished_at = :finishedAt',
    'throttle_count = :throttles',
    'other_error_count = :otherErrors',
    'request_count = :requests',
  ];
  const values: Record<string, unknown> = {
    ':status': 'COMPLETED' satisfies ExecutionStatus,
    ':finishedAt': new Date(nowMs).toISOString(),
    ':throttles': input.counters.throttleCount,
    ':otherErrors': input.counters.otherErrorCount,
    ':requests': input.counters.requestCount,
  };

  if (input.latencyPercentiles !== null) {
    setExpressions.push('latency_percentiles = :percentiles');
    values[':percentiles'] = input.latencyPercentiles;
  }

  return {
    TableName: input.tableName,
    Key: { execution_id: input.executionId },
    UpdateExpression: `SET ${setExpressions.join(', ')}`,
    ConditionExpression: 'attribute_exists(execution_id)',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: values,
  };
}

export interface FailureUpdateInput {
  tableName: string;
  executionId: string;
  /** 失敗の理由（`formatExecutionError` で整形した文字列） */
  errorMessage: string;
  /** 分かっている範囲の内訳。1 件も撃てていない段階では省略する */
  counters?: OutcomeCounters;
  /** 失敗を記録した時刻（ミリ秒）。既定は現在時刻 */
  nowMs?: number;
}

/**
 * 計測を `FAILED` にする（design §E-6）。
 *
 * 分位点は書かない。中断した計測の分位点を記録すると、
 * 途中までの標本から出た p99 が完了した計測の結果と並んでしまう。
 * 内訳（スロットル件数など）は分かっていれば書く。壁に当たって
 * 落ちた計測でも「どこまでで何件スロットルされたか」は手がかりになる。
 */
export function buildFailureUpdateInput(input: FailureUpdateInput): UpdateCommandInput {
  const nowMs = input.nowMs ?? Date.now();
  const setExpressions = [
    '#status = :status',
    'finished_at = :finishedAt',
    'error_message = :errorMessage',
  ];
  const values: Record<string, unknown> = {
    ':status': 'FAILED' satisfies ExecutionStatus,
    ':finishedAt': new Date(nowMs).toISOString(),
    ':errorMessage': input.errorMessage,
  };

  if (input.counters !== undefined) {
    setExpressions.push(
      'throttle_count = :throttles',
      'other_error_count = :otherErrors',
      'request_count = :requests'
    );
    values[':throttles'] = input.counters.throttleCount;
    values[':otherErrors'] = input.counters.otherErrorCount;
    values[':requests'] = input.counters.requestCount;
  }

  return {
    TableName: input.tableName,
    Key: { execution_id: input.executionId },
    UpdateExpression: `SET ${setExpressions.join(', ')}`,
    ConditionExpression: 'attribute_exists(execution_id)',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: values,
  };
}

/**
 * 標本から分位点を算出する（要件 12.3）。
 *
 * `shared/percentiles.ts` に委ねる薄い包み。ここに置いているのは、
 * 計測の終端で「標本 0 件なら書かない」という判断（`buildCompletionUpdateInput`）と
 * 同じ場所に算出の入口を置いておくためである。
 */
export function summarizeLatencies(
  latenciesMs: readonly number[]
): LatencyPercentiles | null {
  return calculatePercentiles(latenciesMs);
}
