import { describe, expect, it } from "vitest";

import type { CatalogProductView } from "../../lib/orders/types";
import {
  MIN_CART_QTY,
  addCartLine,
  buildCartOrderDraft,
  cartLineDraftId,
  readCartQtyInput,
  removeCartLine,
  setCartLineQty,
  summarizeCart,
  toOrderLineDrafts,
  type CartLine,
} from "./cart";
import { MAX_ITEM_QTY, findLineIssue } from "./order-form";

const SKU_ETH = "ITEM#ETH-YIRG-G1-MEDIUM-200G";
const SKU_COL = "ITEM#COL-SUP-G1-DARK-500G";
const SKU_KEN = "ITEM#KEN-AA-TOP-CITY-100G";

/** `GET /catalog` の応答を模した商品マスタ（単価・商品名の出典） */
const PRODUCTS: CatalogProductView[] = [
  {
    sku: SKU_ETH,
    name: "エチオピア イルガチェフェ 中煎り 200g",
    price: 1_800,
    origin: "エチオピア イルガチェフェ G1",
    roast: "ミディアム",
    size: "200g",
  },
  {
    sku: SKU_COL,
    name: "コロンビア スプレモ 深煎り 500g",
    price: 3_600,
    origin: "コロンビア スプレモ EP",
    roast: "フレンチ",
    size: "500g",
  },
  {
    sku: SKU_KEN,
    // 端数の切り捨てを確かめるため 1% で小数になる単価にしている
    name: "ケニア AA 浅煎り 100g",
    price: 1_250,
    origin: "ケニア AA トップ",
    roast: "シティ",
    size: "100g",
  },
];

/** `GET /catalog` のポイント付与率（`catalog.ts` の `POINT_RATE`） */
const POINT_RATE = 0.01;

describe("addCartLine", () => {
  it("新しい SKU は末尾に追加する（追加した順に並ぶ）", () => {
    const lines = addCartLine(addCartLine([], SKU_ETH), SKU_COL);

    expect(lines).toEqual([
      { sku: SKU_ETH, qty: 1 },
      { sku: SKU_COL, qty: 1 },
    ]);
  });

  it("同じ SKU は数量を加算し、明細を重複させない（要件 3.2）", () => {
    const lines = addCartLine(addCartLine(addCartLine([], SKU_ETH), SKU_ETH, 3), SKU_ETH);

    expect(lines).toEqual([{ sku: SKU_ETH, qty: 5 }]);
  });

  it("加算しても並び順は変わらない（先に入れた行が動かない）", () => {
    const initial: CartLine[] = [
      { sku: SKU_ETH, qty: 1 },
      { sku: SKU_COL, qty: 1 },
    ];

    expect(addCartLine(initial, SKU_ETH)).toEqual([
      { sku: SKU_ETH, qty: 2 },
      { sku: SKU_COL, qty: 1 },
    ]);
  });

  it("数量は 1 以上の整数に丸める", () => {
    expect(addCartLine([], SKU_ETH, 0)).toEqual([{ sku: SKU_ETH, qty: MIN_CART_QTY }]);
    expect(addCartLine([], SKU_ETH, -5)).toEqual([{ sku: SKU_ETH, qty: MIN_CART_QTY }]);
    expect(addCartLine([], SKU_ETH, 2.7)).toEqual([{ sku: SKU_ETH, qty: 2 }]);
    expect(addCartLine([], SKU_ETH, Number.NaN)).toEqual([{ sku: SKU_ETH, qty: MIN_CART_QTY }]);
  });

  it("上限（MAX_ITEM_QTY）で止める（要件 3.8）", () => {
    // 追加を押し続けても上限を超えない
    expect(addCartLine([{ sku: SKU_ETH, qty: MAX_ITEM_QTY }], SKU_ETH)).toEqual([
      { sku: SKU_ETH, qty: MAX_ITEM_QTY },
    ]);
    expect(addCartLine([{ sku: SKU_ETH, qty: MAX_ITEM_QTY - 1 }], SKU_ETH, 10)).toEqual([
      { sku: SKU_ETH, qty: MAX_ITEM_QTY },
    ]);
    expect(addCartLine([], SKU_ETH, MAX_ITEM_QTY + 50)).toEqual([
      { sku: SKU_ETH, qty: MAX_ITEM_QTY },
    ]);
  });

  it("SKU の前後の空白を落とし、同じ商品として扱う", () => {
    expect(addCartLine([{ sku: SKU_ETH, qty: 1 }], ` ${SKU_ETH} `)).toEqual([
      { sku: SKU_ETH, qty: 2 },
    ]);
  });

  it("空の SKU では何も追加しない", () => {
    expect(addCartLine([], "")).toEqual([]);
    expect(addCartLine([{ sku: SKU_ETH, qty: 1 }], "   ")).toEqual([{ sku: SKU_ETH, qty: 1 }]);
  });

  it("引数のカートを書き換えない", () => {
    const initial: CartLine[] = [{ sku: SKU_ETH, qty: 1 }];

    const next = addCartLine(initial, SKU_ETH, 2);

    expect(initial).toEqual([{ sku: SKU_ETH, qty: 1 }]);
    expect(next).not.toBe(initial);
  });
});

describe("setCartLineQty", () => {
  it("数量を置き換える（要件 3.3）", () => {
    const lines = setCartLineQty(
      [
        { sku: SKU_ETH, qty: 1 },
        { sku: SKU_COL, qty: 2 },
      ],
      SKU_ETH,
      7
    );

    expect(lines).toEqual([
      { sku: SKU_ETH, qty: 7 },
      { sku: SKU_COL, qty: 2 },
    ]);
  });

  it("1 未満・非整数は 1 以上の整数に丸める", () => {
    expect(setCartLineQty([{ sku: SKU_ETH, qty: 5 }], SKU_ETH, 0)).toEqual([
      { sku: SKU_ETH, qty: MIN_CART_QTY },
    ]);
    expect(setCartLineQty([{ sku: SKU_ETH, qty: 5 }], SKU_ETH, 3.9)).toEqual([
      { sku: SKU_ETH, qty: 3 },
    ]);
    expect(setCartLineQty([{ sku: SKU_ETH, qty: 5 }], SKU_ETH, Number.NaN)).toEqual([
      { sku: SKU_ETH, qty: MIN_CART_QTY },
    ]);
  });

  it("上限では丸めない（入力した値をそのまま残す。指摘は送信前に出す）", () => {
    // `addCartLine` と非対称なのは意図的である
    expect(setCartLineQty([{ sku: SKU_ETH, qty: 1 }], SKU_ETH, MAX_ITEM_QTY + 1)).toEqual([
      { sku: SKU_ETH, qty: MAX_ITEM_QTY + 1 },
    ]);
  });

  it("カートに無い SKU では行を増やさない", () => {
    expect(setCartLineQty([{ sku: SKU_ETH, qty: 1 }], SKU_COL, 3)).toEqual([
      { sku: SKU_ETH, qty: 1 },
    ]);
    expect(setCartLineQty([], SKU_ETH, 3)).toEqual([]);
  });

  it("引数のカートを書き換えない", () => {
    const initial: CartLine[] = [{ sku: SKU_ETH, qty: 1 }];

    setCartLineQty(initial, SKU_ETH, 9);

    expect(initial).toEqual([{ sku: SKU_ETH, qty: 1 }]);
  });
});

describe("removeCartLine", () => {
  it("指定した明細だけを消す（要件 3.4）", () => {
    const lines = removeCartLine(
      [
        { sku: SKU_ETH, qty: 1 },
        { sku: SKU_COL, qty: 2 },
      ],
      SKU_ETH
    );

    expect(lines).toEqual([{ sku: SKU_COL, qty: 2 }]);
  });

  it("カートに無い SKU を指定しても失敗しない", () => {
    expect(removeCartLine([{ sku: SKU_ETH, qty: 1 }], SKU_COL)).toEqual([
      { sku: SKU_ETH, qty: 1 },
    ]);
    expect(removeCartLine([], SKU_ETH)).toEqual([]);
  });

  it("引数のカートを書き換えない", () => {
    const initial: CartLine[] = [{ sku: SKU_ETH, qty: 1 }];

    expect(removeCartLine(initial, SKU_ETH)).toEqual([]);
    expect(initial).toEqual([{ sku: SKU_ETH, qty: 1 }]);
  });
});

describe("readCartQtyInput", () => {
  it("1 以上の整数を読む", () => {
    expect(readCartQtyInput("1")).toBe(1);
    expect(readCartQtyInput("42")).toBe(42);
    expect(readCartQtyInput(" 7 ")).toBe(7);
    expect(readCartQtyInput("007")).toBe(7);
  });

  it("上限超過も読む（カートに入れてから送信前に指摘する。要件 3.8）", () => {
    expect(readCartQtyInput(String(MAX_ITEM_QTY + 1))).toBe(MAX_ITEM_QTY + 1);
  });

  it("数量として読めない値は null にする（入力途中を反映しない）", () => {
    expect(readCartQtyInput("")).toBeNull();
    expect(readCartQtyInput("   ")).toBeNull();
    expect(readCartQtyInput("0")).toBeNull();
    expect(readCartQtyInput("-1")).toBeNull();
    expect(readCartQtyInput("1.5")).toBeNull();
    expect(readCartQtyInput("2個")).toBeNull();
    expect(readCartQtyInput("1e3")).toBeNull();
  });
});

describe("cartLineDraftId", () => {
  it("DOM id に使えない文字をハイフンに置き換える", () => {
    expect(cartLineDraftId(SKU_ETH)).toBe("cart-ITEM-ETH-YIRG-G1-MEDIUM-200G");
    expect(cartLineDraftId(` ${SKU_ETH} `)).toBe("cart-ITEM-ETH-YIRG-G1-MEDIUM-200G");
  });

  it("異なる SKU は異なる id になる", () => {
    expect(cartLineDraftId(SKU_ETH)).not.toBe(cartLineDraftId(SKU_COL));
  });
});

describe("toOrderLineDrafts", () => {
  it("既存の明細形式に変換する（要件 3.7）", () => {
    const drafts = toOrderLineDrafts([
      { sku: SKU_ETH, qty: 2 },
      { sku: SKU_COL, qty: 1 },
    ]);

    expect(drafts).toEqual([
      { id: cartLineDraftId(SKU_ETH), sku: SKU_ETH, qty: "2" },
      { id: cartLineDraftId(SKU_COL), sku: SKU_COL, qty: "1" },
    ]);
  });

  it("空のカートは空の明細になる", () => {
    expect(toOrderLineDrafts([])).toEqual([]);
  });
});

describe("buildCartOrderDraft", () => {
  it("商品マスタの単価で明細を組み立てる（要件 3.7）", () => {
    const result = buildCartOrderDraft(
      [
        { sku: SKU_ETH, qty: 2 },
        { sku: SKU_COL, qty: 1 },
      ],
      PRODUCTS
    );

    expect(result.ok).toBe(true);
    expect(result.items).toEqual([
      { sku: SKU_ETH, qty: 2, price: 1_800 },
      { sku: SKU_COL, qty: 1, price: 3_600 },
    ]);
    expect(result.totalAmount).toBe(7_200);
    expect(result.lineIssues).toEqual([]);
  });

  it("空のカートはフォーム全体の指摘になる（要件 3.6）", () => {
    const result = buildCartOrderDraft([], PRODUCTS);

    expect(result.ok).toBe(false);
    expect(result.formIssue).not.toBeNull();
  });

  it("上限を超えた数量を送信前に指摘する（要件 3.8）", () => {
    const lines = setCartLineQty([{ sku: SKU_ETH, qty: 1 }], SKU_ETH, MAX_ITEM_QTY + 1);

    const result = buildCartOrderDraft(lines, PRODUCTS);

    expect(result.ok).toBe(false);
    expect(findLineIssue(result.lineIssues, cartLineDraftId(SKU_ETH), "qty")).toContain(
      String(MAX_ITEM_QTY)
    );
    expect(result.items).toEqual([]);
  });

  it("商品マスタに無い SKU を指摘する", () => {
    const result = buildCartOrderDraft([{ sku: "ITEM#UNKNOWN", qty: 1 }], PRODUCTS);

    expect(result.ok).toBe(false);
    expect(findLineIssue(result.lineIssues, cartLineDraftId("ITEM#UNKNOWN"), "sku")).toContain(
      "商品マスタにない"
    );
  });

  it("カートの不変条件により SKU 重複の指摘は出ない（要件 3.2）", () => {
    const lines = addCartLine(addCartLine([], SKU_ETH), SKU_ETH);

    const result = buildCartOrderDraft(lines, PRODUCTS);

    expect(result.ok).toBe(true);
    expect(result.items).toEqual([{ sku: SKU_ETH, qty: 2, price: 1_800 }]);
  });
});

describe("summarizeCart", () => {
  it("合計金額と獲得予定ポイントを算出する（要件 3.3 / 3.5）", () => {
    const summary = summarizeCart(
      [
        { sku: SKU_ETH, qty: 2 },
        { sku: SKU_COL, qty: 1 },
      ],
      PRODUCTS,
      POINT_RATE
    );

    expect(summary.lineCount).toBe(2);
    expect(summary.totalQty).toBe(3);
    expect(summary.totalAmount).toBe(7_200);
    expect(summary.pointEarned).toBe(72);
    expect(summary.hasUnknownSku).toBe(false);
    expect(summary.hasQtyOverMax).toBe(false);
  });

  it("明細ごとに商品名・単価・小計を引く", () => {
    const summary = summarizeCart([{ sku: SKU_ETH, qty: 3 }], PRODUCTS, POINT_RATE);

    expect(summary.lines).toEqual([
      {
        sku: SKU_ETH,
        name: "エチオピア イルガチェフェ 中煎り 200g",
        price: 1_800,
        qty: 3,
        subtotal: 5_400,
        qtyOverMax: false,
      },
    ]);
  });

  it("数量を変えると合計とポイントが再計算される（要件 3.3）", () => {
    const before = summarizeCart([{ sku: SKU_ETH, qty: 1 }], PRODUCTS, POINT_RATE);
    const after = summarizeCart(
      setCartLineQty([{ sku: SKU_ETH, qty: 1 }], SKU_ETH, 4),
      PRODUCTS,
      POINT_RATE
    );

    expect(before.totalAmount).toBe(1_800);
    expect(before.pointEarned).toBe(18);
    expect(after.totalAmount).toBe(7_200);
    expect(after.pointEarned).toBe(72);
  });

  it("ポイントは円未満を切り捨てる（Lambda 側の calculatePoints と同じ）", () => {
    // 1_250 × 1% = 12.5
    const summary = summarizeCart([{ sku: SKU_KEN, qty: 1 }], PRODUCTS, POINT_RATE);

    expect(summary.totalAmount).toBe(1_250);
    expect(summary.pointEarned).toBe(12);
  });

  it("付与率が未取得ならポイントは null にする（概算を出さない）", () => {
    expect(summarizeCart([{ sku: SKU_ETH, qty: 1 }], PRODUCTS, null).pointEarned).toBeNull();
    expect(summarizeCart([{ sku: SKU_ETH, qty: 1 }], PRODUCTS, -0.1).pointEarned).toBeNull();
    expect(
      summarizeCart([{ sku: SKU_ETH, qty: 1 }], PRODUCTS, Number.NaN).pointEarned
    ).toBeNull();
  });

  it("空のカートは 0 件・0 円で、注文操作の無効化に使える（要件 3.6）", () => {
    const summary = summarizeCart([], PRODUCTS, POINT_RATE);

    expect(summary.lines).toEqual([]);
    expect(summary.lineCount).toBe(0);
    expect(summary.totalQty).toBe(0);
    expect(summary.totalAmount).toBe(0);
    expect(summary.pointEarned).toBe(0);
  });

  it("商品マスタに無い SKU は金額を出さず合計にも混ぜない", () => {
    const summary = summarizeCart(
      [
        { sku: SKU_ETH, qty: 1 },
        { sku: "ITEM#UNKNOWN", qty: 2 },
      ],
      PRODUCTS,
      POINT_RATE
    );

    expect(summary.hasUnknownSku).toBe(true);
    expect(summary.lines[1]).toMatchObject({ name: null, price: null, subtotal: null });
    // 0 円として混ぜると引けなかったことが読めなくなる
    expect(summary.totalAmount).toBe(1_800);
    // 数量の合計には含める（カートに行として残っている）
    expect(summary.totalQty).toBe(3);
  });

  it("上限超過の明細を行単位と全体の両方で知らせる（要件 3.8）", () => {
    const lines = setCartLineQty(
      [
        { sku: SKU_ETH, qty: 1 },
        { sku: SKU_COL, qty: 1 },
      ],
      SKU_COL,
      MAX_ITEM_QTY + 1
    );

    const summary = summarizeCart(lines, PRODUCTS, POINT_RATE);

    expect(summary.hasQtyOverMax).toBe(true);
    expect(summary.lines[0]?.qtyOverMax).toBe(false);
    expect(summary.lines[1]?.qtyOverMax).toBe(true);
  });

  it("上限ちょうどは超過にしない", () => {
    const summary = summarizeCart(
      [{ sku: SKU_ETH, qty: MAX_ITEM_QTY }],
      PRODUCTS,
      POINT_RATE
    );

    expect(summary.hasQtyOverMax).toBe(false);
  });

  it("商品マスタが空でも例外にせず、引けないことを知らせる", () => {
    const summary = summarizeCart([{ sku: SKU_ETH, qty: 1 }], [], POINT_RATE);

    expect(summary.hasUnknownSku).toBe(true);
    expect(summary.totalAmount).toBe(0);
  });

  it("引数のカートと商品マスタを書き換えない", () => {
    const lines: CartLine[] = [{ sku: SKU_ETH, qty: 2 }];
    const products = [...PRODUCTS];

    summarizeCart(lines, products, POINT_RATE);

    expect(lines).toEqual([{ sku: SKU_ETH, qty: 2 }]);
    expect(products).toEqual(PRODUCTS);
  });
});
