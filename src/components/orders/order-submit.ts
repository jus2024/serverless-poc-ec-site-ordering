/**
 * 注文の送信結果を画面の文言に変換する（純粋関数。要件 4.2 / 4.5 / 6.5）。
 *
 * ## なぜフックから切り出すか
 *
 * `cart.ts` と同じ方針である。`use-order-submit.ts` は `createOrder` の呼び出しと
 * state を持つため単体テストの対象にできない（`vitest.config.ts` は
 * `environment: "node"`）。「何を読み上げるか」「明細の誤りをどう 1 行にまとめるか」
 * という判断だけをここに置き、テストで固定する（design §5）。
 *
 * ## 検証も失敗の分類もここでは行わない
 *
 * 明細の検証は `order-form.ts` の `buildOrderDraft`（`cart.ts` の
 * `buildCartOrderDraft` 経由）、API の失敗の言い換えは
 * `order-api-failure.ts` の `describeOrderApiFailure` が持つ（非機能 3）。
 * このモジュールは**すでに出ている判断を 1 行の日本語にまとめるだけ**である。
 */

import type { OrderDraftResult } from "./order-form";

/**
 * 明細の検証結果を 1 行の指摘にまとめる（要件 4.1 の送信前チェック）。
 *
 * カートの明細は行ごとの入力欄が数量しかなく、`buildOrderDraft` が返す
 * `lineIssues` を行に貼り付ける先が SKU 側には無い（商品はカードから追加するので
 * 選び直す入力欄が無い）。そのため行の指摘は文言を重複なしで並べて
 * カート全体の指摘として出す。同じ誤りが 10 行にあっても 1 回しか出さない。
 *
 * `formIssue`（明細数の上限）を先に置くのは、行ごとの誤りを直しても
 * 送信できない理由がそれだからである。
 *
 * @returns 送信を止める指摘。問題が無ければ null
 */
export function describeCartDraftIssue(draft: OrderDraftResult): string | null {
  if (draft.ok) {
    return null;
  }

  const messages: string[] = [];
  if (draft.formIssue !== null) {
    messages.push(draft.formIssue);
  }
  for (const issue of draft.lineIssues) {
    if (!messages.includes(issue.message)) {
      messages.push(issue.message);
    }
  }

  if (messages.length === 0) {
    // `buildOrderDraft` が指摘なしで ok=false を返した場合の保険。
    // 無言で送信を止めると操作が詰まったように見える
    return "注文の内容を確認してください。";
  }
  return messages.join(" ");
}

/** 読み上げる文言を決めるための状態（要件 6.5） */
export interface OrderSubmitStatusInput {
  /** 送信中（要件 4.6） */
  submitting: boolean;
  /** 送信前の検証で止めた理由。無ければ null */
  draftIssue: string | null;
  /** API の失敗の見出し（`FailureNotice.title`）。無ければ null */
  failureTitle: string | null;
  /** 受け付けられた注文 ID。無ければ null */
  acceptedOrderId: string | null;
}

/**
 * 注文の状況を 1 行で伝える（要件 6.5）。
 *
 * `role="status"` / `aria-live="polite"` の 1 箇所から成功も失敗も読み上げる
 * （既存パネルと同じ作法）。注文ボタンを押した検証者の focus は移動しないため、
 * ここが読み上げられなければ結果に気づけない。
 *
 * 優先順は 送信中 → 送信前の指摘 → API の失敗 → 受付済み。
 * 送信を試みた結果は必ず 1 つだけなので（フックが新しい試行のたびに前回を消す）、
 * 同時に複数が立つのは「受付済みの表示が残っている状態で次の送信を始めた」
 * ときだけである。その場合は新しい試行の状況を読ませる。
 *
 * @returns 読み上げる文言。伝えることが無ければ空文字（行の高さは CSS で保つ）
 */
export function describeOrderSubmitStatus(input: OrderSubmitStatusInput): string {
  if (input.submitting) {
    return "注文を送信しています…";
  }
  if (input.draftIssue !== null) {
    return `注文できません: ${input.draftIssue}`;
  }
  if (input.failureTitle !== null) {
    return `注文に失敗しました: ${input.failureTitle}`;
  }
  if (input.acceptedOrderId !== null) {
    return `注文 ${input.acceptedOrderId} を受け付けました。`;
  }
  return "";
}
