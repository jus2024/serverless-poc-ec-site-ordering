/**
 * Kiro Roasters の商品マスタ（検証用の縮小版）。
 *
 * 実際の EC は約 3,000 SKU を扱うが、検証で必要なのは
 * 「注文データが業務コンテキストと整合している」ことだけなので、
 * 産地 × 焙煎度 × 容量の組み合わせから SKU を生成する方式にしている（FR-7.3）。
 *
 * SKU 形式は docs/poc/kiro-roasters-background.md の命名規則に従う:
 *   ITEM#{産地略}-{品種略}-{グレード}-{焙煎度}-{容量}
 */

import type { OrderItem } from './types.js';

/** 産地・品種・グレードの組み合わせ */
const ORIGINS = [
  { code: 'ETH', variety: 'YIRG', grade: 'G1', name: 'エチオピア イルガチェフェ G1', basePrice: 1800 },
  { code: 'ETH', variety: 'SIDA', grade: 'G2', name: 'エチオピア シダモ G2', basePrice: 1500 },
  { code: 'BRA', variety: 'SANT', grade: 'NY2', name: 'ブラジル サントス NY2', basePrice: 1200 },
  { code: 'BRA', variety: 'CERR', grade: 'SP', name: 'ブラジル セラード スペシャルティ', basePrice: 1600 },
  { code: 'COL', variety: 'SUPR', grade: 'EP', name: 'コロンビア スプレモ EP', basePrice: 1400 },
  { code: 'GTM', variety: 'ANTI', grade: 'SHB', name: 'グアテマラ アンティグア SHB', basePrice: 1700 },
  { code: 'KEN', variety: 'NYER', grade: 'AA', name: 'ケニア ニエリ AA', basePrice: 2000 },
  { code: 'IDN', variety: 'MAND', grade: 'G1', name: 'インドネシア マンデリン G1', basePrice: 1900 },
  { code: 'CRI', variety: 'TARR', grade: 'SHB', name: 'コスタリカ タラス SHB', basePrice: 1800 },
  { code: 'PAN', variety: 'GESH', grade: 'SP', name: 'パナマ ゲイシャ スペシャルティ', basePrice: 4800 },
] as const;

/** 焙煎度 */
const ROASTS = [
  { code: 'LIGHT', name: 'ライト' },
  { code: 'MEDIUM', name: 'ミディアム' },
  { code: 'CITY', name: 'シティ' },
  { code: 'FULLCITY', name: 'フルシティ' },
  { code: 'FRENCH', name: 'フレンチ' },
  { code: 'ITALIAN', name: 'イタリアン' },
] as const;

/** 容量（EC 向けは 5kg 業務用を除く） */
const SIZES = [
  { code: '100G', name: '100g', priceFactor: 0.6 },
  { code: '200G', name: '200g', priceFactor: 1.0 },
  { code: '500G', name: '500g', priceFactor: 2.3 },
  { code: '1KG', name: '1kg', priceFactor: 4.2 },
] as const;

export interface CatalogProduct {
  sku: string;
  name: string;
  /** 税込単価 */
  price: number;
}

/**
 * 商品マスタを生成する。
 * 10 産地 × 6 焙煎度 × 4 容量 = 240 SKU。
 */
function buildCatalog(): CatalogProduct[] {
  const products: CatalogProduct[] = [];
  for (const origin of ORIGINS) {
    for (const roast of ROASTS) {
      for (const size of SIZES) {
        const sku = `ITEM#${origin.code}-${origin.variety}-${origin.grade}-${roast.code}-${size.code}`;
        // 100 円単位に丸める（表示上の見栄えのため）
        const price = Math.round((origin.basePrice * size.priceFactor) / 100) * 100;
        products.push({
          sku,
          name: `${origin.name} ${roast.name} ${size.name}`,
          price,
        });
      }
    }
  }
  return products;
}

/** 商品マスタ（モジュール読み込み時に 1 度だけ生成） */
export const CATALOG: readonly CatalogProduct[] = buildCatalog();

/** SKU から商品を引く */
const CATALOG_BY_SKU = new Map(CATALOG.map((product) => [product.sku, product]));

export function findProduct(sku: string): CatalogProduct | undefined {
  return CATALOG_BY_SKU.get(sku);
}

/** ポイント付与率（購入金額の 1%） */
export const POINT_RATE = 0.01;

/** 付与ポイントを計算する（円未満切り捨て） */
export function calculatePoints(totalAmount: number): number {
  return Math.floor(totalAmount * POINT_RATE);
}

/**
 * ランダムな注文明細を生成する（負荷テスト・手動投入のデフォルト）。
 *
 * 1 注文あたり 1〜3 品目、各 1〜2 個。EC のサブスク会員の
 * 実際の注文サイズ（少量多品目）に寄せている。
 */
export function randomOrderItems(): OrderItem[] {
  const itemCount = 1 + Math.floor(Math.random() * 3);
  const picked = new Set<string>();
  const items: OrderItem[] = [];

  while (items.length < itemCount) {
    const product = CATALOG[Math.floor(Math.random() * CATALOG.length)];
    if (picked.has(product.sku)) continue;
    picked.add(product.sku);
    items.push({
      sku: product.sku,
      qty: 1 + Math.floor(Math.random() * 2),
      price: product.price,
    });
  }

  return items;
}

/** サブスク会員数に合わせたテスト顧客 ID の母数 */
const TEST_CUSTOMER_COUNT = 500;

/**
 * ランダムなテスト顧客 ID を返す。
 *
 * 母数を 500 に絞っているのは FIFO Queue の検証（記事3 シナリオ I）で
 * MessageGroupId = customer_id にしたときに、
 * 同一顧客の注文が複数発生する状況を作るため。
 */
export function randomCustomerId(): string {
  const index = 1 + Math.floor(Math.random() * TEST_CUSTOMER_COUNT);
  return `CUST#test-${String(index).padStart(4, '0')}`;
}

/** 注文合計金額を計算する（要件 1.9） */
export function calculateTotal(items: Pick<OrderItem, 'qty' | 'price'>[]): number {
  return items.reduce((total, item) => total + item.qty * item.price, 0);
}
