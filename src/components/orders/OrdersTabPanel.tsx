"use client";

/**
 * 「注文」タブ（購買導線。design §2.1 / 要件 2.1 / 4.3 / 6.6）。
 *
 * ```
 * OrdersTabPanel（商品マスタの取得とカート状態を持つ）
 * └── .ordersLayout（2 カラム。狭幅では縦積みに戻す）
 *     ├── ProductGrid       … 左カラム: 商品グリッド + 産地絞り込み
 *     └── .ordersRail        … 右カラム（sticky でスクロール追従）
 *         ├── CartPanel      … カート（結果表示は children に OrderSubmitOutcome）
 *         └── OrderStatusPanel … 既存を再利用（注文後の状況表示）
 * ```
 *
 * ## 見た目は 2 カラム、DOM 順は据え置き
 *
 * 左に商品グリッド、右にカート＋注文照会を置き、右ペインは sticky で
 * スクロールに追従させる（`.ordersRail`）。ただし DOM 順は
 * 商品グリッド → カート → 注文照会 のままにして、読み上げ順とタブ順を
 * 崩さない。左右の配置は `orders.module.css` の grid が与える。
 * 幅が狭いとき（タブレット以下）は 1 カラム（縦積み）に戻し sticky も解く。
 *
 * ## ここが持つのは「配線」と「カートの状態」だけ
 *
 * 商品マスタの取得手順は `useCatalog`、注文の送信手順は `useOrderSubmit`、
 * カートの状態遷移と集計は `cart.ts` の純粋関数にある。この外枠に残るのは
 * それらを繋ぐことと、カートの明細（`CartLine[]`）と追跡中の注文 ID を
 * 保持することである。子（`ProductGrid` / `CartPanel`）はどちらも表示専用で、
 * 状態を持たない（絞り込みの選択と数量の入力途中だけは見え方の都合で子に置く）。
 *
 * カートの状態をここに置くのは、「カートに追加」が `ProductGrid` 側、
 * 数量変更と削除が `CartPanel` 側にあるためである。状態が両方の下にあると
 * 「同じ SKU は数量を加算する」（要件 3.2）の判断が散る（`CartPanel` の注記）。
 *
 * ## 注文成功時にやることが 3 つある
 *
 * 受付結果を出す（`OrderSubmitOutcome`。要件 4.2）、`orderId` を
 * `OrderStatusPanel` へ引き継ぐ（要件 4.3）、カートを空にする（要件 4.4）。
 * 1 つ目は `useOrderSubmit` が state で持ち、後ろ 2 つはここでしかできない
 * ので `onOrderAccepted` で受ける。**`orderId` を `OrderStatusPanel` に渡す
 * 既存の連携（`trackedOrderId`）はそのまま使う。** 追跡するのは
 * 「最後に受け付けられた注文」だけで履歴は持たない（旧実装と同じ）。
 *
 * ## 検証用の操作はこのタブに置かない
 *
 * 顧客 ID の指定とランダム生成は削除した（要件 4.7 / 4.8。`useOrderSubmit`）。
 * 初期在庫の投入は設定タブへ移した（要件 5.1。`InventorySeedPanel` / `SettingsTabPanel`）。
 * このタブは顧客の購買導線だけを持ち、API 操作コンソールの性格を残さない。
 */

import { useCallback, useState } from "react";

import type { CreateOrderResponse } from "@/src/lib/orders/types";

import CartPanel from "./CartPanel";
import OrderStatusPanel from "./OrderStatusPanel";
import OrderSubmitOutcome from "./OrderSubmitOutcome";
import ProductGrid from "./ProductGrid";
import { addCartLine, removeCartLine, setCartLineQty, type CartLine } from "./cart";
import styles from "./orders.module.css";
import { useCatalog } from "./use-catalog";
import { useOrderSubmit } from "./use-order-submit";

export default function OrdersTabPanel() {
  const catalog = useCatalog();

  const [lines, setLines] = useState<CartLine[]>([]);
  const [createdOrderId, setCreatedOrderId] = useState<string | null>(null);

  /*
   * 受付できたら注文 ID を照会側へ渡し（要件 4.3）、カートを空にする（要件 4.4）。
   * 失敗時は呼ばれないので、カートはそのまま残る（要件 4.5）。
   */
  const handleOrderAccepted = useCallback((response: CreateOrderResponse) => {
    setCreatedOrderId(response.orderId);
    setLines([]);
  }, []);

  const submit = useOrderSubmit({
    lines,
    products: catalog.products,
    onOrderAccepted: handleOrderAccepted,
  });

  const handleAddToCart = useCallback((sku: string) => {
    setLines((current) => addCartLine(current, sku));
  }, []);

  const handleChangeQty = useCallback((sku: string, qty: number) => {
    setLines((current) => setCartLineQty(current, sku, qty));
  }, []);

  const handleRemove = useCallback((sku: string) => {
    setLines((current) => removeCartLine(current, sku));
  }, []);

  /*
   * 2 カラム（左：商品グリッド / 右：カート＋注文照会）。DOM 順は
   * 商品グリッド → カート → 注文照会 のままにして、読み上げ順・タブ順を
   * 崩さない（視覚的な左右の配置は CSS の grid で与える）。狭い画面では
   * `orders.module.css` の `.ordersLayout` が 1 カラム（縦積み）に戻す。
   */
  return (
    <div className={styles.ordersLayout}>
      <ProductGrid
        products={catalog.products}
        loading={catalog.state === "loading"}
        failure={catalog.failure}
        onRetry={catalog.reload}
        onAddToCart={handleAddToCart}
        // 送信中はカートを触らせない（送った内容と画面が食い違わないようにする。要件 4.6）
        addToCartDisabled={submit.submitting}
      />

      {/* 右カラム。sticky でスクロールに追従する（`.ordersRail`） */}
      <div className={styles.ordersRail}>
        <CartPanel
          lines={lines}
          products={catalog.products}
          pointRate={catalog.pointRate}
          onChangeQty={handleChangeQty}
          onRemove={handleRemove}
          onSubmitOrder={submit.submitOrder}
          submitting={submit.submitting}
        >
          <OrderSubmitOutcome submit={submit} />
        </CartPanel>

        <OrderStatusPanel trackedOrderId={createdOrderId} />
      </div>
    </div>
  );
}
