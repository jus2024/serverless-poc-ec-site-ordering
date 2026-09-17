/**
 * 1 リクエストの結果の分類と集計（要件 12.2、design 論点 3）。
 *
 * ## なぜスロットルを別に数えるのか
 *
 * 要件 12.2 は `429` と `TooManyRequestsException` を**他のエラーと区別**して
 * 集計することを求めている。この区別が本 Spec の結論を分ける。
 *
 * | 分類 | 意味 |
 * |------|------|
 * | スロットル | 同期パスが**枠の奪い合いに負けた**（波及が起きた証拠） |
 * | その他のエラー | 400（対象の指定ミス）、404（存在しない注文）、5xx、接続断など |
 *
 * 波及の有無（要件 12.6。軸 A では「発生しない」ことの実証が成果になる）を
 * 判定するのはスロットル件数であり、両者を混ぜると
 * 「対象の指定を間違えた計測」と「波及が起きた計測」が同じ数字に見える。
 *
 * ## 2 つのスロットルの出方
 *
 * | 出方 | 経路 |
 * |------|------|
 * | HTTP `429` | API Gateway 自身のスロットル（アカウント/ステージのレート上限） |
 * | 本文に `TooManyRequestsException` | Lambda 側のスロットルが統合エラーとして表に出た場合 |
 *
 * 後者は API Gateway が 429 以外（500 / 502）で返すことがあるため、
 * **ステータスコードだけでは足りない**。本文も見る。
 *
 * 分類を純粋関数にしているのは、HTTP を実際に飛ばさずに
 * 分類規則そのものを単体テストするためである（design §12）。
 */

/** 1 リクエストの結果 */
export type RequestOutcome =
  /** 2xx が返った */
  | 'SUCCESS'
  /** スロットル（要件 12.2） */
  | 'THROTTLE'
  /** スロットル以外のエラー（4xx / 5xx / 接続断） */
  | 'OTHER_ERROR';

/** API Gateway 自身のスロットルのステータスコード */
export const THROTTLE_STATUS_CODE = 429;

/**
 * 本文・例外メッセージに含まれていればスロットルと見なす文字列（要件 12.2）。
 *
 * 大小を無視して照合する。API Gateway の統合エラーの本文は
 * `{"message":"Rate exceeded"}` のように整形される場合と、
 * SDK の例外名がそのまま載る場合の両方があるため。
 */
export const THROTTLE_ERROR_MARKER = 'toomanyrequestsexception';

/**
 * 分類のために保持する本文の長さ上限（文字）。
 *
 * 本文は最後まで読み切るが（読み捨てないと keep-alive が使えない）、
 * **保持するのは先頭だけ**にする。並行数 200 で数万件を撃つ計測で
 * 全文を残すとメモリが本文で埋まり、レイテンシの標本の方が先に入らなくなる。
 * エラーの本文（`{"error":"...","message":"..."}`。design §E-1）は
 * この長さに収まる。
 */
export const MAX_CLASSIFIED_BODY_LENGTH = 512;

export interface ClassifyOutcomeInput {
  /** HTTP ステータスコード。応答が返らなかった場合は未設定 */
  statusCode?: number;
  /** 応答本文の先頭（`MAX_CLASSIFIED_BODY_LENGTH` まで） */
  body?: string;
  /** 送信中の例外（接続断・タイムアウトなど）。応答が返った場合は未設定 */
  error?: unknown;
}

/**
 * 1 リクエストの結果を分類する（要件 12.2）。
 *
 * 判定の順序に意味がある。
 *
 * 1. スロットルの印（`429` またはメッセージ）を**最初に**見る。
 *    2xx を先に判定すると、`429` を返しつつ本文に印を持つ応答は
 *    もちろん問題ないが、逆に「200 だが本文に印がある」応答
 *    （API Gateway のモック統合など）を成功に数えてしまう
 * 2. 応答が返らなかった場合はその他のエラー
 * 3. 2xx なら成功、それ以外はその他のエラー
 *
 * @throws なし（どんな入力でも 3 つのいずれかに落とす。計測を止めない）
 */
export function classifyOutcome(input: ClassifyOutcomeInput): RequestOutcome {
  if (input.statusCode === THROTTLE_STATUS_CODE) {
    return 'THROTTLE';
  }
  if (containsThrottleMarker(input.body) || containsThrottleMarker(toMessage(input.error))) {
    return 'THROTTLE';
  }
  if (input.error !== undefined || input.statusCode === undefined) {
    return 'OTHER_ERROR';
  }
  return input.statusCode >= 200 && input.statusCode < 300 ? 'SUCCESS' : 'OTHER_ERROR';
}

/** 本文の保持分だけを切り出す（`MAX_CLASSIFIED_BODY_LENGTH` を超える分は捨てる） */
export function truncateBodyForClassification(body: string): string {
  return body.length > MAX_CLASSIFIED_BODY_LENGTH
    ? body.slice(0, MAX_CLASSIFIED_BODY_LENGTH)
    : body;
}

/** 結果の内訳（実行レコードの `throttle_count` / `other_error_count` に対応） */
export interface OutcomeCounters {
  /** 送信したリクエストの総数 */
  requestCount: number;
  /** 2xx が返った件数 */
  successCount: number;
  /** スロットル件数（要件 12.2） */
  throttleCount: number;
  /** スロットル以外のエラー件数 */
  otherErrorCount: number;
}

/** 空の内訳を作る */
export function createOutcomeCounters(): OutcomeCounters {
  return { requestCount: 0, successCount: 0, throttleCount: 0, otherErrorCount: 0 };
}

/**
 * 内訳に 1 件を加える（呼び出し元の集計を破壊的に更新する）。
 *
 * 純粋関数（新しいオブジェクトを返す形）にしていないのは、
 * 並行数 200 で数万件を撃つループの中で毎回オブジェクトを作ると
 * GC が計測中に走り、**レイテンシの標本に自分のノイズが乗る**ためである。
 */
export function countOutcome(counters: OutcomeCounters, outcome: RequestOutcome): void {
  counters.requestCount += 1;
  switch (outcome) {
    case 'SUCCESS':
      counters.successCount += 1;
      return;
    case 'THROTTLE':
      counters.throttleCount += 1;
      return;
    case 'OTHER_ERROR':
      counters.otherErrorCount += 1;
      return;
  }
}

function containsThrottleMarker(text: string | undefined): boolean {
  return text !== undefined && text.toLowerCase().includes(THROTTLE_ERROR_MARKER);
}

function toMessage(error: unknown): string | undefined {
  if (error === undefined || error === null) {
    return undefined;
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
