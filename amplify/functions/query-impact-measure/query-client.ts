/**
 * 照会 API への HTTP 送信と接続数上限の明示（design 論点 3、要件 12.1 / 12.7）。
 *
 * ## グローバルな `fetch` を使わない
 *
 * design 論点 3 は「Node.js の既定エージェントは接続数に上限があるため、
 * 明示的に接続数上限を上げる」ことを求めている。**上限に達すると
 * リクエストは接続待ちのキューに積まれ、その待ち時間がレイテンシに乗る。**
 * つまり測っているのは照会 API のレイテンシではなく自分のキュー待ちになり、
 * 並行数 60 を指定しても実際には数本しか同時に飛んでいない、という結果になる。
 * 波及の有無（要件 12.6）を測る装置として成立しない。
 *
 * Node 22 のグローバル `fetch` は undici の既定ディスパッチャを使うが、
 * **その接続数上限を設定する API は Node の公開 API に無い**
 * （`undici` パッケージの `Agent` / `setGlobalDispatcher` が必要で、
 * それは本リポジトリの依存に無い）。上限を明示できないものを使うのは
 * 論点 3 の要求そのものを満たせないため、標準モジュールの
 * `node:http` / `node:https` を直接使い、**自分で作った Agent に
 * `maxSockets` を明示する。**
 *
 * 代償は `fetch` より記述量が増えることだが、得られるものが 3 つある。
 *
 * - 接続数上限を数値で宣言でき、値の根拠をコードに書ける
 * - keep-alive を明示でき、TLS ハンドシェイクが毎回レイテンシに乗らない
 * - レイテンシの計測終端を**本文の読み切りまで**にできる
 *   （`fetch` は本文を遅延評価するため、素朴に測ると TTFB になる）
 *
 * ## レイテンシの定義
 *
 * リクエスト開始から**応答本文を読み切るまで**の実時間（ミリ秒、小数あり）。
 * `performance.now()` の差分で測る（単調増加なので実行中の時刻補正に影響されない）。
 * 接続の確立とキュー待ちも含む。検証者のブラウザが体感する時間に最も近い定義であり、
 * 波及が「遅くなる」形で現れたときに取りこぼさない。
 */

import {
  Agent as HttpAgent,
  request as httpRequest,
  type RequestOptions,
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import {
  MAX_CLASSIFIED_BODY_LENGTH,
  type RequestOutcome,
  classifyOutcome,
  truncateBodyForClassification,
} from './request-outcome.js';

/** 計測に使う HTTP(S) エージェント */
export type MeasureAgent = HttpAgent | HttpsAgent;

/**
 * 並行数に対して余分に確保するソケット数。
 *
 * keep-alive のソケットは API Gateway 側の idle timeout や
 * `Connection: close` で入れ替わる。入れ替えの最中は
 * 「閉じかけの 1 本」と「新しい 1 本」が同時に存在するため、
 * `maxSockets` を並行数ぴったりにすると、その瞬間だけ接続待ちが発生する。
 * 待ちはレイテンシの裾（p99）に乗るので、少し余らせておく。
 */
export const MEASURE_SOCKET_HEADROOM = 8;

/**
 * 1 リクエストのタイムアウト（ミリ秒）。
 *
 * API Gateway の統合タイムアウト上限は 29 秒（design 論点 3）なので、
 * それを 1 秒上回る 30 秒にしている。ここを短くすると
 * **波及によって遅くなった応答を「タイムアウト」として捨ててしまい**、
 * 分位点の裾（p99・最大）が実態より小さく記録される。
 * 逆に無制限にすると、詰まった接続がワーカーの残り時間を食い潰す。
 */
export const MEASURE_REQUEST_TIMEOUT_MS = 30_000;

/** 1 リクエストの計測結果 */
export interface QueryRequestResult {
  /** リクエスト開始から本文読み切りまでの実時間（ミリ秒。小数あり） */
  latencyMs: number;
  /** 分類（要件 12.2） */
  outcome: RequestOutcome;
  /** HTTP ステータスコード。応答が返らなかった場合は未設定 */
  statusCode?: number;
}

/**
 * 明示すべき接続数上限を返す（design 論点 3）。
 *
 * 並行数 + 余裕。1 リクエストが 1 ソケットを占有する（HTTP/1.1 で
 * パイプライニングは使わない）ため、下回ると必ず接続待ちが生じる。
 */
export function resolveMaxSockets(
  concurrency: number,
  headroom: number = MEASURE_SOCKET_HEADROOM
): number {
  return Math.max(1, Math.floor(concurrency)) + headroom;
}

export interface CreateMeasureAgentInput {
  /** 計測対象の URL（プロトコルの判定に使う） */
  url: string;
  /** 並行数（要件 12.7） */
  concurrency: number;
  /** 接続数上限の余裕。既定は `MEASURE_SOCKET_HEADROOM` */
  headroom?: number;
}

/**
 * 計測用のエージェントを作る。
 *
 * `keepAlive` を有効にし、`maxFreeSockets` を `maxSockets` と同じにする。
 * 空きソケットの上限を絞ると、リクエストの合間に接続が閉じられ、
 * 次のリクエストで TLS ハンドシェイク（数十ミリ秒）がレイテンシに乗る。
 * 計測したいのは照会 API の応答時間なので、接続の作り直しは避ける。
 *
 * `scheduling: 'fifo'` にするのは、上限に達したときの待ち順を
 * 先着順にしておくためである（既定の `lifo` は待ち時間の分布を歪める）。
 */
export function createMeasureAgent(input: CreateMeasureAgentInput): MeasureAgent {
  const maxSockets = resolveMaxSockets(input.concurrency, input.headroom);
  const options = {
    keepAlive: true,
    keepAliveMsecs: 1_000,
    maxSockets,
    maxFreeSockets: maxSockets,
    scheduling: 'fifo' as const,
  };

  return new URL(input.url).protocol === 'http:'
    ? new HttpAgent(options)
    : new HttpsAgent(options);
}

export interface SendQueryRequestInput {
  /** 計測対象の URL（`buildQueryTargetUrl` の戻り値） */
  url: string;
  /** `createMeasureAgent` で作ったエージェント */
  agent: MeasureAgent;
  /** タイムアウト（ミリ秒）。既定は `MEASURE_REQUEST_TIMEOUT_MS` */
  timeoutMs?: number;
}

/**
 * 1 リクエストを送り、レイテンシと分類を返す。
 *
 * **この関数は例外を投げない。** 接続断・タイムアウト・DNS 失敗はいずれも
 * 「その他のエラー」（要件 12.2）として計測結果に数えるべき事象であり、
 * 例外にすると計測ループが止まって**壁に当たった瞬間に計測が終わる**。
 * `load-generator` の `writeBatch` が投入エラーを飲み込むのと同じ判断。
 *
 * 本文は最後まで読み切る。読み捨てるとソケットが keep-alive の
 * プールに戻らず、次のリクエストが接続を作り直す。
 */
export function sendQueryRequest(
  input: SendQueryRequestInput
): Promise<QueryRequestResult> {
  const timeoutMs = input.timeoutMs ?? MEASURE_REQUEST_TIMEOUT_MS;
  const options: RequestOptions = {
    agent: input.agent,
    method: 'GET',
    timeout: timeoutMs,
    headers: { accept: 'application/json' },
  };
  const requestFn = new URL(input.url).protocol === 'http:' ? httpRequest : httpsRequest;

  return new Promise<QueryRequestResult>((resolve) => {
    const startedAt = performance.now();
    let settled = false;

    const finish = (result: Omit<QueryRequestResult, 'latencyMs'>): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ ...result, latencyMs: performance.now() - startedAt });
    };

    const request = requestFn(input.url, options, (response) => {
      const statusCode = response.statusCode;
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        // 分類に使う先頭だけ残す。全文を溜めるとメモリが本文で埋まる
        if (body.length < MAX_CLASSIFIED_BODY_LENGTH) {
          body = truncateBodyForClassification(body + chunk);
        }
      });
      response.on('end', () => {
        finish({ statusCode, outcome: classifyOutcome({ statusCode, body }) });
      });
      response.on('error', (error: unknown) => {
        finish({ statusCode, outcome: classifyOutcome({ statusCode, body, error }) });
      });
    });

    request.on('timeout', () => {
      // `timeout` は接続を閉じない。明示的に破棄しないとソケットが残り続ける
      request.destroy(new Error(`計測リクエストがタイムアウトしました（${timeoutMs}ms）`));
    });
    request.on('error', (error: unknown) => {
      finish({ outcome: classifyOutcome({ error }) });
    });

    request.end();
  });
}
