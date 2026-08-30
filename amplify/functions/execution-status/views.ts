/**
 * `execution-status` の DynamoDB コマンド組み立てと応答の整形
 * （design §4.3 / §5.8 / §5.9、要件 11.6 / 12.5）。
 *
 * ## 読み取りしかしない（design §5.9）
 *
 * IAM は `executions: GetItem` のみ。`Put` / `Update` / `Delete` は
 * **意図的に import していない**（`order-query/views.ts` と同じ方針）。
 * 実行レコードを書けるのは負荷生成と並行計測の当事者だけであり、
 * 照会が値を書き換えると投入件数や実測レートの出典が曖昧になる。
 *
 * ## `Query` ではなく `GetItem` を使う
 *
 * 実行管理テーブルは PK `execution_id` のみで SK を持たない（design §4.1）。
 * 注文テーブル（PK + SK）で `Query` を使わざるを得なかった事情（design §4.2）は
 * こちらには当てはまらないため、素直に `GetItem` で 1 件を取る。
 *
 * ## 両方の `execution_type` を今のうちに扱う
 *
 * `QUERY_IMPACT` を書くのは並行計測（タスク 18）だが、判別と整形は
 * ここで完成させる。実行管理テーブルは 2 種類の実行を共有しており（design §4.3）、
 * 「片方しか読めない照会 API」は配線した瞬間に壊れた振る舞い
 * （並行計測の実行 ID を渡すと 500）になる。
 */

import type { GetCommandInput } from '@aws-sdk/lib-dynamodb';
import type {
  ExecutionConditionsView,
  ExecutionRecord,
  ExecutionStatusResponse,
  ExecutionStatusResponseBase,
  LoadTestExecutionRecord,
  LoadTestStatusResponse,
  QueryImpactExecutionRecord,
  QueryImpactStatusResponse,
} from '../shared/types.js';

/**
 * 実行レコードを 1 件取得する `GetItem` の入力を組み立てる。
 *
 * ## `ConsistentRead` を有効にする
 *
 * 実行中の負荷生成は数秒おきに投入件数を書き換える
 * （`load-generator/execution-record.ts` の `buildProgressUpdateInput`）。
 * 結果整合の読み取りでは、完了直後の実行が `RUNNING` のまま返ることがあり、
 * 検証者が「まだ流れている」と誤認したまま次のシナリオへ進みかねない。
 *
 * 代償は 1 件あたり 0.5 → 1 RCU だが、実行レコードは検証全体で数十件しかなく、
 * このテーブルは観測対象（注文テーブル）とは別なので、
 * 消費容量が壁の位置の観測に影響することはない。
 */
export function buildExecutionGetInput(input: {
  tableName: string;
  executionId: string;
}): GetCommandInput {
  return {
    TableName: input.tableName,
    Key: { execution_id: input.executionId },
    ConsistentRead: true,
  };
}

/**
 * `execution_type` が既知の値でなかった実行レコード。
 *
 * `ApiError` にしていないのは、呼び出し側では直せないからである。
 * 実行レコードを書くのは `load-generator` と `query-impact-measure` だけなので、
 * ここに来るのは書き手側の不整合（design §4.3 の一覧に無い種別を書いた）である。
 * ハンドラは ERROR ログを出して 500 `INTERNAL_ERROR` に落とす（design §E-1）。
 */
export class UnknownExecutionTypeError extends Error {
  readonly executionId: string;
  readonly executionType: unknown;

  constructor(executionId: string, executionType: unknown) {
    super(
      `未知の execution_type です（design §4.3 の一覧を確認してください）: ${String(
        executionType
      )}`
    );
    this.name = 'UnknownExecutionTypeError';
    this.executionId = executionId;
    this.executionType = executionType;
  }
}

/**
 * 実行レコードを照会レスポンスへ変換する（要件 11.6 / 12.5）。
 *
 * @param nowMs 実行中のレコードの経過時間を測る基準時刻。既定は現在時刻
 * @throws {UnknownExecutionTypeError} `execution_type` が既知の値でない場合
 */
export function toExecutionStatusResponse(
  record: ExecutionRecord,
  nowMs: number = Date.now()
): ExecutionStatusResponse {
  switch (record.execution_type) {
    case 'LOAD_TEST':
      return toLoadTestStatusResponse(record, nowMs);
    case 'QUERY_IMPACT':
      return toQueryImpactStatusResponse(record, nowMs);
    default:
      // 型の上では到達しないが、テーブルの中身は型で守られていない
      throw new UnknownExecutionTypeError(
        (record as ExecutionRecord).execution_id,
        (record as { execution_type?: unknown }).execution_type
      );
  }
}

/**
 * 負荷生成の実行状態（要件 11.6: 投入件数・エラー件数・経過時間・実行条件）。
 *
 * `actual_orders_per_minute` と `rate_deviation_warning` は完了時にしか書かれない
 * （`load-generator/execution-record.ts`）。ここで 0 や false へ埋めると、
 * 「実測していない」ことが「レート 0 だった」「乖離が無かった」に化けて
 * design §2.4 の算術に紛れ込む（Property 11）。属性の不在は null で通す。
 */
function toLoadTestStatusResponse(
  record: LoadTestExecutionRecord,
  nowMs: number
): LoadTestStatusResponse {
  return {
    ...toCommonView(record, nowMs),
    executionType: 'LOAD_TEST',
    targetOrdersPerMinute: record.target_orders_per_minute,
    actualOrdersPerMinute: record.actual_orders_per_minute ?? null,
    rateDeviationWarning: record.rate_deviation_warning ?? null,
    useRampCurve: record.use_ramp_curve,
    submittedCount: record.submitted_count ?? 0,
    submitErrorCount: record.submit_error_count ?? 0,
  };
}

/**
 * 並行計測の結果（要件 12.5）。
 *
 * `latency_percentiles` は計測完了まで書かれないため null で返す。
 * エラー件数は計測開始時から積み上がる値なので、
 * 属性が無い場合（開始直後）は 0 に寄せる方が実態に近い。
 *
 * `request_count` と `load_test_id` も返す。前者はエラー率の分母
 * （要件 12.1。件数だけではスロットルの増加が並行数の増加によるものか
 * 率の悪化によるものか区別できない）、後者は投入レートの参照先である
 * （実測レートは負荷生成の実行レコード側が出典。要件 12.5 / Property 11）。
 */
function toQueryImpactStatusResponse(
  record: QueryImpactExecutionRecord,
  nowMs: number
): QueryImpactStatusResponse {
  return {
    ...toCommonView(record, nowMs),
    executionType: 'QUERY_IMPACT',
    concurrency: record.concurrency,
    latencyPercentiles: record.latency_percentiles ?? null,
    throttleCount: record.throttle_count ?? 0,
    otherErrorCount: record.other_error_count ?? 0,
    requestCount: record.request_count ?? 0,
    loadTestId: record.load_test_id ?? null,
  };
}

/** 両方の種別に共通する部分（`executionType` は各変換関数が具体値で上書きする） */
function toCommonView(
  record: ExecutionRecord,
  nowMs: number
): ExecutionStatusResponseBase {
  return {
    executionId: record.execution_id,
    executionType: record.execution_type,
    status: record.status,
    durationSeconds: record.duration_seconds,
    startedAt: record.started_at,
    finishedAt: record.finished_at ?? null,
    elapsedMs: resolveElapsedMs(record, nowMs),
    errorMessage: record.error_message ?? null,
    conditions: toConditionsView(record),
  };
}

/**
 * 経過ミリ秒を算出する（要件 11.6）。
 *
 * 完了・失敗した実行は `finished_at − started_at`、実行中は現在時刻までの経過。
 * **実行中の値が `duration_seconds` を超えることは起こり得る**（ワーカーが
 * 落ちた実行は `RUNNING` のまま残り得る。design §E-6 で `FAILED` にするが、
 * 実行レコードのテーブル名すら解決できない失敗だけは記録に残らない）。
 * その超過は異常の兆候そのものなので、`duration_seconds` で丸めない。
 *
 * 時刻が解釈できない場合は null を返す。0 を返すと
 * 「開始直後」と「時刻が壊れている」の区別がつかなくなる。
 */
export function resolveElapsedMs(
  record: ExecutionRecord,
  nowMs: number = Date.now()
): number | null {
  const startedMs = Date.parse(record.started_at);
  if (Number.isNaN(startedMs)) {
    return null;
  }

  const endMs = record.finished_at === undefined ? nowMs : Date.parse(record.finished_at);
  if (Number.isNaN(endMs)) {
    return null;
  }

  // 負の値は返さない（時刻の逆転は Lambda 実行環境間のずれで起こり得る）
  return Math.max(0, endMs - startedMs);
}

/**
 * 観測条件を返す（要件 19.3 / Property 10）。
 *
 * 消費能力の見積もりを**再計算しない**。実行レコードに刻まれた値は
 * 実行時点の S / P / D から算出したものであり、照会時の環境変数で
 * 引き直すと「別の条件の見積もり」が実行結果に紛れる
 * （PF や擬似処理時間はシナリオごとに再デプロイで変える。design §10.2）。
 */
function toConditionsView(record: ExecutionRecord): ExecutionConditionsView {
  return {
    openShardCount: record.open_shard_count ?? null,
    shardCountError: record.shard_count_error ?? null,
    parallelizationFactor: record.parallelization_factor,
    stageDelaysMs: record.stage_delays_ms,
    estimatedCapacityPerMinute: record.estimated_capacity_per_minute ?? null,
    warmThroughputWrite: record.warm_throughput_write ?? null,
  };
}
