"use client";

/**
 * カートの内容で注文を送る（`POST /orders`。要件 4.1〜4.8）。
 *
 * ## なぜ `CartPanel` の中ではなくフックなのか
 *
 * 成功時にやることが 3 つある（要件 4.2 / 4.3 / 4.4）。受付結果を出す、
 * `orderId` を `OrderStatusPanel` に引き継ぐ、カートを空にする。後ろの 2 つは
 * カートの状態と `OrderStatusPanel` の配線を持つ側（`OrdersTabPanel`）
 * の仕事であり、表示専用の `CartPanel` からは触れない（`CartPanel` の注記）。
 * かといって送信の手順を `OrdersTabPanel` に直接書くと、注文タブの外枠が
 * API 呼び出しと state を抱える。`use-verification-config.ts` と同じ形で、
 * 送信の手順と結果の state をフックに閉じ、外枠は配線だけを持つ。
 *
 * ## `OrderSubmitPanel` から引き継ぐもの・落とすもの
 *
 * 引き継ぐ: `createOrder` の呼び出し、`describeOrderApiFailure` による失敗の言い換え、
 * 受付結果を最後の 1 件だけ保持すること。
 *
 * 落とす: 顧客 ID の指定（要件 4.7。API のテスト顧客の自動割り当てに委ねる）と
 * ランダム生成の分岐（要件 4.8）。**リクエストは常に `items` だけを送る。**
 * 分岐が無いので、明細の検証を飛ばす経路も無い。
 *
 * ## 送信中の `POST` は中断しない
 *
 * `getCatalog` のような読み取りは新しい取得で打ち切ってよいが（`AbortController`）、
 * `POST /orders` を中断しても API 側の受付は取り消せず、返ってくるはずだった
 * 注文番号だけを失う。追跡できない注文を作らないため、中断はしない。
 * アンマウント後の state 更新（と `onOrderAccepted`）だけを止める。
 * 注文タブは非アクティブでも `hidden` でマウントされたままなので
 * （`OrderDashboard` の注記）、実際にここへ来るのはページ離脱時である。
 *
 * ## 二重送信を state ではなく ref で止める
 *
 * `submitting` の state は次の描画までしか効かない。ボタンは無効化しているが
 * （要件 4.6）、Enter の連打で同じフレームに 2 回入る余地があるため、
 * 進行中の判定は ref で持つ。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { createOrder } from "@/src/lib/orders/api";
import type { CatalogProductView, CreateOrderResponse } from "@/src/lib/orders/types";

import { buildCartOrderDraft, type CartLine } from "./cart";
import { describeOrderApiFailure, type FailureNotice } from "./order-api-failure";
import { describeCartDraftIssue, describeOrderSubmitStatus } from "./order-submit";

/** 注文の送信状態。`OrderSubmitOutcome` がそのまま描く */
export interface OrderSubmitState {
  /** 送信中（要件 4.6）。`CartPanel` の `submitting` に渡す */
  submitting: boolean;
  /** 受け付けられた注文。最後の 1 件だけ（要件 4.2） */
  result: CreateOrderResponse | null;
  /** API の失敗の案内（要件 4.5） */
  failure: FailureNotice | null;
  /** 送信前の検証で止めた理由（要件 3.8 / 4.1） */
  draftIssue: string | null;
  /** `role="status"` で読み上げる 1 行（要件 6.5） */
  statusMessage: string;
  /** 「この内容で注文する」の実装。`CartPanel` の `onSubmitOrder` に渡す */
  submitOrder: () => void;
}

export interface UseOrderSubmitOptions {
  /** カートの明細。状態の持ち主は呼び出し側 */
  lines: readonly CartLine[];
  /** 商品マスタ。単価の出典（`buildOrderDraft` に渡す） */
  products: readonly CatalogProductView[];
  /**
   * 注文が受け付けられたときに呼ぶ。
   *
   * 呼び出し側で `orderId` を `OrderStatusPanel` に引き継ぎ（要件 4.3）、
   * カートを空にする（要件 4.4）。どちらもカートの状態を持つ側でしか
   * できないため、このフックは通知するだけである。失敗時は呼ばない
   * （カートを保持する。要件 4.5）。
   */
  onOrderAccepted?: (response: CreateOrderResponse) => void;
}

export function useOrderSubmit({
  lines,
  products,
  onOrderAccepted,
}: UseOrderSubmitOptions): OrderSubmitState {
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateOrderResponse | null>(null);
  const [failure, setFailure] = useState<FailureNotice | null>(null);
  const [draftIssue, setDraftIssue] = useState<string | null>(null);

  const submittingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const submitOrder = useCallback(() => {
    if (submittingRef.current) {
      return;
    }

    /*
     * 前回の結果はここで消す。受付済みの表示を残したまま次の送信を始めると、
     * 「今の注文が通ったのか、前の注文の表示なのか」が読めなくなる。
     * 引き継いだ注文 ID は `OrderStatusPanel` 側が保持しているので、
     * 表示を消しても直前の注文を追跡できなくなることはない。
     */
    setResult(null);
    setFailure(null);

    // 変換 + 既存の明細検証（要件 3.7 / 4.1）。判断は `buildOrderDraft` に委ねる
    const draft = buildCartOrderDraft(lines, products);
    const issue = describeCartDraftIssue(draft);
    setDraftIssue(issue);
    if (!draft.ok) {
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);

    // 顧客 ID は指定しない（要件 4.7）。ランダム生成の分岐も持たない（要件 4.8）
    void createOrder({ items: draft.items })
      .then((response) => {
        if (!mountedRef.current) {
          return;
        }
        setResult(response);
        onOrderAccepted?.(response);
      })
      .catch((error: unknown) => {
        if (!mountedRef.current) {
          return;
        }
        // カートは触らない（要件 4.5）。同じ内容でそのまま再試行できる
        setFailure(describeOrderApiFailure(error, "createOrder"));
      })
      .finally(() => {
        submittingRef.current = false;
        if (mountedRef.current) {
          setSubmitting(false);
        }
      });
  }, [lines, products, onOrderAccepted]);

  const statusMessage = describeOrderSubmitStatus({
    submitting,
    draftIssue,
    failureTitle: failure === null ? null : failure.title,
    acceptedOrderId: result === null ? null : result.orderId,
  });

  return { submitting, result, failure, draftIssue, statusMessage, submitOrder };
}
