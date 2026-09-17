"use client";

/**
 * 商品グリッドと産地の絞り込み（要件 2.1 / 2.4 / 2.5 / 2.6 / 2.7）。
 *
 * ## 商品マスタを自分で取らない
 *
 * `getCatalog` の呼び出しは親（`OrdersTabPanel`）が持つ（design §2.1）。
 * ここは受け取った `products` を絞って並べるだけである。カート（`CartPanel`）も
 * 同じ商品マスタから単価とポイント率を引くため、取得をこのコンポーネントに
 * 持たせると同じ `GET /catalog` を 2 箇所から呼ぶことになり、
 * 「グリッドとカートで単価が違う」状態が起こりうる。取得は 1 箇所に閉じる。
 *
 * そのため読み込み中（要件 2.7）と失敗（要件 2.6）も props で受け取る。
 * 失敗の整形は `describeOrderApiFailure`、表示は `FailureAlert` を再利用し、
 * 案内文をこの画面で作り直さない（非機能 3）。再取得は `onRetry` を親に返すだけで、
 * 再取得の手順（AbortController の扱いなど）も親の 1 箇所に残る。
 *
 * ## 絞り込みの選択だけはローカル state
 *
 * 選んだ産地は表示の都合であり、注文にもカートにも影響しない。親に上げると
 * 注文タブの state に「見え方」の関心事が混ざる。絞り込みのロジック自体は
 * `product-filter.ts` の純粋関数（テスト済み）に置き、ここは選択状態の保持と
 * 描画だけを持つ。
 *
 * ## 商品マスタを再取得して産地が消えた場合
 *
 * 選択中の産地が新しい商品マスタに無いとき、`filterProductsByOrigin` は
 * 全件を返す（0 件の画面で操作が詰まらないようにするため）。それに合わせて
 * セレクトの表示も「すべて」に戻す（`selectedValue`）。state を書き換える
 * `useEffect` を置かずに描画時に解決しているのは、商品マスタの入れ替えと
 * 選択の補正が別のレンダリングに分かれて一瞬だけ食い違うのを避けるためである。
 */

import { useState } from "react";

import type { CatalogProductView } from "@/src/lib/orders/types";

import FailureAlert from "./FailureAlert";
import type { FailureNotice } from "./order-api-failure";
import { formatCount } from "./order-progress";
import styles from "./orders.module.css";
import ProductCard from "./ProductCard";
import {
  ORIGIN_FILTER_ALL,
  buildOriginFilterOptions,
  filterProductsByOrigin,
  sortProductsForDisplay,
  type OriginFilter,
} from "./product-filter";

interface ProductGridProps {
  /** 表示する商品マスタ。取得は親が行う */
  products: readonly CatalogProductView[];
  /** 商品マスタの読み込み中（要件 2.7） */
  loading: boolean;
  /** 商品マスタの取得に失敗したときの案内。無ければ null（要件 2.6） */
  failure: FailureNotice | null;
  /** 商品マスタの再取得（要件 2.6） */
  onRetry: () => void;
  /** 「カートに追加」。SKU だけを渡す（数量は 1 固定。要件 2.8 / 3.1） */
  onAddToCart: (sku: string) => void;
  /** 追加を無効化する（注文の送信中など。要件 4.6） */
  addToCartDisabled?: boolean;
}

export default function ProductGrid({
  products,
  loading,
  failure,
  onRetry,
  onAddToCart,
  addToCartDisabled = false,
}: ProductGridProps) {
  const [originFilter, setOriginFilter] = useState<OriginFilter>(ORIGIN_FILTER_ALL);

  const options = buildOriginFilterOptions(products);
  // 選択中の産地が今の商品マスタに無ければ「すべて」として扱う（上のコメント参照）
  const selectedValue = options.some((option) => option.value === originFilter)
    ? originFilter
    : ORIGIN_FILTER_ALL;
  // 絞り込んでから「容量→焙煎度→産地」に並べ替える（表示専用）。同一容量・同一焙煎度の
  // 中で全産地が連続するため、横一列（約 4 列）ごとに産地＝色が変わる（product-visual.ts）。
  const visibleProducts = sortProductsForDisplay(filterProductsByOrigin(products, selectedValue));

  const filtered = selectedValue !== ORIGIN_FILTER_ALL;
  const canFilter = !loading && options.length > 1;

  /*
   * 読み込み中・失敗・件数を 1 行に集約する。要件 2.6 / 2.7 の「読み込み中である
   * ことを示す」「エラーを表示する」を視覚と読み上げの両方で満たすため、
   * 既存パターン（`role="status"` / `aria-live="polite"`）に載せる（要件 6.5）。
   * 失敗の詳細は下の `FailureAlert` が出すので、ここでは見出しだけを読ませる。
   */
  const statusMessage = loading
    ? "商品を読み込んでいます…"
    : failure !== null
      ? `商品の取得に失敗しました: ${failure.title}`
      : products.length === 0
        ? "表示できる商品がありません。"
        : filtered
          ? `${selectedValue} の商品 ${formatCount(visibleProducts.length)} 件を表示中（全 ${formatCount(products.length)} 件）`
          : `商品 ${formatCount(products.length)} 件を表示中`;

  return (
    <section className="card" aria-labelledby="product-grid-heading">
      <h2 id="product-grid-heading" className={styles.sectionTitle}>
        商品を選ぶ
      </h2>
      <p className={styles.sectionDescription}>
        産地で絞り込んで、カートに追加する。
      </p>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="product-origin-filter">
          産地で絞り込む
        </label>
        <select
          id="product-origin-filter"
          className={`input ${styles.select}`}
          value={selectedValue}
          onChange={(event) => setOriginFilter(event.target.value)}
          disabled={!canFilter}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}（{formatCount(option.count)} 件）
            </option>
          ))}
        </select>
      </div>

      <p className={styles.statusLine} role="status" aria-live="polite">
        {statusMessage}
      </p>

      {failure !== null && <FailureAlert notice={failure} onRetry={onRetry} />}

      {visibleProducts.length > 0 && (
        /*
         * リストにするのは、支援技術に「何件並んでいるか」を伝えるためである
         * （240 件のカードが地の文として続くと、どこまでが一覧か分からない）。
         */
        <ul className={styles.productGrid}>
          {visibleProducts.map((product) => (
            <li key={product.sku} className={styles.productGridItem}>
              <ProductCard
                product={product}
                onAddToCart={onAddToCart}
                disabled={addToCartDisabled}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
