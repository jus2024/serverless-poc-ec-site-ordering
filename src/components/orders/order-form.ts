/**
 * 手動投入フォームの入力検証（純粋関数。要件 14.1 / 14.2）。
 *
 * ## 上限値を Lambda 側と重複させている
 *
 * `amplify/functions/order-accept/order-request.ts` と
 * `amplify/functions/inventory-seed/seed-plan.ts` に同じ上限がある。
 * `src/lib/orders/types.ts` と同じ理由で **import しない**（要件 18.6）。
 * 画面側の検証は「送る前に気づけるようにする」ためのものであり、
 * 拒否の権限は API 側にある。`api.ts` が `UNKNOWN_SKU` を返した場合は
 * 画面もそれに従う（`order-api-failure.ts`）。
 *
 * **API 側の上限を変えたときはここも更新すること。**
 *
 * ## 単価をフォームで持たない
 *
 * 明細の単価は商品マスタ（`GET /catalog`）の値をそのまま使う（要件 3.5）。
 * 画面で単価を編集できるようにしても、API 側は商品マスタの単価で
 * 組み直すため（`order-request.ts`）、入力欄と実際の注文が食い違う。
 */

import type { CatalogProductView, OrderItem } from "../../lib/orders/types";

/** 明細数の上限（`order-request.ts` の `MAX_ORDER_ITEMS`） */
export const MAX_ORDER_ITEMS = 100;

/** 1 明細の数量の上限（`order-request.ts` の `MAX_ITEM_QTY`） */
export const MAX_ITEM_QTY = 100;

/** ID の長さの上限（`order-keys.ts` の `MAX_ID_LENGTH`） */
export const MAX_ID_LENGTH = 128;

/** 在庫数の上限（`seed-plan.ts` の `MAX_INITIAL_QUANTITY`） */
export const MAX_INITIAL_QUANTITY = 1_000_000_000;

/** 在庫数の既定値（`seed-plan.ts` の `DEFAULT_INITIAL_QUANTITY`）。入力欄の案内に使う */
export const DEFAULT_INITIAL_QUANTITY = 10_000_000;

/**
 * 入力欄 1 つ分の解析結果。
 *
 * 失敗を例外ではなく値で返すのは、複数の欄をまとめて検証して
 * 「すべての誤りを一度に」表示するためである。1 件目で例外を投げると
 * 検証者は誤りを 1 つずつ潰すことになる。
 */
export type ParsedField<T> = { ok: true; value: T } | { ok: false; issue: string };

// ─── 明細 ────────────────────────────────────────────────────────

/** 明細 1 行の入力状態 */
export interface OrderLineDraft {
  /** 行の識別子。React の key と入力欄の DOM id に使う */
  id: string;
  /** 選択された SKU。未選択なら空文字 */
  sku: string;
  /** 数量の入力値（生の文字列） */
  qty: string;
}

/** 明細の入力欄に紐づく指摘 */
export interface OrderLineIssue {
  lineId: string;
  field: "sku" | "qty";
  message: string;
}

/** 明細全体の検証結果 */
export interface OrderDraftResult {
  ok: boolean;
  /** 送信する明細。`ok` が false なら空 */
  items: OrderItem[];
  /** 入力欄に紐づく指摘（`aria-describedby` で結びつける） */
  lineIssues: OrderLineIssue[];
  /** フォーム全体に対する指摘（行数など）。無ければ null */
  formIssue: string | null;
  /** 明細の合計金額。`ok` が false なら 0 */
  totalAmount: number;
}

/**
 * 明細の入力を検証し、送信用の `OrderItem[]` を組み立てる。
 *
 * 検証の順序は「行数 → 各行（SKU → 数量）→ SKU の重複」。
 * 1 件目の誤りで打ち切らず、すべての行の指摘を集めて返す。
 *
 * 同一 SKU の重複を弾くのは、引当が全明細を 1 つの
 * `TransactWriteItems` で処理する（要件 5.1）ため、同じキーが 2 回現れると
 * DynamoDB がトランザクションごと拒否するからである。API 側も
 * 同じ理由で 400 を返す（`order-request.ts`）。
 *
 * @param lines 入力中の明細
 * @param products `GET /catalog` で取得した商品マスタ（単価の出典）
 */
export function buildOrderDraft(
  lines: readonly OrderLineDraft[],
  products: readonly CatalogProductView[]
): OrderDraftResult {
  const priceBySku = new Map<string, number>();
  for (const product of products) {
    priceBySku.set(product.sku, product.price);
  }

  const lineIssues: OrderLineIssue[] = [];
  const items: OrderItem[] = [];
  const seenSkus = new Set<string>();

  if (lines.length === 0) {
    return {
      ok: false,
      items: [],
      lineIssues,
      formIssue: "明細を 1 行以上追加してください。",
      totalAmount: 0,
    };
  }

  let formIssue: string | null = null;
  if (lines.length > MAX_ORDER_ITEMS) {
    formIssue = `明細は ${MAX_ORDER_ITEMS} 行までです（現在 ${lines.length} 行）。`;
  }

  for (const line of lines) {
    const sku = line.sku.trim();
    const price = priceBySku.get(sku);
    let skuOk = false;

    if (sku === "") {
      lineIssues.push({ lineId: line.id, field: "sku", message: "商品を選択してください。" });
    } else if (price === undefined) {
      lineIssues.push({
        lineId: line.id,
        field: "sku",
        message: "商品マスタにない SKU です。商品マスタを再読み込みしてください。",
      });
    } else if (seenSkus.has(sku)) {
      // 重複は後から現れた行を指摘する（先の行を消させないため）
      lineIssues.push({
        lineId: line.id,
        field: "sku",
        message: "同じ商品が重複しています。1 商品につき 1 行にまとめてください。",
      });
    } else {
      skuOk = true;
      seenSkus.add(sku);
    }

    const qty = parseQtyInput(line.qty);
    if (!qty.ok) {
      lineIssues.push({ lineId: line.id, field: "qty", message: qty.issue });
    }

    // 単価は商品マスタの値（要件 3.5）。`price !== undefined` は skuOk に含まれる
    if (skuOk && qty.ok && price !== undefined) {
      items.push({ sku, qty: qty.value, price });
    }
  }

  const ok = formIssue === null && lineIssues.length === 0;
  return {
    ok,
    items: ok ? items : [],
    lineIssues,
    formIssue,
    totalAmount: ok ? items.reduce((sum, item) => sum + item.qty * item.price, 0) : 0,
  };
}

/** 明細の指摘を引く。入力欄のエラー表示に使う */
export function findLineIssue(
  issues: readonly OrderLineIssue[],
  lineId: string,
  field: OrderLineIssue["field"]
): string | null {
  const issue = issues.find((entry) => entry.lineId === lineId && entry.field === field);
  return issue === undefined ? null : issue.message;
}

/** 数量の入力を検証する（1〜`MAX_ITEM_QTY` の整数） */
export function parseQtyInput(raw: string): ParsedField<number> {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, issue: "数量を入力してください。" };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, issue: "数量は整数で入力してください。" };
  }
  const value = Number(trimmed);
  if (value < 1) {
    return { ok: false, issue: "数量は 1 以上で入力してください。" };
  }
  if (value > MAX_ITEM_QTY) {
    return { ok: false, issue: `数量は ${MAX_ITEM_QTY} までです。` };
  }
  return { ok: true, value };
}

// ─── 顧客 ID ─────────────────────────────────────────────────────

/**
 * 顧客 ID の入力を検証する。
 *
 * 未入力は「未指定」として `undefined` を返す。API は `customerId` 未指定で
 * テスト顧客を割り当てる（要件 1.3）が、空文字を送ると 400 になる
 * （`order-request.ts` の `readOptionalId`）ため、空文字は送らない。
 */
export function parseCustomerIdInput(raw: string): ParsedField<string | undefined> {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: true, value: undefined };
  }
  if (trimmed.length > MAX_ID_LENGTH) {
    return { ok: false, issue: `顧客 ID は ${MAX_ID_LENGTH} 文字までです。` };
  }
  return { ok: true, value: trimmed };
}

// ─── 初期在庫 ────────────────────────────────────────────────────

/**
 * 初期在庫数の入力を検証する（要件 14.2）。
 *
 * 未入力は「未指定」として `undefined` を返し、API 側の既定値
 * （`DEFAULT_INITIAL_QUANTITY`）に委ねる。0 を許すのは、在庫不足
 * （要件 5.3）を意図的に起こす検証に使うためである。
 */
export function parseInitialQuantityInput(raw: string): ParsedField<number | undefined> {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: true, value: undefined };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, issue: "在庫数は 0 以上の整数で入力してください。" };
  }
  const value = Number(trimmed);
  if (value > MAX_INITIAL_QUANTITY) {
    return { ok: false, issue: `在庫数は ${MAX_INITIAL_QUANTITY} までです。` };
  }
  return { ok: true, value };
}

// ─── 注文 ID ─────────────────────────────────────────────────────

/**
 * 照会する注文 ID の入力を検証する（要件 14.4）。
 *
 * 形式（`ORD#{ULID}`。要件 1.4）までは検査しない。手で組み立てた ID や
 * 将来の形式変更を画面側で先に弾くと、API が 404 を返すのか
 * 画面が弾いたのかが分からなくなる。空文字だけを弾く。
 */
export function parseOrderIdInput(raw: string): ParsedField<string> {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, issue: "注文 ID を入力してください。" };
  }
  if (trimmed.length > MAX_ID_LENGTH) {
    return { ok: false, issue: `注文 ID は ${MAX_ID_LENGTH} 文字までです。` };
  }
  return { ok: true, value: trimmed };
}
