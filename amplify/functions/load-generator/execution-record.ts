/**
 * 負荷生成の実行レコードの組み立て（design §4.3 / §E-6、要件 11.5 / 11.6 / 11.11 / 19.3 / 19.4）。
 *
 * ## 実行レコードは「後から解釈できる」ことが目的である
 *
 * 実行時のシャード数・PF・擬似処理時間・算出した消費能力をレコード自身に埋め込む
 * （Property 10）。これらは環境変数と実行時の状態で決まるため、
 * 記録しないと**後から復元できない**。とくにオープンシャード数は
 * CloudWatch メトリクスとして提供されず（要件 19 の但し書き）、
 * 記録の漏れた実行は消費能力 `S × P ÷ D` の検証に一切使えない。
 *
 * ## `UpdateItem` の入力を純粋関数で組み立てる
 *
 * `shared/order-status.ts` と同じ方針。更新式・条件式・属性値の組み立てを
 * AWS クライアント抜きで単体テストできるようにしている（design §12）。
 *
 * ## `status` は予約語である
 *
 * DynamoDB の予約語に `STATUS` が含まれるため、更新式では必ず
 * `ExpressionAttributeNames` 経由（`#status`）で書く。直接書くと
 * `ValidationException` になる。**しかも失敗するのは実行の完了時**なので、
 * 投入自体は成功しているのに実行レコードが `RUNNING` のまま残る形で現れる。
 */

import type { UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import { buildCapacityEstimate } from '../shared/capacity.js';
import { expiresAtFromNow } from '../shared/runtime-config.js';
import type {
  ExecutionStatus,
  LoadTestExecutionRecord,
  StageDelaysMs,
  StartLoadTestResponse,
} from '../shared/types.js';
import type { LoadTestParams } from './load-test-request.js';
import type { RateEvaluation } from './load-plan.js';
import type { ShardObservation } from './shard-count.js';

/**
 * `error_message` の長さ上限。
 *
 * 実行レコードは検証者が読むためのものであり、SDK のスタックトレースを
 * 丸ごと持ち込む価値はない（`shard_count_error` と同じ方針）。
 */
export const MAX_ERROR_MESSAGE_LENGTH = 512;

/** 実行レコードの組み立てに必要な検証パラメータ（`shared/runtime-config.ts` から渡す） */
export interface ExecutionVerificationParams {
  /** 消費能力の式の変数 P（要件 19.3） */
  streamParallelizationFactor: number;
  /** 決済の擬似処理時間（D の構成要素） */
  paymentDelayMs: number;
  /** 通知の擬似処理時間（D の構成要素） */
  notificationDelayMs: number;
  /** TTL の保持日数（design 論点 5） */
  dataTtlDays: number;
}

export interface BuildLoadTestExecutionRecordInput {
  executionId: string;
  params: LoadTestParams;
  /** シャード数の観測結果（`observeShardCount` の戻り値。要件 19.1 / 19.5） */
  observation: ShardObservation;
  verification: ExecutionVerificationParams;
  /** 開始時刻（ミリ秒）。既定は現在時刻 */
  nowMs?: number;
}

/** 擬似処理時間を実行レコードの形に整える */
export function toStageDelaysMs(verification: ExecutionVerificationParams): StageDelaysMs {
  return {
    payment: verification.paymentDelayMs,
    notification: verification.notificationDelayMs,
  };
}

/**
 * 実行開始時のレコードを組み立てる（`status = RUNNING`）。
 *
 * ## 消費能力は実測シャード数でのみ算出する（要件 19.3）
 *
 * `estimated_capacity_per_minute` はシャード数が取れたときだけ設定する。
 * 暫定値（S = 4）で埋めると、実行レコードを見た検証者が
 * それを実測に基づく値と誤読する。`GET /config` は暫定値でも
 * 見積もりを返すが、そちらは `shardCountSource = 'ASSUMED'` を応答に含めて
 * 出典を明示している（`shared/capacity.ts`）。実行レコードには
 * 出典を示す属性が無いため、実測でなければ**書かない**方を選ぶ。
 *
 * 実測レート（`actual_orders_per_minute`）と `finished_at` は開始時点では設定しない。
 * 「まだ分かっていない」ことを属性の不在で表す（Property 11 の
 * 「実測レートが記録されていない実行結果は §2.4 の算術に使わない」がそのまま効く）。
 */
export function buildLoadTestExecutionRecord(
  input: BuildLoadTestExecutionRecordInput
): LoadTestExecutionRecord {
  const nowMs = input.nowMs ?? Date.now();
  const { params, observation, verification } = input;
  const stageDelaysMs = toStageDelaysMs(verification);

  const record: LoadTestExecutionRecord = {
    execution_id: input.executionId,
    execution_type: 'LOAD_TEST',
    status: 'RUNNING',
    duration_seconds: params.durationSeconds,
    target_orders_per_minute: params.ordersPerMinute,
    use_ramp_curve: params.useRampCurve,
    submitted_count: 0,
    submit_error_count: 0,
    parallelization_factor: verification.streamParallelizationFactor,
    stage_delays_ms: stageDelaysMs,
    started_at: new Date(nowMs).toISOString(),
    expires_at: expiresAtFromNow(verification.dataTtlDays, nowMs),
  };

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

/** 開始 API の応答（202 Accepted。要件 11.9） */
export function toStartLoadTestResponse(
  record: LoadTestExecutionRecord
): StartLoadTestResponse {
  return {
    executionId: record.execution_id,
    status: record.status,
    targetOrdersPerMinute: record.target_orders_per_minute,
    durationSeconds: record.duration_seconds,
    useRampCurve: record.use_ramp_curve,
    startedAt: record.started_at,
    openShardCount: record.open_shard_count ?? null,
    shardCountError: record.shard_count_error ?? null,
    estimatedCapacityPerMinute: record.estimated_capacity_per_minute ?? null,
  };
}

/** 投入件数の集計（ワーカーが自己再帰を跨いで持ち回る値） */
export interface SubmissionCounters {
  /** 実際に書き込めた件数（要件 11.6） */
  submittedCount: number;
  /** 書き込めなかった件数 */
  submitErrorCount: number;
}

export interface ProgressUpdateInput extends SubmissionCounters {
  tableName: string;
  executionId: string;
}

/**
 * 投入件数を更新する（`status` は変えない）。
 *
 * ## 加算（`ADD`）ではなく代入（`SET`）にする
 *
 * ワーカーは常に 1 世代だけが動き、累積値をペイロードで引き継ぐ（design 論点 2）。
 * したがって書き込む値は「実行開始からの累積」であり、代入で足りる。
 *
 * 加算にすると、非同期 invoke の再試行（Lambda の既定は 2 回）で
 * 同じ世代が二重に走ったときに件数が二重計上され、
 * 実測投入レートが実際より高く記録される。レートは design §2.4 の算術の
 * 分子なので、過大な値は壁の位置の結論を歪める。代入なら二重実行でも
 * 値が同じになる（冪等）。
 *
 * ## 条件式で TTL 削除済みのレコードを復活させない
 *
 * `attribute_exists(execution_id)` を付ける。`UpdateItem` は既定で
 * レコードが無ければ**新規作成する**ため、条件を付けないと
 * TTL で消えた実行が `status` を持たない歪な形で復活する。
 */
export function buildProgressUpdateInput(input: ProgressUpdateInput): UpdateCommandInput {
  return {
    TableName: input.tableName,
    Key: { execution_id: input.executionId },
    UpdateExpression:
      'SET submitted_count = :submitted, submit_error_count = :submitErrors',
    ConditionExpression: 'attribute_exists(execution_id)',
    ExpressionAttributeValues: {
      ':submitted': input.submittedCount,
      ':submitErrors': input.submitErrorCount,
    },
  };
}

export interface CompletionUpdateInput extends SubmissionCounters {
  tableName: string;
  executionId: string;
  /** 実測レートの評価結果（要件 11.11、design 論点 10） */
  rate: RateEvaluation;
  /** 完了時刻（ミリ秒）。既定は現在時刻 */
  nowMs?: number;
}

/**
 * 実行を `COMPLETED` にする（要件 11.6 / 11.11）。
 *
 * `rate_deviation_warning` は**真偽どちらでも書く**。属性の不在で
 * 「乖離が無かった」と「評価していない」が区別できなくなるのを避けるためである
 * （評価していないのは `FAILED` で終わった実行だけ、という状態にする）。
 */
export function buildCompletionUpdateInput(
  input: CompletionUpdateInput
): UpdateCommandInput {
  const nowMs = input.nowMs ?? Date.now();

  return {
    TableName: input.tableName,
    Key: { execution_id: input.executionId },
    UpdateExpression: [
      'SET #status = :status',
      'finished_at = :finishedAt',
      'submitted_count = :submitted',
      'submit_error_count = :submitErrors',
      'actual_orders_per_minute = :actualRate',
      'rate_deviation_warning = :rateWarning',
    ].join(', '),
    ConditionExpression: 'attribute_exists(execution_id)',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': 'COMPLETED' satisfies ExecutionStatus,
      ':finishedAt': new Date(nowMs).toISOString(),
      ':submitted': input.submittedCount,
      ':submitErrors': input.submitErrorCount,
      ':actualRate': input.rate.actualOrdersPerMinute,
      ':rateWarning': input.rate.rateDeviationWarning,
    },
  };
}

export interface FailureUpdateInput extends Partial<SubmissionCounters> {
  tableName: string;
  executionId: string;
  /** 失敗の理由（`formatExecutionError` で整形した文字列） */
  errorMessage: string;
  /** 失敗を記録した時刻（ミリ秒）。既定は現在時刻 */
  nowMs?: number;
}

/**
 * 実行を `FAILED` にする（design §E-6）。
 *
 * 自己 invoke の失敗と、ワーカー内の例外の双方でここを通る。
 * 検証者が気づく経路は実行状態のポーリングだけなので、
 * **`RUNNING` のまま放置しない**ことがこの関数の存在理由である。
 *
 * 投入件数は分かっていれば一緒に書く（開始 API での失敗など、
 * 1 件も投入していない段階では省略する）。
 * 実測レートは書かない。中断した実行のレートを記録すると、
 * 目標より低い値が「達成できなかったレート」として §2.4 の算術に
 * 使われてしまう（Property 11 は実測レートが無い実行を除外する側に倒している）。
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
    ':errorMessage': truncateErrorMessage(input.errorMessage),
  };

  if (input.submittedCount !== undefined) {
    setExpressions.push('submitted_count = :submitted');
    values[':submitted'] = input.submittedCount;
  }
  if (input.submitErrorCount !== undefined) {
    setExpressions.push('submit_error_count = :submitErrors');
    values[':submitErrors'] = input.submitErrorCount;
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
 * 例外を `error_message` に載せる 1 行へ整形する。
 *
 * 例外の名前を残すのは、`AccessDeniedException`（IAM の配線漏れ）と
 * `ResourceNotFoundException`（テーブル名の取り違え）を
 * 実行レコードだけで見分けられるようにするためである
 * （`shard-count.ts` の `toShardCountErrorReason` と同じ理由）。
 */
export function formatExecutionError(error: unknown): string {
  const reason =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : `UnknownError: ${String(error)}`;
  return truncateErrorMessage(reason);
}

function truncateErrorMessage(message: string): string {
  const collapsed = message.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${collapsed.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`
    : collapsed;
}
