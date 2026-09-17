import { describe, expect, it } from "vitest";

import { isTabNavigationKey, resolveTabIndex } from "./tab-navigation";

/** 本 PoC のタブ数（注文 / 負荷テスト / 計測結果 / 設定） */
const TAB_COUNT = 4;

describe("isTabNavigationKey", () => {
  it("タブリストで扱う 4 キーを受け付ける", () => {
    expect(isTabNavigationKey("ArrowRight")).toBe(true);
    expect(isTabNavigationKey("ArrowLeft")).toBe(true);
    expect(isTabNavigationKey("Home")).toBe(true);
    expect(isTabNavigationKey("End")).toBe(true);
  });

  it("それ以外のキーは扱わない", () => {
    // 縦方向の矢印と Tab / Enter はブラウザ既定の挙動に委ねる
    expect(isTabNavigationKey("ArrowDown")).toBe(false);
    expect(isTabNavigationKey("Tab")).toBe(false);
    expect(isTabNavigationKey("Enter")).toBe(false);
    expect(isTabNavigationKey("")).toBe(false);
  });
});

describe("resolveTabIndex", () => {
  it("ArrowRight で次のタブへ進む", () => {
    expect(resolveTabIndex("ArrowRight", 0, TAB_COUNT)).toBe(1);
    expect(resolveTabIndex("ArrowRight", 2, TAB_COUNT)).toBe(3);
  });

  it("ArrowLeft で前のタブへ戻る", () => {
    expect(resolveTabIndex("ArrowLeft", 3, TAB_COUNT)).toBe(2);
    expect(resolveTabIndex("ArrowLeft", 1, TAB_COUNT)).toBe(0);
  });

  it("末尾で ArrowRight すると先頭へ回り込む", () => {
    expect(resolveTabIndex("ArrowRight", TAB_COUNT - 1, TAB_COUNT)).toBe(0);
  });

  it("先頭で ArrowLeft すると末尾へ回り込む", () => {
    expect(resolveTabIndex("ArrowLeft", 0, TAB_COUNT)).toBe(TAB_COUNT - 1);
  });

  it("Home / End は現在位置に関係なく端へ飛ぶ", () => {
    expect(resolveTabIndex("Home", 2, TAB_COUNT)).toBe(0);
    expect(resolveTabIndex("Home", 0, TAB_COUNT)).toBe(0);
    expect(resolveTabIndex("End", 1, TAB_COUNT)).toBe(TAB_COUNT - 1);
    expect(resolveTabIndex("End", TAB_COUNT - 1, TAB_COUNT)).toBe(TAB_COUNT - 1);
  });

  it("タブが 1 つだけなら矢印キーでも同じ位置に留まる", () => {
    expect(resolveTabIndex("ArrowRight", 0, 1)).toBe(0);
    expect(resolveTabIndex("ArrowLeft", 0, 1)).toBe(0);
  });

  it("扱わないキーは null を返す（既定の挙動に委ねる）", () => {
    expect(resolveTabIndex("ArrowDown", 0, TAB_COUNT)).toBeNull();
    expect(resolveTabIndex("Tab", 0, TAB_COUNT)).toBeNull();
  });

  it("タブ数が 0 以下・非整数なら null を返す", () => {
    expect(resolveTabIndex("Home", 0, 0)).toBeNull();
    expect(resolveTabIndex("ArrowRight", 0, -1)).toBeNull();
    expect(resolveTabIndex("End", 0, 2.5)).toBeNull();
  });

  it("矢印キーで現在位置が範囲外なら null を返す", () => {
    expect(resolveTabIndex("ArrowRight", -1, TAB_COUNT)).toBeNull();
    expect(resolveTabIndex("ArrowRight", TAB_COUNT, TAB_COUNT)).toBeNull();
    expect(resolveTabIndex("ArrowLeft", 1.5, TAB_COUNT)).toBeNull();
  });

  it("Home / End は現在位置が範囲外でも端を返す", () => {
    // 現在位置に依存しないため、状態が壊れていても端へ復帰できる
    expect(resolveTabIndex("Home", -1, TAB_COUNT)).toBe(0);
    expect(resolveTabIndex("End", 99, TAB_COUNT)).toBe(TAB_COUNT - 1);
  });
});
