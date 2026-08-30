import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  POINT_RATE,
  calculatePoints,
  calculateTotal,
  findProduct,
  randomCustomerId,
  randomOrderItems,
} from './catalog.js';

/**
 * 商品マスタと金額計算の単体テスト（design §12 / Property 6）。
 *
 * 商品マスタは 240 件しかないため、標本ではなく**全件**を検証する。
 * ランダム生成は乱数依存なので、範囲の不変条件を多数回の試行で確認する。
 */

/**
 * SKU の形式（要件 3.1 / 3.2）。
 * `ITEM#{産地略}-{品種略}-{グレード}-{焙煎度}-{容量}`
 * 出典: docs/poc/kiro-roasters-background.md 命名規則（例 ITEM#ETH-YIRG-G1-MEDIUM-200G）
 */
const SKU_PATTERN =
  /^ITEM#[A-Z]{3}-[A-Z]{4}-[A-Z0-9]{2,3}-(LIGHT|MEDIUM|CITY|FULLCITY|FRENCH|ITALIAN)-(100G|200G|500G|1KG)$/;

/** EC 向けの容量（業務用 5kg を含まない。要件 3.3） */
const EC_SIZES = ['100G', '200G', '500G', '1KG'];

/** 乱数依存のテストの試行回数。1〜3 明細・1〜2 個の全組み合わせが十分に出る回数 */
const RANDOM_TRIALS = 500;

describe('CATALOG: SKU 形式（要件 3.1 / 3.2）', () => {
  it('全 SKU が命名規則に従う', () => {
    const violations = CATALOG.filter((product) => !SKU_PATTERN.test(product.sku));

    expect(violations).toEqual([]);
  });

  it('SKU は ITEM# の後ろがハイフン区切りの 5 要素である', () => {
    for (const product of CATALOG) {
      const [prefix, body] = product.sku.split('#');

      expect(prefix).toBe('ITEM');
      expect(body.split('-')).toHaveLength(5);
    }
  });

  it('命名規則の例（ITEM#ETH-YIRG-G1-MEDIUM-200G）が実在する', () => {
    expect(findProduct('ITEM#ETH-YIRG-G1-MEDIUM-200G')).toBeDefined();
  });

  it('SKU は重複しない', () => {
    const unique = new Set(CATALOG.map((product) => product.sku));

    expect(unique.size).toBe(CATALOG.length);
  });
});

describe('CATALOG: EC 向け商品のみ（要件 3.3）', () => {
  it('業務用 5kg を含まない', () => {
    const bulk = CATALOG.filter((product) => product.sku.endsWith('-5KG'));

    expect(bulk).toEqual([]);
  });

  it('容量は EC 向けの 4 種類だけである', () => {
    const sizes = new Set(CATALOG.map((product) => product.sku.split('-').at(-1)));

    expect([...sizes].sort()).toEqual([...EC_SIZES].sort());
  });

  it('商品数は 10 産地 × 6 焙煎度 × 4 容量 = 240 である（design 論点 6）', () => {
    expect(CATALOG).toHaveLength(240);
  });
});

describe('CATALOG: 商品属性（要件 3.4）', () => {
  it('全商品が SKU・商品名・税込単価を持つ', () => {
    for (const product of CATALOG) {
      expect(product.sku).not.toBe('');
      expect(product.name).not.toBe('');
      expect(Number.isInteger(product.price)).toBe(true);
      expect(product.price).toBeGreaterThan(0);
    }
  });
});

describe('findProduct（要件 1.8 の判定に使う）', () => {
  it('商品マスタの全 SKU を引ける', () => {
    for (const product of CATALOG) {
      expect(findProduct(product.sku)).toEqual(product);
    }
  });

  it('存在しない SKU は undefined を返す', () => {
    expect(findProduct('ITEM#XXX-XXXX-G1-MEDIUM-200G')).toBeUndefined();
    // 業務用 5kg は EC 商品マスタに無いため、注文されても弾かれる
    expect(findProduct('ITEM#ETH-YIRG-G1-MEDIUM-5KG')).toBeUndefined();
    expect(findProduct('')).toBeUndefined();
  });
});

describe('calculateTotal（要件 1.9 / Property 6）', () => {
  it('明細の qty × price の総和を返す', () => {
    const total = calculateTotal([
      { qty: 2, price: 1800 },
      { qty: 1, price: 4200 },
      { qty: 3, price: 700 },
    ]);

    expect(total).toBe(2 * 1800 + 1 * 4200 + 3 * 700);
  });

  it('明細が 1 件なら qty × price そのものになる', () => {
    expect(calculateTotal([{ qty: 4, price: 1100 }])).toBe(4400);
  });

  it('明細が空なら 0 を返す', () => {
    expect(calculateTotal([])).toBe(0);
  });

  it('ランダム生成した明細でも商品マスタの単価と一致する', () => {
    for (let i = 0; i < RANDOM_TRIALS; i++) {
      const items = randomOrderItems();
      const expected = items.reduce(
        (sum, item) => sum + item.qty * findProduct(item.sku)!.price,
        0
      );

      expect(calculateTotal(items)).toBe(expected);
    }
  });
});

describe('calculatePoints（要件 7.1 / 7.2 / Property 6）', () => {
  it('付与率は購入金額の 1% である', () => {
    expect(POINT_RATE).toBe(0.01);
  });

  it('floor(total × 0.01) を返す', () => {
    expect(calculatePoints(10000)).toBe(100);
    expect(calculatePoints(4400)).toBe(44);
  });

  it('円未満を切り捨てる（四捨五入しない）', () => {
    expect(calculatePoints(1099)).toBe(10);
    expect(calculatePoints(199)).toBe(1);
    expect(calculatePoints(99)).toBe(0);
  });

  it('合計 0 円ならポイントは 0 である', () => {
    expect(calculatePoints(0)).toBe(0);
  });

  it('商品マスタの単価から作れる合計金額では floor(total / 100) と一致する', () => {
    // 単価は 100 円単位に丸められているため、合計も 100 の倍数になる。
    // 浮動小数の丸めで 1 ポイント下振れしないことの確認。
    for (const product of CATALOG) {
      expect(product.price % 100).toBe(0);
      expect(calculatePoints(product.price)).toBe(product.price / 100);
    }
  });
});

describe('randomOrderItems（要件 1.5 / design 論点 6）', () => {
  it('明細数は 1〜3 件、数量は 1〜2 個に収まる', () => {
    for (let i = 0; i < RANDOM_TRIALS; i++) {
      const items = randomOrderItems();

      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items.length).toBeLessThanOrEqual(3);

      for (const item of items) {
        expect(item.qty).toBeGreaterThanOrEqual(1);
        expect(item.qty).toBeLessThanOrEqual(2);
      }
    }
  });

  it('明細の SKU は商品マスタに存在し、同一注文内で重複しない', () => {
    for (let i = 0; i < RANDOM_TRIALS; i++) {
      const items = randomOrderItems();
      const skus = items.map((item) => item.sku);

      expect(new Set(skus).size).toBe(skus.length);
      for (const sku of skus) {
        expect(findProduct(sku)).toBeDefined();
      }
    }
  });

  it('明細数・数量の両端（1 と 3、1 と 2）が実際に出現する', () => {
    const itemCounts = new Set<number>();
    const quantities = new Set<number>();

    for (let i = 0; i < RANDOM_TRIALS; i++) {
      const items = randomOrderItems();
      itemCounts.add(items.length);
      for (const item of items) quantities.add(item.qty);
    }

    expect([...itemCounts].sort()).toEqual([1, 2, 3]);
    expect([...quantities].sort()).toEqual([1, 2]);
  });
});

describe('randomCustomerId（要件 1.6）', () => {
  it('CUST#test-{4 桁} 形式を返す', () => {
    for (let i = 0; i < RANDOM_TRIALS; i++) {
      expect(randomCustomerId()).toMatch(/^CUST#test-\d{4}$/);
    }
  });

  it('母数の両端（0001 と 0500）の範囲に収まる', () => {
    for (let i = 0; i < RANDOM_TRIALS; i++) {
      const index = Number(randomCustomerId().replace('CUST#test-', ''));

      expect(index).toBeGreaterThanOrEqual(1);
      expect(index).toBeLessThanOrEqual(500);
    }
  });
});
