/**
 * 計測ワーカーのペイロード（要件 12.1、design 論点 3 / §5.2 / §E-6）。
 *
 * `query-impact-measure` は 1 つの関数で 2 つの入口を持つ
 * （`load-generator/worker-event.ts` と同じ構造）。
 *
 * | 入口 | イベント | 応答 |
 * |------|---------|------|
 * | `POST /measure/start` | API Gateway プロキシイベント | 202 + 実行 ID |
 * | 計測ワーカー | 本モジュールの `MeasureWorkerEvent` | なし（非同期 invoke） |
 *
 * ## 世代（`generation`）を持たない
 *
 * `load-generator` のワーカーは残り時間が尽きると自身を非同期 invoke して
 * 引き継ぐが、**計測ワーカーは引き継がない。** 1 回の invoke で測り切る。
 *
 * 理由は分位点（要件 12.3）である。世代を跨ぐには全リクエストのレイテンシを
 * ペイロード（上限 256KB）で持ち回るか、世代ごとに分位点を切るかしかなく、
 * 前者は容量が足りず、後者は「実行全体の p99」を
 * 「最後の世代の p99」にすり替える。詳細は
 * `measure-request.ts` の `MAX_MEASURE_DURATION_SECONDS` の注記を参照。
 *
 * 引き継がないので、状態（累積件数・標本）をペイロードに載せる必要もない。
 * 載っているのは開始 API が決めた不変の情報だけである。
 */

import type { MeasureParams } from './measure-request.js';

/** ワーカー呼び出しの判別子 */
export const MEASURE_WORKER_MODE = 'MEASURE_WORKER';

/** 計測ワーカーのペイロード */
export interface MeasureWorkerEvent {
  mode: typeof MEASURE_WORKER_MODE;
  /** 実行 ID（実行レコードの PK） */
  executionId: string;
  /** 検証済みの計測パラメータ（開始 API で検証済み。ワーカーでは再検証しない） */
  params: MeasureParams;
  /** 計測対象の絶対 URL（開始 API がベース URL から組み立てる） */
  targetUrl: string;
  /** 実行の開始時刻（ミリ秒）。継続時間の判定の起点 */
  startedAtMs: number;
}

/** ワーカー呼び出しのペイロードを組み立てる */
export function buildMeasureWorkerEvent(input: {
  executionId: string;
  params: MeasureParams;
  targetUrl: string;
  startedAtMs: number;
}): MeasureWorkerEvent {
  return {
    mode: MEASURE_WORKER_MODE,
    executionId: input.executionId,
    params: input.params,
    targetUrl: input.targetUrl,
    startedAtMs: input.startedAtMs,
  };
}

/**
 * ワーカー呼び出しかを判別する。
 *
 * 形をきちんと検査するのは、判別を誤ると**API Gateway イベントとして
 * 処理されてしまう**ためである。その場合 `event.body` が無いので
 * 必須項目の欠落として 400 を返し、計測の起動が
 * 「呼ばれたが何もしなかった」形で静かに消える
 * （実行レコードは `RUNNING` のまま残り、検証者は計測中だと誤解する）。
 */
export function isMeasureWorkerEvent(event: unknown): event is MeasureWorkerEvent {
  if (typeof event !== 'object' || event === null) {
    return false;
  }

  const candidate = event as Partial<MeasureWorkerEvent>;
  return (
    candidate.mode === MEASURE_WORKER_MODE &&
    typeof candidate.executionId === 'string' &&
    typeof candidate.targetUrl === 'string' &&
    typeof candidate.startedAtMs === 'number' &&
    isMeasureParams(candidate.params)
  );
}

function isMeasureParams(params: unknown): params is MeasureParams {
  if (typeof params !== 'object' || params === null) {
    return false;
  }
  const candidate = params as Partial<MeasureParams>;
  return (
    typeof candidate.concurrency === 'number' &&
    typeof candidate.durationSeconds === 'number' &&
    typeof candidate.target === 'object' &&
    candidate.target !== null
  );
}
