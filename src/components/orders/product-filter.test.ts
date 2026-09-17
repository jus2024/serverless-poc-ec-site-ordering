import { describe, expect, it } from "vitest";

import type { CatalogProductView } from "../../lib/orders/types";
import {
  ORIGIN_FILTER_ALL,
  buildOriginFilterOptions,
  filterProductsByOrigin,
  listOrigins,
  originCountry,
  roastSortKey,
  sizeSortKey,
  sortProductsBySize,
  sortProductsForDisplay,
} from "./product-filter";

const ORIGIN_ETH = "エチオピア イルガチェフェ G1";
const ORIGIN_COL = "コロンビア スプレモ EP";
const ORIGIN_BRA = "ブラジル サントス NY2";

/** 商品マスタを組み立てる（産地以外は絞り込みに影響しない） */
function product(sku: string, origin: string): CatalogProductView {
  return { sku, name: sku, price: 1_800, origin, roast: "ミディアム", size: "200g" };
}

/** 容量を指定して商品マスタを組み立てる（容量ソートの検証用） */
function productWithSize(sku: string, size: string): CatalogProductView {
  return { sku, name: sku, price: 1_800, origin: ORIGIN_ETH, roast: "ミディアム", size };
}

/** 産地・焙煎度・容量を指定して商品マスタを組み立てる（容量→焙煎度→産地ソートの検証用） */
function productFull(
  sku: string,
  origin: string,
  roast: string,
  size: string
): CatalogProductView {
  return { sku, name: sku, price: 1_800, origin, roast, size };
}

/**
 * `catalog.ts` と同じく産地 → 焙煎度 → 容量の順に並んだ商品マスタ。
 * 同じ産地が連続して現れる形を再現する。
 */
const PRODUCTS: CatalogProductView[] = [
  product("ITEM#ETH-MEDIUM-200G", ORIGIN_ETH),
  product("ITEM#ETH-DARK-200G", ORIGIN_ETH),
  product("ITEM#COL-MEDIUM-200G", ORIGIN_COL),
];

describe("listOrigins", () => {
  it("重複なしの産地一覧を作る（要件 2.4）", () => {
    expect(listOrigins(PRODUCTS)).toEqual([ORIGIN_ETH, ORIGIN_COL]);
  });

  it("商品マスタに現れた順を保つ（並べ替えない）", () => {
    const reversed = [...PRODUCTS].reverse();

    expect(listOrigins(reversed)).toEqual([ORIGIN_COL, ORIGIN_ETH]);
  });

  it("同じ入力からは常に同じ順序を返す", () => {
    expect(listOrigins(PRODUCTS)).toEqual(listOrigins(PRODUCTS));
  });

  it("前後の空白を落として同じ産地として扱う", () => {
    const products = [product("ITEM#A", ` ${ORIGIN_ETH} `), product("ITEM#B", ORIGIN_ETH)];

    expect(listOrigins(products)).toEqual([ORIGIN_ETH]);
  });

  it("空の産地は選択肢にしない（属性を返さない古い API 相手の保険）", () => {
    const products = [product("ITEM#A", ""), product("ITEM#B", "   "), product("ITEM#C", ORIGIN_ETH)];

    expect(listOrigins(products)).toEqual([ORIGIN_ETH]);
  });

  it("商品マスタが空なら空配列を返す", () => {
    expect(listOrigins([])).toEqual([]);
  });
});

describe("buildOriginFilterOptions", () => {
  it("先頭は常に「すべて」で全件を数える（要件 2.5）", () => {
    const options = buildOriginFilterOptions(PRODUCTS);

    expect(options[0]).toEqual({ value: ORIGIN_FILTER_ALL, label: "すべて", count: 3 });
  });

  it("産地ごとの件数を添える（要件 2.4）", () => {
    expect(buildOriginFilterOptions(PRODUCTS).slice(1)).toEqual([
      { value: ORIGIN_ETH, label: ORIGIN_ETH, count: 2 },
      { value: ORIGIN_COL, label: ORIGIN_COL, count: 1 },
    ]);
  });

  it("商品マスタが空でも「すべて」だけは残る", () => {
    expect(buildOriginFilterOptions([])).toEqual([
      { value: ORIGIN_FILTER_ALL, label: "すべて", count: 0 },
    ]);
  });
});

describe("filterProductsByOrigin", () => {
  it("選んだ産地の商品だけを返す（要件 2.4）", () => {
    const filtered = filterProductsByOrigin(PRODUCTS, ORIGIN_ETH);

    expect(filtered.map((entry) => entry.sku)).toEqual([
      "ITEM#ETH-MEDIUM-200G",
      "ITEM#ETH-DARK-200G",
    ]);
  });

  it("「すべて」なら全件を返す（要件 2.5）", () => {
    expect(filterProductsByOrigin(PRODUCTS, ORIGIN_FILTER_ALL)).toEqual(PRODUCTS);
    expect(filterProductsByOrigin(PRODUCTS, "")).toEqual(PRODUCTS);
  });

  it("商品マスタに無い産地は全件にフォールバックする（0 件で詰まらせない）", () => {
    expect(filterProductsByOrigin(PRODUCTS, "存在しない産地")).toEqual(PRODUCTS);
  });

  it("商品マスタの並び順を保つ", () => {
    const filtered = filterProductsByOrigin(PRODUCTS, ORIGIN_FILTER_ALL);

    expect(filtered.map((entry) => entry.sku)).toEqual(PRODUCTS.map((entry) => entry.sku));
  });

  it("引数の商品マスタを書き換えず、別の配列を返す", () => {
    const products = [...PRODUCTS];

    const filtered = filterProductsByOrigin(products, ORIGIN_FILTER_ALL);

    expect(filtered).not.toBe(products);
    expect(products).toEqual(PRODUCTS);
  });
});

describe("originCountry", () => {
  /** catalog.ts の ORIGINS 全 10 産地と、その先頭語（国名相当） */
  const ORIGIN_COUNTRIES: ReadonlyArray<[string, string]> = [
    ["エチオピア イルガチェフェ G1", "エチオピア"],
    ["エチオピア シダモ G2", "エチオピア"],
    ["ブラジル サントス NY2", "ブラジル"],
    ["ブラジル セラード スペシャルティ", "ブラジル"],
    ["コロンビア スプレモ EP", "コロンビア"],
    ["グアテマラ アンティグア SHB", "グアテマラ"],
    ["ケニア ニエリ AA", "ケニア"],
    ["インドネシア マンデリン G1", "インドネシア"],
    ["コスタリカ タラス SHB", "コスタリカ"],
    ["パナマ ゲイシャ スペシャルティ", "パナマ"],
  ];

  it("全 10 産地で先頭語（国名）を返す", () => {
    for (const [origin, country] of ORIGIN_COUNTRIES) {
      expect(originCountry(origin)).toBe(country);
    }
  });

  it("前後の空白を落として国名を返す", () => {
    expect(originCountry(`  ${ORIGIN_ETH}  `)).toBe("エチオピア");
  });

  it("全角スペース区切りも国名だけを返す", () => {
    expect(originCountry("エチオピア　イルガチェフェ　G1")).toBe("エチオピア");
  });

  it("空文字・空白のみは空文字を返す", () => {
    expect(originCountry("")).toBe("");
    expect(originCountry("   ")).toBe("");
    expect(originCountry("　")).toBe("");
  });

  it("空白を含まない単語はそのまま返す", () => {
    expect(originCountry("エチオピア")).toBe("エチオピア");
  });
});

describe("sizeSortKey", () => {
  it("100g < 200g < 500g < 1kg の順になる", () => {
    expect(sizeSortKey("100g")).toBe(100);
    expect(sizeSortKey("200g")).toBe(200);
    expect(sizeSortKey("500g")).toBe(500);
    expect(sizeSortKey("1kg")).toBe(1000);

    expect(sizeSortKey("100g")).toBeLessThan(sizeSortKey("200g"));
    expect(sizeSortKey("200g")).toBeLessThan(sizeSortKey("500g"));
    expect(sizeSortKey("500g")).toBeLessThan(sizeSortKey("1kg"));
  });

  it("文字列順の落とし穴（1kg が 200g より前）に陥らない", () => {
    // 文字列比較だと "1kg" < "200g" だが、数値では 1000 > 200
    expect(sizeSortKey("1kg")).toBeGreaterThan(sizeSortKey("200g"));
  });

  it("前後の空白・大文字も正規化して解釈する", () => {
    expect(sizeSortKey(" 1KG ")).toBe(1000);
    expect(sizeSortKey("500G")).toBe(500);
  });

  it("想定外の表示名は末尾に送る大きな値になる", () => {
    expect(sizeSortKey("不明")).toBe(Number.MAX_SAFE_INTEGER);
    expect(sizeSortKey("")).toBe(Number.MAX_SAFE_INTEGER);
    expect(sizeSortKey("不明")).toBeGreaterThan(sizeSortKey("1kg"));
  });
});

describe("roastSortKey", () => {
  it("焙煎の浅い→深いの順（ライト → … → イタリアン）になる", () => {
    // 順序の正は catalog.ts の ROASTS 定義順。
    expect(roastSortKey("ライト")).toBe(0);
    expect(roastSortKey("ミディアム")).toBe(1);
    expect(roastSortKey("シティ")).toBe(2);
    expect(roastSortKey("フルシティ")).toBe(3);
    expect(roastSortKey("フレンチ")).toBe(4);
    expect(roastSortKey("イタリアン")).toBe(5);

    expect(roastSortKey("ライト")).toBeLessThan(roastSortKey("ミディアム"));
    expect(roastSortKey("ミディアム")).toBeLessThan(roastSortKey("シティ"));
    expect(roastSortKey("シティ")).toBeLessThan(roastSortKey("フルシティ"));
    expect(roastSortKey("フルシティ")).toBeLessThan(roastSortKey("フレンチ"));
    expect(roastSortKey("フレンチ")).toBeLessThan(roastSortKey("イタリアン"));
  });

  it("前後の空白を落として解釈する", () => {
    expect(roastSortKey(" ライト ")).toBe(0);
    expect(roastSortKey("　イタリアン　".replace(/　/g, " "))).toBe(5);
  });

  it("想定外の表示名は末尾に送る大きな値になる", () => {
    expect(roastSortKey("不明")).toBe(Number.MAX_SAFE_INTEGER);
    expect(roastSortKey("")).toBe(Number.MAX_SAFE_INTEGER);
    expect(roastSortKey("不明")).toBeGreaterThan(roastSortKey("イタリアン"));
  });
});

describe("sortProductsBySize", () => {
  it("容量昇順（100g → 200g → 500g → 1kg）に並べる", () => {
    const products = [
      productWithSize("ITEM#500G", "500g"),
      productWithSize("ITEM#100G", "100g"),
      productWithSize("ITEM#1KG", "1kg"),
      productWithSize("ITEM#200G", "200g"),
    ];

    expect(sortProductsBySize(products).map((entry) => entry.sku)).toEqual([
      "ITEM#100G",
      "ITEM#200G",
      "ITEM#500G",
      "ITEM#1KG",
    ]);
  });

  it("同一容量内は入力順を保つ（安定ソート）", () => {
    const products = [
      productWithSize("ITEM#200G-A", "200g"),
      productWithSize("ITEM#100G-A", "100g"),
      productWithSize("ITEM#200G-B", "200g"),
      productWithSize("ITEM#100G-B", "100g"),
    ];

    expect(sortProductsBySize(products).map((entry) => entry.sku)).toEqual([
      "ITEM#100G-A",
      "ITEM#100G-B",
      "ITEM#200G-A",
      "ITEM#200G-B",
    ]);
  });

  it("引数の商品マスタを書き換えず、別の配列を返す", () => {
    const products = [
      productWithSize("ITEM#500G", "500g"),
      productWithSize("ITEM#100G", "100g"),
    ];
    const snapshot = products.map((entry) => entry.sku);

    const sorted = sortProductsBySize(products);

    expect(sorted).not.toBe(products);
    expect(products.map((entry) => entry.sku)).toEqual(snapshot);
  });

  it("想定外の容量は末尾に回る（既知の容量が先）", () => {
    const products = [
      productWithSize("ITEM#UNKNOWN", "不明"),
      productWithSize("ITEM#100G", "100g"),
    ];

    expect(sortProductsBySize(products).map((entry) => entry.sku)).toEqual([
      "ITEM#100G",
      "ITEM#UNKNOWN",
    ]);
  });
});

describe("sortProductsForDisplay", () => {
  it("第 1 キーは容量昇順（100g 群がすべて先、その後 200g 群…）", () => {
    // 入力は容量が混在。容量が第 1 キーなので、まず 100g 群、次に 200g 群…に固まる。
    const products = [
      productFull("ITEM#ETH-LIGHT-200G", ORIGIN_ETH, "ライト", "200g"),
      productFull("ITEM#COL-LIGHT-100G", ORIGIN_COL, "ライト", "100g"),
      productFull("ITEM#ETH-LIGHT-100G", ORIGIN_ETH, "ライト", "100g"),
      productFull("ITEM#COL-LIGHT-200G", ORIGIN_COL, "ライト", "200g"),
    ];

    expect(sortProductsForDisplay(products).map((entry) => entry.size)).toEqual([
      "100g",
      "100g",
      "200g",
      "200g",
    ]);
  });

  it("同一容量内は焙煎度昇順（ライト → … → イタリアン）に並べる", () => {
    const products = [
      productFull("ITEM#ETH-ITALIAN-200G", ORIGIN_ETH, "イタリアン", "200g"),
      productFull("ITEM#ETH-LIGHT-200G", ORIGIN_ETH, "ライト", "200g"),
      productFull("ITEM#ETH-CITY-200G", ORIGIN_ETH, "シティ", "200g"),
      productFull("ITEM#ETH-FRENCH-200G", ORIGIN_ETH, "フレンチ", "200g"),
      productFull("ITEM#ETH-MEDIUM-200G", ORIGIN_ETH, "ミディアム", "200g"),
      productFull("ITEM#ETH-FULLCITY-200G", ORIGIN_ETH, "フルシティ", "200g"),
    ];

    expect(sortProductsForDisplay(products).map((entry) => entry.roast)).toEqual([
      "ライト",
      "ミディアム",
      "シティ",
      "フルシティ",
      "フレンチ",
      "イタリアン",
    ]);
  });

  it("同一容量・同一焙煎度内は産地の出現順（入力順）を保つ（行ごとに産地が変わる）", () => {
    // 出現順は ETH → COL → BRA。容量・焙煎度が同じなので産地の入力順がそのまま出る。
    // これが「横一列ごとに産地＝色が変わる」並びを固定する検証。
    const products = [
      productFull("ITEM#ETH-LIGHT-100G", ORIGIN_ETH, "ライト", "100g"),
      productFull("ITEM#COL-LIGHT-100G", ORIGIN_COL, "ライト", "100g"),
      productFull("ITEM#BRA-LIGHT-100G", ORIGIN_BRA, "ライト", "100g"),
    ];

    expect(sortProductsForDisplay(products).map((entry) => entry.origin)).toEqual([
      ORIGIN_ETH,
      ORIGIN_COL,
      ORIGIN_BRA,
    ]);
  });

  it("容量 → 焙煎度 → 産地の順に並ぶ（全キーが効く総合ケース）", () => {
    // 入力はわざと逆順気味。産地の第 3 キーは「入力全体での出現順」（listOrigins）で、
    // ここでは COL が先に現れる → COL が ETH より前になる。期待は 100g 群→200g 群、
    // 各容量内はライト→ミディアム、各(容量,焙煎度)内は出現順 COL → ETH。
    const products = [
      productFull("ITEM#COL-MEDIUM-200G", ORIGIN_COL, "ミディアム", "200g"),
      productFull("ITEM#ETH-MEDIUM-200G", ORIGIN_ETH, "ミディアム", "200g"),
      productFull("ITEM#COL-LIGHT-200G", ORIGIN_COL, "ライト", "200g"),
      productFull("ITEM#ETH-LIGHT-200G", ORIGIN_ETH, "ライト", "200g"),
      productFull("ITEM#COL-MEDIUM-100G", ORIGIN_COL, "ミディアム", "100g"),
      productFull("ITEM#ETH-MEDIUM-100G", ORIGIN_ETH, "ミディアム", "100g"),
      productFull("ITEM#COL-LIGHT-100G", ORIGIN_COL, "ライト", "100g"),
      productFull("ITEM#ETH-LIGHT-100G", ORIGIN_ETH, "ライト", "100g"),
    ];

    expect(sortProductsForDisplay(products).map((entry) => entry.sku)).toEqual([
      "ITEM#COL-LIGHT-100G",
      "ITEM#ETH-LIGHT-100G",
      "ITEM#COL-MEDIUM-100G",
      "ITEM#ETH-MEDIUM-100G",
      "ITEM#COL-LIGHT-200G",
      "ITEM#ETH-LIGHT-200G",
      "ITEM#COL-MEDIUM-200G",
      "ITEM#ETH-MEDIUM-200G",
    ]);
  });

  it("想定外の容量は末尾に回る（既知の容量が先）", () => {
    const products = [
      productFull("ITEM#ETH-LIGHT-UNKNOWN", ORIGIN_ETH, "ライト", "不明"),
      productFull("ITEM#ETH-LIGHT-100G", ORIGIN_ETH, "ライト", "100g"),
      productFull("ITEM#ETH-LIGHT-200G", ORIGIN_ETH, "ライト", "200g"),
    ];

    expect(sortProductsForDisplay(products).map((entry) => entry.sku)).toEqual([
      "ITEM#ETH-LIGHT-100G",
      "ITEM#ETH-LIGHT-200G",
      "ITEM#ETH-LIGHT-UNKNOWN",
    ]);
  });

  it("想定外の焙煎度は同一容量内の末尾に回る（既知の焙煎度が先）", () => {
    const products = [
      productFull("ITEM#ETH-UNKNOWN-100G", ORIGIN_ETH, "不明", "100g"),
      productFull("ITEM#ETH-LIGHT-100G", ORIGIN_ETH, "ライト", "100g"),
      productFull("ITEM#ETH-ITALIAN-100G", ORIGIN_ETH, "イタリアン", "100g"),
    ];

    expect(sortProductsForDisplay(products).map((entry) => entry.sku)).toEqual([
      "ITEM#ETH-LIGHT-100G",
      "ITEM#ETH-ITALIAN-100G",
      "ITEM#ETH-UNKNOWN-100G",
    ]);
  });

  it("引数の商品マスタを書き換えず、別の配列を返す", () => {
    const products = [
      productFull("ITEM#COL-MEDIUM-200G", ORIGIN_COL, "ミディアム", "200g"),
      productFull("ITEM#ETH-LIGHT-100G", ORIGIN_ETH, "ライト", "100g"),
    ];
    const snapshot = products.map((entry) => entry.sku);

    const sorted = sortProductsForDisplay(products);

    expect(sorted).not.toBe(products);
    expect(products.map((entry) => entry.sku)).toEqual(snapshot);
  });
});
