import { describe, expect, it } from "vitest";

import {
  PRODUCT_THUMB_TONES,
  cssVarRef,
  originToneIndex,
  pickProductThumbTone,
} from "./product-visual";

/**
 * `amplify/functions/shared/catalog.ts` の `ORIGINS[].name` を写したもの。
 *
 * 実際の 10 産地で確かめるためにここに置いている（`amplify/` から import しない。
 * フロントとバックエンドのビルドを独立させる方針。`src/lib/orders/types.ts` 参照）。
 * 産地が増減してもこのモジュールの振る舞いは変わらないため、
 * 追随しなくてもテストが誤りになることはない。
 */
const ORIGINS = [
  "エチオピア イルガチェフェ G1",
  "エチオピア シダモ G2",
  "ブラジル サントス NY2",
  "ブラジル セラード スペシャルティ",
  "コロンビア スプレモ EP",
  "グアテマラ アンティグア SHB",
  "ケニア ニエリ AA",
  "インドネシア マンデリン G1",
  "コスタリカ タラス SHB",
  "パナマ ゲイシャ スペシャルティ",
];

describe("originToneIndex", () => {
  it("同じ産地からは常に同じ index を返す（絞り込みで色が変わらない。要件 2.3）", () => {
    for (const origin of ORIGINS) {
      expect(originToneIndex(origin)).toBe(originToneIndex(origin));
    }
  });

  it("どの産地でも配色の範囲に収まる", () => {
    for (const origin of ORIGINS) {
      const index = originToneIndex(origin);

      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(PRODUCT_THUMB_TONES.length);
    }
  });

  it("前後の空白を落として同じ産地として扱う（product-filter.ts の扱いに合わせる）", () => {
    expect(originToneIndex(" コロンビア スプレモ EP ")).toBe(
      originToneIndex("コロンビア スプレモ EP")
    );
  });

  it("空の産地でも範囲内の index を返す（属性が無い応答で落ちない）", () => {
    expect(originToneIndex("")).toBe(0);
    expect(originToneIndex("   ")).toBe(0);
  });

  it("産地が違えば index も違うことがある（全産地が同じ色に潰れない）", () => {
    const used = new Set(ORIGINS.map((origin) => originToneIndex(origin)));

    expect(used.size).toBeGreaterThan(1);
  });
});

describe("pickProductThumbTone", () => {
  it("背景と前景に別のトークンを返す（アイコンが背景に沈まない）", () => {
    for (const origin of ORIGINS) {
      const tone = pickProductThumbTone(origin);

      expect(tone.background).not.toBe(tone.foreground);
    }
  });

  it("返すのは globals.css の CSS 変数名だけで、生の色値を含まない（要件 6.2）", () => {
    for (const tone of PRODUCT_THUMB_TONES) {
      expect(tone.background).toMatch(/^--color-[a-z-]+$/);
      expect(tone.foreground).toMatch(/^--color-[a-z-]+$/);
    }
  });

  it("配色の一覧に含まれる値を返す", () => {
    for (const origin of ORIGINS) {
      expect(PRODUCT_THUMB_TONES).toContain(pickProductThumbTone(origin));
    }
  });
});

describe("cssVarRef", () => {
  it("CSS 変数名を var() 参照にする", () => {
    expect(cssVarRef("--color-brand")).toBe("var(--color-brand)");
  });
});
