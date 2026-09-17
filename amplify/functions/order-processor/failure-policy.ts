/**
 * 失敗の扱いを決める（design §E-2 / §E-5、要件 9.8 / 16.7）。
 *
 * ## 業務的な失敗はここに来ない
 *
 * 在庫不足と決済拒否（要件 5.3 / 4.5）は**例外にしない**。段階の実行結果として
 * `StageResult = 'FAILED'` を返し、注文レコードに終端ステータスを記録して
 * 後続段階を実行せずに終える（`stages.ts`）。
 *
 * 業務的な失敗を例外で表すと、`catch` の分岐を 1 つ書き忘れただけで
 * 「再試行しない」という約束（要件 16.7）が破れる。返り値にしておけば
 * **例外として上がってくるものは技術的な失敗しかない**ことが型で保証され、
 * この関数の判断は「再試行して意味があるか」だけに絞られる。
 *
 * ## なぜ再試行の有無を選別するのか
 *
 * 再試行対象にしたレコードは `retryAttempts = 3`（design §5.6）を消費し、
 * その間シャードの先頭を塞ぐ。DynamoDB Streams は順序を保証するため、
 * 1 件の恒久的な失敗が同一シャードの後続すべてを遅延させる（design §E-4）。
 * 遅延は `IteratorAge` に現れる。**本 Spec は `IteratorAge` で滞留を測る装置**
 * （design 論点 9）なので、直っても再試行で解決しない失敗を積むことは
 * 観測値そのものを汚す行為になる。
 */

import { isRetryableIdempotencyError } from '../shared/idempotency.js';
import { StagePreconditionError } from '../shared/order-status.js';
import { InvalidStreamRecordError } from './stream-record.js';

/** 失敗したレコードをどう扱うか */
export type FailureDisposition =
  /** 再試行しない。ログに残して次のレコードへ進む */
  | 'SKIP'
  /** `batchItemFailures` に積んで再試行させる（要件 9.8） */
  | 'RETRY';

/** 失敗の種別。ログに出して原因の切り分けに使う */
export type FailureKind =
  /** ストリームレコードの形が想定と違う（実装の不整合。`stream-record.ts` の注記） */
  | 'INVALID_RECORD'
  /** 冪等性の一時的な競合・永続化層のエラー（design §E-5） */
  | 'IDEMPOTENCY'
  /** `COMPLETED` の前提条件が未達（design §5.4 の条件式） */
  | 'PRECONDITION'
  /** それ以外（SDK エラー、スロットル、タイムアウト、想定外の例外） */
  | 'UNKNOWN';

export interface FailureClassification {
  disposition: FailureDisposition;
  kind: FailureKind;
}

/**
 * 例外の扱いを決める。
 *
 * 判定できない例外は **`RETRY` に寄せる**。技術的な失敗を取りこぼすと
 * 注文が `PENDING` のまま静かに消える（レコードは成功扱いでストリームから去る）。
 * 一方、業務的でない失敗を再試行しても、3 回で打ち切られて DLQ に落ちる
 * （design §5.6 / §E-4）。DLQ に入れば `ApproximateNumberOfMessagesVisible` の
 * アラーム（design §6.2）で気づける。**気づける失敗の方を選ぶ**。
 *
 * `INVALID_RECORD` だけを `SKIP` にする理由は `stream-record.ts` に書いたとおりで、
 * レコードの形が違う失敗は再試行しても同じ理由で失敗するだけである。
 * 業務的な失敗を再試行しないのと同じ構図であり、シャードを塞ぐ害だけが残る。
 */
export function classifyProcessingFailure(error: unknown): FailureClassification {
  if (error instanceof InvalidStreamRecordError) {
    return { disposition: 'SKIP', kind: 'INVALID_RECORD' };
  }
  if (isRetryableIdempotencyError(error)) {
    return { disposition: 'RETRY', kind: 'IDEMPOTENCY' };
  }
  if (error instanceof StagePreconditionError) {
    return { disposition: 'RETRY', kind: 'PRECONDITION' };
  }
  return { disposition: 'RETRY', kind: 'UNKNOWN' };
}
