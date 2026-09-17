import { describe, expect, it } from "vitest";

import type { CatalogProductView } from "../../lib/orders/types";
import { buildCartOrderDraft, type CartLine } from "./cart";
import { MAX_ITEM_QTY } from "./order-form";
import { describeCartDraftIssue, describeOrderSubmitStatus } from "./order-submit";

/**
 * 指摘の文言は `order-form.ts` が持つ。ここでは実際の `buildCartOrderDraft` の
 * 結果を入力にして、まとめ方（重複を落とす・`formIssue` を先に置く）だけを見る。
 */
const PRODUCTS: CatalogProductView[] = [
  {
    sku: "ITEM#ETH-YIRG-G1-MEDIUM-200G",
    name: "エチオピア イルガチェフェ G1 ミディアム 200g",
    price: 1_800,
    origin: "エチオピア イルガチェフェ G1",
    roast: "ミディアム",
    size: "200g",
  },
  {
    sku: "ITEM#COL-SUP-EP-DARK-200G",
    name: "コロンビア スプレモ EP フレンチ 200g",
    price: 1_600,
    origin: "コロンビア スプレモ EP",
    roast: "フレンチ",
    size: "200g",
  },
];

function line(sku: string, qty: number): CartLine {
  return { sku, qty };
}

describe("describeCartDraftIssue", () => {
  it("検証を通った明細では指摘を出さない（要件 4.1）", () => {
    const draft = buildCartOrderDraft([line(PRODUCTS[0].sku, 2)], PRODUCTS);

    expect(draft.ok).toBe(true);
    expect(describeCartDraftIssue(draft)).toBeNull();
  });

  it("空のカートは送信を止める（要件 3.6 の保険）", () => {
    const draft = buildCartOrderDraft([], PRODUCTS);

    expect(describeCartDraftIssue(draft)).toBe("明細を 1 行以上追加してください。");
  });

  it("数量の上限超過を指摘する（要件 3.8）", () => {
    const draft = buildCartOrderDraft([line(PRODUCTS[0].sku, MAX_ITEM_QTY + 1)], PRODUCTS);

    expect(describeCartDraftIssue(draft)).toBe(`数量は ${MAX_ITEM_QTY} までです。`);
  });

  it("同じ指摘が複数行にあっても 1 回だけ出す", () => {
    const draft = buildCartOrderDraft(
      [line(PRODUCTS[0].sku, MAX_ITEM_QTY + 1), line(PRODUCTS[1].sku, MAX_ITEM_QTY + 5)],
      PRODUCTS
    );
    const issue = describeCartDraftIssue(draft);

    expect(issue).toBe(`数量は ${MAX_ITEM_QTY} までです。`);
  });

  it("異なる指摘は両方出す", () => {
    const draft = buildCartOrderDraft(
      [line("ITEM#UNKNOWN", 1), line(PRODUCTS[0].sku, MAX_ITEM_QTY + 1)],
      PRODUCTS
    );
    const issue = describeCartDraftIssue(draft);

    expect(issue).toContain("商品マスタにない SKU です。");
    expect(issue).toContain(`数量は ${MAX_ITEM_QTY} までです。`);
  });

  it("商品マスタが空なら SKU の指摘を出す（読み込み前に押した場合）", () => {
    const draft = buildCartOrderDraft([line(PRODUCTS[0].sku, 1)], []);

    expect(describeCartDraftIssue(draft)).toContain("商品マスタにない SKU です。");
  });
});

describe("describeOrderSubmitStatus", () => {
  const idle = {
    submitting: false,
    draftIssue: null,
    failureTitle: null,
    acceptedOrderId: null,
  };

  it("何も起きていなければ空文字を返す", () => {
    expect(describeOrderSubmitStatus(idle)).toBe("");
  });

  it("送信中を伝える（要件 4.6 / 6.5）", () => {
    expect(describeOrderSubmitStatus({ ...idle, submitting: true })).toBe(
      "注文を送信しています…"
    );
  });

  it("受付済みの注文番号を読み上げる（要件 4.2）", () => {
    expect(describeOrderSubmitStatus({ ...idle, acceptedOrderId: "ORD#01J" })).toBe(
      "注文 ORD#01J を受け付けました。"
    );
  });

  it("失敗の見出しを読み上げる（要件 4.5）", () => {
    expect(
      describeOrderSubmitStatus({ ...idle, failureTitle: "注文の投入に失敗しました（通信エラー）" })
    ).toBe("注文に失敗しました: 注文の投入に失敗しました（通信エラー）");
  });

  it("送信前の指摘を読み上げる", () => {
    expect(describeOrderSubmitStatus({ ...idle, draftIssue: "数量は 100 までです。" })).toBe(
      "注文できません: 数量は 100 までです。"
    );
  });

  it("送信中は前回の結果より送信中を優先する", () => {
    expect(
      describeOrderSubmitStatus({ ...idle, submitting: true, acceptedOrderId: "ORD#01J" })
    ).toBe("注文を送信しています…");
  });

  it("送信前の指摘は前回の受付結果より優先する", () => {
    expect(
      describeOrderSubmitStatus({
        ...idle,
        draftIssue: "明細を 1 行以上追加してください。",
        acceptedOrderId: "ORD#01J",
      })
    ).toBe("注文できません: 明細を 1 行以上追加してください。");
  });
});
