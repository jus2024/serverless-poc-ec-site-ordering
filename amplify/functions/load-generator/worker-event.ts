/**
 * 自己再帰ワーカーのペイロード（要件 11.9、design 論点 2 / §E-6）。
 *
 * `load-generator` は 1 つの関数で 2 つの入口を持つ。
 *
 * | 入口 | イベント | 応答 |
 * |------|---------|------|
 * | `POST /load-test/start` | API Gateway プロキシイベント | 202 + 実行 ID |
 * | 自己再帰ワーカー | 本モジュールの `LoadWorkerEvent` | なし（非同期 invoke） |
 *
 * 関数を分けない理由は、分けると同じ投入ロジックを持つ関数が 2 つになり、
 * IAM 権限（注文テーブルへの `BatchWriteItem`）も 2 箇所に必要になるからである。
 * design §5.2 も 1 関数（`kiro-load-generator`）として定義している。
 *
 * ## 状態をペイロードで持ち回る
 *
 * 世代を跨いで必要な状態（開始時刻・累積投入件数・端数の繰り越し・世代数）は
 * すべてペイロードに載せる。実行レコードから読み直す設計にすると、
 * 引き継ぎのたびに実行管理テーブルへの読み取りが増えるうえ、
 * 進捗の書き出しが 5 秒間隔（`PROGRESS_FLUSH_INTERVAL_MS`）なので
 * **最後に書いた時点まで巻き戻る**（投入件数を取りこぼす）。
 *
 * `startedAtMs` を持ち回るのがとくに重要で、これが実行全体の起点になる。
 * 世代ごとの開始時刻を使うと負荷カーブの進捗率（要件 11.2）が
 * 世代の切り替わりで巻き戻り、漸増区間を何度も繰り返してしまう。
 */

import { MAX_WORKER_GENERATIONS } from './load-plan.js';
import type { LoadTestParams } from './load-test-request.js';

/** ワーカー呼び出しの判別子 */
export const LOAD_WORKER_MODE = 'LOAD_WORKER';

/** 自己再帰ワーカーのペイロード */
export interface LoadWorkerEvent {
  mode: typeof LOAD_WORKER_MODE;
  /** 実行 ID（実行レコードの PK、および投入する注文の `load_test_id`） */
  executionId: string;
  /** 検証済みの負荷生成パラメータ（開始 API で検証済み。ワーカーでは再検証しない） */
  params: LoadTestParams;
  /** 実行全体の開始時刻（ミリ秒）。世代を跨いで不変 */
  startedAtMs: number;
  /** ここまでに投入できた件数の累積 */
  submittedCount: number;
  /** ここまでに投入できなかった件数の累積 */
  submitErrorCount: number;
  /** 刻みの端数の繰り越し（低レートでの取りこぼしを防ぐ。`planTick` の注記） */
  carry: number;
  /** 世代数（1 が最初のワーカー）。`MAX_WORKER_GENERATIONS` で打ち切る */
  generation: number;
}

/** 最初のワーカー呼び出しのペイロードを組み立てる */
export function buildFirstWorkerEvent(input: {
  executionId: string;
  params: LoadTestParams;
  startedAtMs: number;
}): LoadWorkerEvent {
  return {
    mode: LOAD_WORKER_MODE,
    executionId: input.executionId,
    params: input.params,
    startedAtMs: input.startedAtMs,
    submittedCount: 0,
    submitErrorCount: 0,
    carry: 0,
    generation: 1,
  };
}

/** 引き継ぎ先のペイロードを組み立てる（世代を 1 つ進める） */
export function buildNextWorkerEvent(
  event: LoadWorkerEvent,
  state: { submittedCount: number; submitErrorCount: number; carry: number }
): LoadWorkerEvent {
  return {
    ...event,
    submittedCount: state.submittedCount,
    submitErrorCount: state.submitErrorCount,
    carry: state.carry,
    generation: event.generation + 1,
  };
}

/**
 * 世代数が上限に達していないかを確かめる。
 *
 * @throws {Error} 上限を超えた場合（引き継ぎ条件の判定が壊れている疑い）
 */
export function assertWorkerGeneration(generation: number): void {
  if (generation > MAX_WORKER_GENERATIONS) {
    throw new Error(
      `自己 invoke の世代数が上限（${MAX_WORKER_GENERATIONS}）を超えました（generation=${generation}）`
    );
  }
}

/**
 * ワーカー呼び出しかを判別する。
 *
 * 形をきちんと検査するのは、判別を誤ると**API Gateway イベントとして
 * 処理されてしまう**ためである。その場合 `event.body` が無いので
 * 空のリクエストとして 400 を返し、ワーカーの起動が
 * 「呼ばれたが何もしなかった」形で静かに消える（実行レコードは `RUNNING` のまま残る）。
 */
export function isLoadWorkerEvent(event: unknown): event is LoadWorkerEvent {
  if (typeof event !== 'object' || event === null) {
    return false;
  }

  const candidate = event as Partial<LoadWorkerEvent>;
  return (
    candidate.mode === LOAD_WORKER_MODE &&
    typeof candidate.executionId === 'string' &&
    typeof candidate.startedAtMs === 'number' &&
    typeof candidate.submittedCount === 'number' &&
    typeof candidate.submitErrorCount === 'number' &&
    typeof candidate.carry === 'number' &&
    typeof candidate.generation === 'number' &&
    isLoadTestParams(candidate.params)
  );
}

function isLoadTestParams(params: unknown): params is LoadTestParams {
  if (typeof params !== 'object' || params === null) {
    return false;
  }
  const candidate = params as Partial<LoadTestParams>;
  return (
    typeof candidate.ordersPerMinute === 'number' &&
    typeof candidate.durationSeconds === 'number' &&
    typeof candidate.useRampCurve === 'boolean'
  );
}
