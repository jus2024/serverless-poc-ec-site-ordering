"use client";

/**
 * 商品 1 件のカード（要件 2.2 / 2.3 / 2.8 / 6.2）。
 *
 * ## 何を出すか
 *
 * 商品名・産地・焙煎度・容量・価格と「カートに追加」（要件 2.2 / 2.8）、
 * および商品画像の代わりのプレースホルダ（産地に応じた色 + 豆アイコン。要件 2.3）。
 *
 * 産地・焙煎度・容量は商品マスタ（`GET /catalog`）の `origin` / `roast` / `size` を
 * そのまま出す。**SKU 文字列を切り出して属性を復元しない**（案 Y の目的。要件 1 の背景）。
 *
 * ## カートの状態を持たない
 *
 * 追加は `onAddToCart` を呼ぶだけで、カートの状態は親（`OrdersTabPanel`）が持つ
 * （design §2.1）。240 件のカードがそれぞれカートを触ると、
 * 「同じ SKU は数量を加算する」（要件 3.2）の判断がカードの数だけ散る。
 * 判断は `cart.ts` の純粋関数に 1 箇所で閉じてある。
 *
 * ## キーボードだけで追加できる（要件 6.4）
 *
 * 追加はネイティブの `button` である。`div` + `onClick` にすると Tab で到達できず、
 * Enter / Space も効かない。読み上げ用のラベルには商品名を含める。
 * 240 件のカードの見た目上のラベルはすべて「カートに追加」で同じであり、
 * 支援技術のボタン一覧から選ぶときに区別できないためである。
 */

import type { CatalogProductView } from "@/src/lib/orders/types";

import { formatJpy } from "./order-progress";
import styles from "./orders.module.css";
import { originCountry } from "./product-filter";
import { cssVarRef, pickProductThumbTone } from "./product-visual";

interface ProductCardProps {
  product: CatalogProductView;
  /** 「カートに追加」を押したときに呼ばれる。SKU だけを渡す（数量は 1 固定） */
  onAddToCart: (sku: string) => void;
  /** 追加を無効化する（注文の送信中など。要件 4.6） */
  disabled?: boolean;
}

export default function ProductCard({
  product,
  onAddToCart,
  disabled = false,
}: ProductCardProps) {
  const tone = pickProductThumbTone(product.origin);

  /*
   * 配色は CSS 変数としてカード側に載せ、実際の描画は `orders.module.css` に任せる。
   * トークン名（`--color-brand` 等）以外の色情報を TSX に持ち込まない（要件 6.2）。
   */
  const toneStyle = {
    "--product-thumb-bg": cssVarRef(tone.background),
    "--product-thumb-fg": cssVarRef(tone.foreground),
  } as React.CSSProperties;

  return (
    <article className={styles.productCard}>
      {/*
        プレースホルダは装飾であり、商品名・産地は下のテキストで読める。
        `aria-hidden` にして、意味を持たない画像を読み上げさせない。
      */}
      <div className={styles.productThumb} style={toneStyle} aria-hidden="true">
        <svg className={styles.productThumbIcon} viewBox="0 0 48 48" focusable="false">
          <ellipse
            cx="24"
            cy="24"
            rx="13"
            ry="19"
            transform="rotate(-28 24 24)"
            className={styles.productThumbBean}
          />
          <path
            d="M24 6.5c-5 8 5 16 0 35"
            transform="rotate(-28 24 24)"
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            className={styles.productThumbCrease}
          />
        </svg>
      </div>

      <h3 className={styles.productName}>{product.name}</h3>

      {/* 属性はラベルと値の対応が要るので dl で組む（値だけでは意味が通らない） */}
      <dl className={styles.productAttrs}>
        <div className={styles.productAttr}>
          <dt className={styles.productAttrLabel}>産地</dt>
          {/* 産地欄は国名だけ（商品名にフル表記が出るため冗長を避ける）。SKU は解釈しない */}
          <dd className={styles.productAttrValue}>{originCountry(product.origin)}</dd>
        </div>
        <div className={styles.productAttr}>
          <dt className={styles.productAttrLabel}>焙煎度</dt>
          <dd className={styles.productAttrValue}>{product.roast}</dd>
        </div>
        <div className={styles.productAttr}>
          <dt className={styles.productAttrLabel}>容量</dt>
          <dd className={styles.productAttrValue}>{product.size}</dd>
        </div>
      </dl>

      <p className={styles.productPrice}>
        <span className={styles.srOnly}>価格 </span>
        {formatJpy(product.price)}
        <span className={styles.productPriceNote}>（税込）</span>
      </p>

      <button
        type="button"
        className={`btn-primary ${styles.productAddButton}`}
        onClick={() => onAddToCart(product.sku)}
        disabled={disabled}
        aria-label={`${product.name} をカートに追加`}
      >
        カートに追加
      </button>
    </article>
  );
}
