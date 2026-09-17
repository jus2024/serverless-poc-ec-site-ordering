"use client";

/**
 * カートの明細・合計・注文操作（要件 3.3 / 3.4 / 3.5 / 3.6 / 6.4）。
 *
 * ## カートの状態を持たない
 *
 * `ProductGrid` が商品マスタを自分で取らないのと同じ理由である。カートの状態は
 * 親（`OrdersTabPanel`）が持ち（design §2.1）、ここは受け取った明細を並べて
 * 編集操作を親に返すだけである。「カートに追加」は `ProductGrid` 側の
 * `ProductCard` にあり、数量変更と削除はここにある。状態が両方の下にあると
 * 「同じ SKU は数量を加算する」（要件 3.2）の判断が散る。判断は `cart.ts` の
 * 純粋関数に 1 箇所で閉じてある。
 *
 * ## 注文の送信もここでは行わない
 *
 * 送信（`createOrder`）と結果表示は親側（`useOrderSubmit`）に置き、ここは
 * props を受けるだけにしている（`onSubmitOrder` / `submitting` / `children`）。
 * 成功時にカートを空にする（要件 4.4）のはカートの状態を持つ側の仕事であり、
 * `orderId` を `OrderStatusPanel` へ渡す（要件 4.3）のも親の配線である。
 * この 2 つを満たすには結局カートの状態を持つ側が送信を握るしかないため、
 * ここは API を知らない表示部品のままにしておく。**ここが持つのは
 * 注文ボタンの活性/非活性（要件 3.6）までである。**
 *
 * ## 数量は直接入力（design §7 論点 3）
 *
 * ± ボタンではなく入力欄にする。既存の数量入力（`OrderSubmitPanel` の明細）と
 * 同じ作法で、`text` + `inputMode="numeric"` である。`type="number"` は
 * スピナーの見た目がブラウザ差になり、`min` / `max` の扱いも実装依存なので使わない。
 *
 * 入力途中の生の文字列（`qtyDraft`）だけはローカル state に置く。カートの
 * 状態は `CartLine { qty: number }`（design §2.3）なので、「空欄」や「2個」の
 * ような途中の値を親に上げる先がない。読める値になった時点で親に反映し、
 * フォーカスが外れたら確定済みの数量に戻す。`ProductGrid` が絞り込みの選択だけを
 * ローカルに持つのと同じ切り分けである（見え方はここ、注文に効く値は親）。
 *
 * ## 上限超過は止めずに見せる（要件 3.8）
 *
 * 上限（`MAX_ITEM_QTY`）を超えた数量もカートには入る（`setCartLineQty` /
 * `readCartQtyInput` の設計）。黙って丸めると入力した数量と表示が食い違うため、
 * 行の指摘（`parseQtyInput` の文言）とカート全体の警告（`hasQtyOverMax`）で
 * 送信前に気づけるようにする。送信の可否そのものは `buildOrderDraft` が
 * 判断する（`useOrderSubmit`）。画面側で二重に弾かない。
 *
 * ## キーボードだけで操作できる（要件 6.4）
 *
 * 数量はネイティブの `input`、削除と注文は `button` である。読み上げ用のラベルには
 * 商品名を含める。明細が並ぶと見た目上のラベルはすべて「数量」「削除」で同じになり、
 * 支援技術の一覧から選ぶときに区別できないためである。
 */

import { useState, type ReactNode } from "react";

import type { CatalogProductView } from "@/src/lib/orders/types";

import {
  cartLineDraftId,
  readCartQtyInput,
  summarizeCart,
  type CartLine,
} from "./cart";
import { MAX_ITEM_QTY, parseQtyInput } from "./order-form";
import { EMPTY_VALUE, formatCount, formatJpy } from "./order-progress";
import styles from "./orders.module.css";
import SummaryItem from "./SummaryItem";

/** 入力途中の数量。同時に編集できる欄は 1 つなので 1 件だけ持つ */
interface QtyDraft {
  sku: string;
  raw: string;
}

interface CartPanelProps {
  /** カートの明細。状態は親が持つ */
  lines: readonly CartLine[];
  /** 商品マスタ。商品名・単価の出典（要件 3.5） */
  products: readonly CatalogProductView[];
  /** `GET /catalog` のポイント付与率。未取得なら null */
  pointRate: number | null;
  /** 数量の変更（要件 3.3）。読める値になった時点で呼ぶ */
  onChangeQty: (sku: string, qty: number) => void;
  /** 明細の削除（要件 3.4） */
  onRemove: (sku: string) => void;
  /** 「この内容で注文する」。送信の実装は `useOrderSubmit`（要件 4.1） */
  onSubmitOrder: () => void;
  /** 送信中は操作を無効化する（要件 4.6）。`useOrderSubmit` が立てる */
  submitting?: boolean;
  /** 注文の結果表示（受付結果・失敗の案内）を差し込む枠 */
  children?: ReactNode;
}

export default function CartPanel({
  lines,
  products,
  pointRate,
  onChangeQty,
  onRemove,
  onSubmitOrder,
  submitting = false,
  children,
}: CartPanelProps) {
  const [qtyDraft, setQtyDraft] = useState<QtyDraft | null>(null);

  const summary = summarizeCart(lines, products, pointRate);
  const empty = summary.lineCount === 0;
  // 送信中はカートを触らせない（送った内容と画面が食い違わないようにする。要件 4.6）
  const editDisabled = submitting;

  function handleQtyChange(sku: string, raw: string) {
    setQtyDraft({ sku, raw });
    const qty = readCartQtyInput(raw);
    if (qty !== null) {
      onChangeQty(sku, qty);
    }
  }

  /*
   * フォーカスが外れたら生の値を捨て、確定済みの数量に戻す。
   * 空欄のまま離れた入力欄が残ると、カートの合計と画面の数量が食い違う。
   */
  function handleQtyBlur() {
    setQtyDraft(null);
  }

  const pointValue =
    summary.pointEarned === null ? EMPTY_VALUE : `${formatCount(summary.pointEarned)} pt`;

  /*
   * 「カートに追加」を押した先はこのパネルなので、追加できたことを読み上げで返す
   * （ボタンは `ProductGrid` 側にあり、視線の外で件数が増える）。要件 6.5 の
   * 既存パターン（`role="status"` / `aria-live="polite"`）に載せる。
   */
  const statusMessage = empty
    ? "カートは空です。"
    : `カートに ${formatCount(summary.lineCount)} 種類 / ${formatCount(summary.totalQty)} 点、合計 ${formatJpy(summary.totalAmount)}`;

  return (
    <section className="card" aria-labelledby="cart-heading">
      <h2 id="cart-heading" className={styles.sectionTitle}>
        カート
      </h2>
      <p className={styles.sectionDescription}>
        数量を変えると合計金額と獲得予定ポイントが再計算される。
      </p>

      <p className={styles.statusLine} role="status" aria-live="polite">
        {statusMessage}
      </p>

      {empty ? (
        <p className={styles.fieldHint}>
          商品を選んで「カートに追加」すると、ここに明細が並ぶ。
        </p>
      ) : (
        /* リストにするのは、支援技術に何件の明細があるかを伝えるためである */
        <ul className={styles.cart}>
          {summary.lines.map((line) => {
            // 商品マスタから引けなかった場合でも行を識別できるよう SKU を出す
            const displayName = line.name ?? line.sku;
            const inputId = `${cartLineDraftId(line.sku)}-qty`;
            const issueId = `${inputId}-error`;
            const rawQty =
              qtyDraft !== null && qtyDraft.sku === line.sku ? qtyDraft.raw : String(line.qty);
            // 入力途中の値・上限超過の指摘はどちらも既存の文言を使う（要件 3.8）
            const parsed = parseQtyInput(rawQty);
            const qtyIssue = parsed.ok ? null : parsed.issue;

            return (
              <li key={line.sku} className={styles.cartLine}>
                <div className={styles.cartLineMain}>
                  <p className={styles.cartLineName}>{displayName}</p>
                  <p className={styles.cartLineUnit}>
                    <span className={styles.srOnly}>単価 </span>
                    {formatJpy(line.price)}
                    <span className={styles.cartLineUnitNote}>（税込）</span>
                  </p>
                </div>

                <div className={styles.cartLineQty}>
                  {/*
                    見える文字は「数量」だけにして、読み上げ名は aria-label で
                    商品名込みにする（label は残すので、クリックで入力欄に入れる）。
                  */}
                  <label className={styles.fieldLabel} htmlFor={inputId}>
                    数量
                  </label>
                  <input
                    id={inputId}
                    className={`input ${styles.qtyInput}`}
                    type="text"
                    inputMode="numeric"
                    value={rawQty}
                    onChange={(event) => handleQtyChange(line.sku, event.target.value)}
                    onBlur={handleQtyBlur}
                    disabled={editDisabled}
                    aria-label={`${displayName} の数量`}
                    aria-describedby={qtyIssue === null ? undefined : issueId}
                    aria-invalid={qtyIssue !== null}
                  />
                </div>

                <p className={styles.cartLineSubtotal}>
                  <span className={styles.srOnly}>小計 </span>
                  {formatJpy(line.subtotal)}
                </p>

                <div className={styles.cartLineAction}>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => onRemove(line.sku)}
                    disabled={editDisabled}
                    aria-label={`${displayName} をカートから削除`}
                  >
                    削除
                  </button>
                </div>

                {qtyIssue !== null && (
                  <p id={issueId} className={`${styles.fieldError} ${styles.cartLineIssue}`}>
                    {qtyIssue}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {summary.hasUnknownSku && (
        <p className={styles.warningNote}>
          商品マスタから単価を引けない明細がある。合計金額には含めていない。
          商品を選び直すか、商品マスタを再読み込みしてほしい。
        </p>
      )}

      {summary.hasQtyOverMax && (
        <p className={styles.warningNote}>
          数量が上限（{formatCount(MAX_ITEM_QTY)}）を超えている明細がある。
          このままでは注文できない。
        </p>
      )}

      <dl className={styles.summaryGrid}>
        <SummaryItem label="明細数" value={`${formatCount(summary.lineCount)} 種類`} />
        <SummaryItem label="数量の合計" value={`${formatCount(summary.totalQty)} 点`} />
        <SummaryItem label="合計金額（税込）" value={formatJpy(summary.totalAmount)} />
        <SummaryItem label="獲得予定ポイント" value={pointValue} />
      </dl>

      <p className={styles.fieldHint}>
        獲得予定ポイントは概算である。確定値は注文後のポイント付与で決まる。
      </p>

      <div className={styles.actions}>
        {/* 空のカートでは注文させない（要件 3.6）。送信中も無効（要件 4.6） */}
        <button
          type="button"
          className="btn-primary"
          onClick={onSubmitOrder}
          disabled={empty || submitting}
        >
          {submitting ? "注文中…" : "この内容で注文する"}
        </button>
      </div>

      {/* 注文の結果表示（`OrderSubmitOutcome`）は親がここに差し込む */}
      {children}
    </section>
  );
}
