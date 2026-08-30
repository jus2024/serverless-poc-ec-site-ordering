import { describe, expect, it } from "vitest";

import type { CatalogProductView } from "../../lib/orders/types";
import {
  MAX_ID_LENGTH,
  MAX_INITIAL_QUANTITY,
  MAX_ITEM_QTY,
  buildOrderDraft,
  findLineIssue,
  parseCustomerIdInput,
  parseInitialQuantityInput,
  parseOrderIdInput,
  parseQtyInput,
} from "./order-form";

/** `GET /catalog` の応答を模した商品マスタ（単価の出典） */
const PRODUCTS: CatalogProductView[] = [
  { sku: "ITEM#ETH-YIRG-G1-MEDIUM-200G", name: "エチオピア イルガチェフェ 中煎り 200g", price: 1_800 },
  { sku: "ITEM#COL-SUP-G1-DARK-500G", name: "コロンビア スプレモ 深煎り 500g", price: 3_600 },
];

describe("parseQtyInput", () => {
  it("1 以上の整数を受け付ける", () => {
    expect(parseQtyInput("1")).toEqual({ ok: true, value: 1 });
    expect(parseQtyInput(" 12 ")).toEqual({ ok: true, value: 12 });
    expect(parseQtyInput(String(MAX_ITEM_QTY))).toEqual({ ok: true, value: MAX_ITEM_QTY });
  });

  it("未入力を弾く", () => {
    expect(parseQtyInput("")).toMatchObject({ ok: false });
    expect(parseQtyInput("   ")).toMatchObject({ ok: false });
  });

  it("整数でない値を弾く", () => {
    expect(parseQtyInput("1.5")).toMatchObject({ ok: false });
    expect(parseQtyInput("a")).toMatchObject({ ok: false });
    expect(parseQtyInput("-1")).toMatchObject({ ok: false });
  });

  it("0 と上限超過を弾く", () => {
    expect(parseQtyInput("0")).toMatchObject({ ok: false });
    expect(parseQtyInput(String(MAX_ITEM_QTY + 1))).toMatchObject({ ok: false });
  });
});

describe("buildOrderDraft", () => {
  it("商品マスタの単価で明細を組み立てる", () => {
    const result = buildOrderDraft(
      [
        { id: "l1", sku: "ITEM#ETH-YIRG-G1-MEDIUM-200G", qty: "2" },
        { id: "l2", sku: "ITEM#COL-SUP-G1-DARK-500G", qty: "1" },
      ],
      PRODUCTS
    );

    expect(result.ok).toBe(true);
    expect(result.items).toEqual([
      { sku: "ITEM#ETH-YIRG-G1-MEDIUM-200G", qty: 2, price: 1_800 },
      { sku: "ITEM#COL-SUP-G1-DARK-500G", qty: 1, price: 3_600 },
    ]);
    // qty × price の総和（要件 1.9 と同じ算術）
    expect(result.totalAmount).toBe(7_200);
    expect(result.lineIssues).toEqual([]);
    expect(result.formIssue).toBeNull();
  });

  it("明細が 0 行ならフォーム全体の指摘にする", () => {
    const result = buildOrderDraft([], PRODUCTS);

    expect(result.ok).toBe(false);
    expect(result.formIssue).not.toBeNull();
    expect(result.items).toEqual([]);
  });

  it("未選択の SKU を指摘する", () => {
    const result = buildOrderDraft([{ id: "l1", sku: "", qty: "1" }], PRODUCTS);

    expect(result.ok).toBe(false);
    expect(findLineIssue(result.lineIssues, "l1", "sku")).not.toBeNull();
  });

  it("商品マスタにない SKU を指摘する", () => {
    const result = buildOrderDraft([{ id: "l1", sku: "ITEM#UNKNOWN", qty: "1" }], PRODUCTS);

    expect(result.ok).toBe(false);
    expect(findLineIssue(result.lineIssues, "l1", "sku")).toContain("商品マスタにない");
  });

  it("重複した SKU は後の行を指摘する（引当のトランザクションが拒否されるため）", () => {
    const result = buildOrderDraft(
      [
        { id: "l1", sku: "ITEM#ETH-YIRG-G1-MEDIUM-200G", qty: "1" },
        { id: "l2", sku: "ITEM#ETH-YIRG-G1-MEDIUM-200G", qty: "2" },
      ],
      PRODUCTS
    );

    expect(result.ok).toBe(false);
    expect(findLineIssue(result.lineIssues, "l1", "sku")).toBeNull();
    expect(findLineIssue(result.lineIssues, "l2", "sku")).toContain("重複");
  });

  it("すべての行の指摘を一度に集める", () => {
    const result = buildOrderDraft(
      [
        { id: "l1", sku: "", qty: "0" },
        { id: "l2", sku: "ITEM#UNKNOWN", qty: "x" },
      ],
      PRODUCTS
    );

    expect(result.lineIssues).toHaveLength(4);
    expect(findLineIssue(result.lineIssues, "l1", "qty")).not.toBeNull();
    expect(findLineIssue(result.lineIssues, "l2", "sku")).not.toBeNull();
  });

  it("指摘があるときは明細を返さない", () => {
    const result = buildOrderDraft(
      [
        { id: "l1", sku: "ITEM#ETH-YIRG-G1-MEDIUM-200G", qty: "2" },
        { id: "l2", sku: "", qty: "1" },
      ],
      PRODUCTS
    );

    // 有効な行だけ送ると、検証者が指定したつもりの注文と中身が食い違う
    expect(result.ok).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.totalAmount).toBe(0);
  });

  it("商品マスタが空なら全行を指摘する", () => {
    const result = buildOrderDraft([{ id: "l1", sku: "ITEM#ETH-YIRG-G1-MEDIUM-200G", qty: "1" }], []);

    expect(result.ok).toBe(false);
    expect(findLineIssue(result.lineIssues, "l1", "sku")).not.toBeNull();
  });
});

describe("findLineIssue", () => {
  it("該当しない組み合わせでは null を返す", () => {
    const issues = [{ lineId: "l1", field: "sku" as const, message: "x" }];

    expect(findLineIssue(issues, "l1", "sku")).toBe("x");
    expect(findLineIssue(issues, "l1", "qty")).toBeNull();
    expect(findLineIssue(issues, "l2", "sku")).toBeNull();
  });
});

describe("parseCustomerIdInput", () => {
  it("未入力は未指定として扱う（API がテスト顧客を割り当てる）", () => {
    expect(parseCustomerIdInput("")).toEqual({ ok: true, value: undefined });
    expect(parseCustomerIdInput("  ")).toEqual({ ok: true, value: undefined });
  });

  it("前後の空白を落として送る", () => {
    expect(parseCustomerIdInput(" test-0001 ")).toEqual({ ok: true, value: "test-0001" });
  });

  it("上限を超える長さを弾く", () => {
    expect(parseCustomerIdInput("a".repeat(MAX_ID_LENGTH))).toMatchObject({ ok: true });
    expect(parseCustomerIdInput("a".repeat(MAX_ID_LENGTH + 1))).toMatchObject({ ok: false });
  });
});

describe("parseInitialQuantityInput", () => {
  it("未入力は未指定として扱う（API の既定値に委ねる）", () => {
    expect(parseInitialQuantityInput("")).toEqual({ ok: true, value: undefined });
  });

  it("0 を許す（在庫不足の検証に使う）", () => {
    expect(parseInitialQuantityInput("0")).toEqual({ ok: true, value: 0 });
  });

  it("整数でない値を弾く", () => {
    expect(parseInitialQuantityInput("1.5")).toMatchObject({ ok: false });
    expect(parseInitialQuantityInput("-1")).toMatchObject({ ok: false });
    expect(parseInitialQuantityInput("1e6")).toMatchObject({ ok: false });
  });

  it("上限超過を弾く", () => {
    expect(parseInitialQuantityInput(String(MAX_INITIAL_QUANTITY))).toMatchObject({ ok: true });
    expect(parseInitialQuantityInput(String(MAX_INITIAL_QUANTITY + 1))).toMatchObject({
      ok: false,
    });
  });
});

describe("parseOrderIdInput", () => {
  it("空文字だけを弾き、形式は検査しない", () => {
    expect(parseOrderIdInput("")).toMatchObject({ ok: false });
    expect(parseOrderIdInput("  ")).toMatchObject({ ok: false });
    // `ORD#{ULID}` 以外でも API に送り、404 か 200 かは API に判断させる
    expect(parseOrderIdInput(" ORD#01HZ ")).toEqual({ ok: true, value: "ORD#01HZ" });
    expect(parseOrderIdInput("手で書いた ID")).toMatchObject({ ok: true });
  });

  it("上限を超える長さを弾く", () => {
    expect(parseOrderIdInput("a".repeat(MAX_ID_LENGTH + 1))).toMatchObject({ ok: false });
  });
});
