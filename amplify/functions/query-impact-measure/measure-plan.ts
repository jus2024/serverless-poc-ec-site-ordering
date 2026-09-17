/**
 * 計測ループの打ち切り判定（要件 12.1 / 12.3、design 論点 3）。
 *
 * 時間と AWS 呼び出しを扱わない純粋関数だけを置く（`load-generator/load-plan.ts` と同じ方針）。
 * ワーカー（`handler.ts`）は並行数だけの送信ループを回し、1 リクエストの完了ごとに
 * ここへ「続けてよいか」を尋ねる。
 */

import { PROGRESS_FLUSH_INTERVAL_MS } from '../load-generator/load-plan.js';

export { PROGRESS_FLUSH_INTERVAL_MS };

/**
 * 分位点の算出と実行レコードの更新のために残す時間（ミリ秒）。
 *
 * 15 秒。標本 50 万件の整列は 1 秒に届かないが、`UpdateItem` の再試行と
 * ログの書き出しを含めても確実に終わる幅を取っている。
 * ここが足りずにタイムアウトすると、**計測は完走したのに結果が
 * 1 件も残らない**（実行レコードは `RUNNING` のまま。`error_message` も付かない）。
 * 計測の数秒を惜しんで結果を失うのは割に合わない。
 */
export const FINALIZE_RESERVE_MS = 15_000;

/**
 * レイテンシ標本の上限件数。
 *
 * 要件 12.3 の分位点は最近順位法（`shared/percentiles.ts`）で算出するため、
 * **標本の配列そのものをメモリに置く必要がある。** 100 万件で
 * 数値配列としておよそ数十 MB になり、`query-impact-measure` の
 * メモリ 1024MB（design §5.2）に対して安全側に収まる。
 *
 * 上限に達したら計測を**打ち切って完了させる**（標本を捨てて続けない）。
 * 捨てて続けると分位点が「全件」から外れ、要件 12.3 の意味が変わる。
 * design §10.2 の並行計測は 2 分なので、現実のシナリオでここに達するのは
 * 並行数と応答速度の想定が大きく外れた場合だけであり、
 * そのときは短い計測結果が残る方が、OOM で何も残らないより良い。
 */
export const MAX_LATENCY_SAMPLES = 1_000_000;

/** ワーカーが次に取る行動 */
export type MeasureAction =
  /** 次のリクエストを送る */
  | 'CONTINUE'
  /** 打ち切って結果を確定させる */
  | 'FINISH';

/** 打ち切りの理由（ログと切り分けのために区別する） */
export type MeasureFinishReason =
  /** 指定した継続時間に達した（正常な終わり方） */
  | 'DURATION_REACHED'
  /** invoke の残り時間が結果の書き出し分を切った */
  | 'INVOKE_BUDGET'
  /** 標本が上限に達した */
  | 'SAMPLE_LIMIT';

export interface ResolveMeasureActionInput {
  /** 計測開始からの経過時間（ミリ秒） */
  elapsedMs: number;
  /** 指定された継続時間（秒） */
  durationSeconds: number;
  /** この invoke の残り実行時間（ミリ秒。`context.getRemainingTimeInMillis()`） */
  remainingInvokeMs: number;
  /** ここまでに記録した標本の件数 */
  sampleCount: number;
  /** 結果の書き出しに残す時間（ミリ秒）。既定は `FINALIZE_RESERVE_MS` */
  finalizeReserveMs?: number;
  /** 標本の上限件数。既定は `MAX_LATENCY_SAMPLES` */
  maxSamples?: number;
}

export interface MeasureDecision {
  action: MeasureAction;
  /** `action === 'FINISH'` のときだけ設定される */
  reason?: MeasureFinishReason;
}

/**
 * 続けるか打ち切るかを決める。
 *
 * 継続時間の判定を最初に行う。指定どおり測り切った実行を
 * 「invoke の残り時間で打ち切った」と記録すると、
 * ログを見た検証者が計測が短縮されたと誤解する。
 */
export function resolveMeasureAction(input: ResolveMeasureActionInput): MeasureDecision {
  const finalizeReserveMs = input.finalizeReserveMs ?? FINALIZE_RESERVE_MS;
  const maxSamples = input.maxSamples ?? MAX_LATENCY_SAMPLES;

  if (input.elapsedMs >= input.durationSeconds * 1_000) {
    return { action: 'FINISH', reason: 'DURATION_REACHED' };
  }
  if (input.remainingInvokeMs <= finalizeReserveMs) {
    return { action: 'FINISH', reason: 'INVOKE_BUDGET' };
  }
  if (input.sampleCount >= maxSamples) {
    return { action: 'FINISH', reason: 'SAMPLE_LIMIT' };
  }
  return { action: 'CONTINUE' };
}
