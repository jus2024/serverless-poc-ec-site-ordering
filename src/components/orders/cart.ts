/**
 * カートの状態遷移と金額の算出（純粋関数。要件 3.1〜3.5 / 3.7）。
 *
 * ## なぜコンポーネントから切り出すか
 *
 * `order-progress.ts` と同じ方針である。Vitest は `environment: "node"` のまま
 * 使いたいので、「同じ商品を追加したら数量が増える」「合計と獲得予定ポイントを
 * どう出すか」といった判断を DOM に依存しない関数として `CartPanel` の外に置き、
 * 単体テストで固定する（design §5）。
 *
 * ## カートは API に送らない
 *
 * カートは画面上の状態でしかない（design §2.3）。注文時は
 * {@link toOrderLineDrafts} で既存の明細形式（`OrderLineDraft[]`）に変換し、
 * 検証は `order-form.ts` の `buildOrderDraft` に委ねる（要件 3.7）。
 * **このモジュールに検証を書き足さない。** 数量の範囲・SKU の重複・明細数の上限は
 * すでに `buildOrderDraft` が持っており、二重に持つと片方だけを直したときに
 * 画面と API の判断が食い違う（非機能要件 3）。
 *
 * ## 単価とポイント付与率をカートで持たない
 *
 * どちらも商品マスタ（`GET /catalog`）から引数で受け取る。`order-form.ts` が
 * 単価をフォームで持たないのと同じ理由で、API 側は商品マスタの単価で
 * 注文を組み直すため（`order-request.ts`）、画面が別の値を持つと表示と実際が
 * 食い違う。獲得予定ポイントも**概算表示**であり、確定値は
 * `GET /orders/{orderId}` の `pointEarned` が出典である。
 */

import type { CatalogProductView } from "../../lib/orders/types";

import {
  MAX_ITEM_QTY,
  buildOrderDraft,
  type OrderDraftResult,
  type OrderLineDraft,
} from "./order-form";

/**
 * 数量の下限。
 *
 * 0 以下の明細をカートに残さない。数量 0 を「消えた明細」として扱うと、
 * 合計には出ないのに行が残る状態になる。削除は
 * {@link removeCartLine} で明示的に行う（要件 3.4）。
 */
export const MIN_CART_QTY = 1;

/**
 * カートの明細 1 件。
 *
 * SKU ごとに 1 行で、同じ SKU が 2 行に分かれることはない（要件 3.2）。
 * この不変条件があるおかげで `buildOrderDraft` にはユニークな SKU だけが渡り、
 * 既存の「同一 SKU の重複はエラー」と矛盾しない（design §2.3）。
 */
export interface CartLine {
  /** 商品 SKU（例: ITEM#ETH-YIRG-G1-MEDIUM-200G） */
  sku: string;
  /** 数量（1 以上の整数） */
  qty: number;
}

// ─── 状態遷移 ────────────────────────────────────────────────────

/**
 * カートに商品を加える（要件 3.1 / 3.2）。
 *
 * すでに同じ SKU があれば数量を加算し、行は増やさない。
 * 加算した結果が `MAX_ITEM_QTY` を超える場合は上限で止める。
 * 「カートに追加」を押し続けて上限超過の状態を作り、注文時に初めて
 * 指摘されるより、追加が止まるほうが操作と結果が近い（要件 3.8）。
 *
 * 新しい SKU は末尾に足す。追加した順に並べることで、直前に足した商品が
 * どこに入ったかを追える。
 *
 * @param lines 現在のカート
 * @param sku 追加する商品の SKU。空文字なら何もしない
 * @param qty 追加する数量。既定は 1。1 未満・非整数は 1 に丸める
 */
export function addCartLine(
  lines: readonly CartLine[],
  sku: string,
  qty: number = MIN_CART_QTY
): CartLine[] {
  const trimmed = sku.trim();
  if (trimmed === "") {
    return [...lines];
  }

  const delta = normalizeQty(qty);
  const existing = lines.find((line) => line.sku === trimmed);
  if (existing === undefined) {
    return [...lines, { sku: trimmed, qty: Math.min(delta, MAX_ITEM_QTY) }];
  }

  return lines.map((line) =>
    line.sku === trimmed ? { sku: line.sku, qty: Math.min(line.qty + delta, MAX_ITEM_QTY) } : line
  );
}

/**
 * 明細の数量を置き換える（要件 3.3）。
 *
 * 上限で丸めないのは、直接入力した値をそのまま画面に残すためである。
 * 入力欄の検証は `order-form.ts` の `parseQtyInput` が担い、上限超過は
 * 送信前に `buildOrderDraft` が指摘する（要件 3.8）。ここで黙って
 * 丸めると、入力した数量と表示が食い違う。
 *
 * カートに無い SKU を指定した場合は何もしない（削除済みの行に対する
 * 操作が届いたときに、行が復活しないようにする）。
 *
 * @param qty 新しい数量。1 未満・非整数は 1 に丸める
 */
export function setCartLineQty(
  lines: readonly CartLine[],
  sku: string,
  qty: number
): CartLine[] {
  const trimmed = sku.trim();
  return lines.map((line) =>
    line.sku === trimmed ? { sku: line.sku, qty: normalizeQty(qty) } : line
  );
}

/** 明細を削除する（要件 3.4）。無い SKU を指定しても失敗しない */
export function removeCartLine(lines: readonly CartLine[], sku: string): CartLine[] {
  const trimmed = sku.trim();
  return lines.filter((line) => line.sku !== trimmed);
}

/**
 * 数量入力欄の生の値を、カートに反映できる数量として読む（要件 3.3 / 3.8）。
 *
 * `order-form.ts` の `parseQtyInput` を使わないのは、上限（`MAX_ITEM_QTY`）を
 * 超えた値も**いったんカートに入れたい**ためである。上限で弾いて反映しないと
 * {@link summarizeCart} の `hasQtyOverMax` が立たず、「送信前に気づけるように
 * する」（要件 3.8）表示を出せない。`setCartLineQty` が上限で丸めないのと
 * 同じ理由である。
 *
 * 上限超過の**指摘の文言**は `parseQtyInput` のものをそのまま使う（`CartPanel`）。
 * ここは「数量として読めるか」だけを返し、良し悪しの判断を持たない。
 *
 * @param raw 入力欄の生の文字列
 * @returns 1 以上の整数として読めれば数値、読めなければ null
 */
export function readCartQtyInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return value < MIN_CART_QTY ? null : value;
}

/**
 * 数量を 1 以上の整数に整える。
 *
 * 上限は掛けない（{@link addCartLine} と {@link setCartLineQty} が
 * それぞれの理由で判断する）。
 */
function normalizeQty(qty: number): number {
  if (!Number.isFinite(qty)) {
    return MIN_CART_QTY;
  }
  return Math.max(MIN_CART_QTY, Math.floor(qty));
}

// ─── 既存の明細検証へ渡す ──────────────────────────────────────────

/**
 * `OrderLineDraft` の行 id を SKU から作る。
 *
 * 行 id は React の key と入力欄の DOM id に使われる（`order-form.ts`）。
 * SKU は `ITEM#...` の形で `#` を含み、そのまま DOM id にすると
 * CSS セレクタや `querySelector` で扱えない。英数・ハイフン・下線以外を
 * ハイフンに置き換える。SKU で置換対象になるのは `#` だけなので、
 * 別の SKU と衝突することはない（`catalog.ts` の SKU は大文字英数とハイフン）。
 */
export function cartLineDraftId(sku: string): string {
  return `cart-${sku.trim().replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/**
 * カートを既存の明細形式に変換する（要件 3.7）。
 *
 * 数量を文字列にするのは `OrderLineDraft` が入力欄の生の値を持つ形だからで、
 * ここでは常に整数の文字列になる。
 */
export function toOrderLineDrafts(lines: readonly CartLine[]): OrderLineDraft[] {
  return lines.map((line) => ({
    id: cartLineDraftId(line.sku),
    sku: line.sku,
    qty: String(line.qty),
  }));
}

/**
 * カートを変換して既存の検証にかける（要件 3.7 / 3.8）。
 *
 * 変換と検証を 1 つにしているのは、注文時に必ずこの順で使うためである
 * （design §2.4）。検証そのものは `buildOrderDraft` に委ねており、
 * このモジュールは判断を持たない。
 */
export function buildCartOrderDraft(
  lines: readonly CartLine[],
  products: readonly CatalogProductView[]
): OrderDraftResult {
  return buildOrderDraft(toOrderLineDrafts(lines), products);
}

// ─── 表示用の集計 ─────────────────────────────────────────────────

/** カートの明細 1 行の表示用データ */
export interface CartLineView {
  sku: string;
  /** 商品名。商品マスタに無い SKU なら null */
  name: string | null;
  /** 税込単価。商品マスタに無い SKU なら null */
  price: number | null;
  qty: number;
  /** 小計（単価 × 数量）。単価を引けなければ null */
  subtotal: number | null;
  /** 上限（`MAX_ITEM_QTY`）を超えているか。入力欄の指摘に使う（要件 3.8） */
  qtyOverMax: boolean;
}

/** カート全体の表示用データ（要件 3.5） */
export interface CartSummary {
  lines: CartLineView[];
  /** 明細数（SKU の種類数）。0 なら注文操作を無効化する（要件 3.6） */
  lineCount: number;
  /** 数量の合計 */
  totalQty: number;
  /** 合計金額。単価を引けない明細は含めない */
  totalAmount: number;
  /**
   * 獲得予定ポイントの概算。付与率が未取得（商品マスタの読み込み前）なら null。
   *
   * 円未満切り捨ては Lambda 側の `calculatePoints`（`catalog.ts`）に合わせる。
   * 確定値は注文照会の `pointEarned` が出典である。
   */
  pointEarned: number | null;
  /** 商品マスタに無い SKU を含むか。商品マスタの再読み込みで消えた場合に起こる */
  hasUnknownSku: boolean;
  /** 上限を超えた数量の明細を含むか（要件 3.8） */
  hasQtyOverMax: boolean;
}

/**
 * カートの内容から表示用データを組み立てる（要件 3.3 / 3.5）。
 *
 * 単価は商品マスタから引く。商品マスタに無い SKU は金額を出さずに
 * `hasUnknownSku` で知らせる（合計に 0 円として混ぜると、
 * 引けなかったことが読めなくなる）。注文そのものは `buildOrderDraft` が
 * 同じ SKU を弾くので送信されない。
 *
 * @param lines 現在のカート
 * @param products `GET /catalog` の商品マスタ（単価と商品名の出典）
 * @param pointRate `GET /catalog` のポイント付与率。未取得なら null
 */
export function summarizeCart(
  lines: readonly CartLine[],
  products: readonly CatalogProductView[],
  pointRate: number | null
): CartSummary {
  const productBySku = new Map<string, CatalogProductView>();
  for (const product of products) {
    productBySku.set(product.sku, product);
  }

  const views: CartLineView[] = [];
  let totalQty = 0;
  let totalAmount = 0;
  let hasUnknownSku = false;
  let hasQtyOverMax = false;

  for (const line of lines) {
    const product = productBySku.get(line.sku);
    const price = product === undefined ? null : product.price;
    const subtotal = price === null ? null : price * line.qty;
    const qtyOverMax = line.qty > MAX_ITEM_QTY;

    views.push({
      sku: line.sku,
      name: product === undefined ? null : product.name,
      price,
      qty: line.qty,
      subtotal,
      qtyOverMax,
    });

    totalQty += line.qty;
    if (subtotal === null) {
      hasUnknownSku = true;
    } else {
      totalAmount += subtotal;
    }
    if (qtyOverMax) {
      hasQtyOverMax = true;
    }
  }

  return {
    lines: views,
    lineCount: views.length,
    totalQty,
    totalAmount,
    pointEarned: resolvePointEarned(totalAmount, pointRate),
    hasUnknownSku,
    hasQtyOverMax,
  };
}

/** 獲得予定ポイントを概算する（円未満切り捨て。`catalog.ts` の `calculatePoints` と同じ） */
function resolvePointEarned(totalAmount: number, pointRate: number | null): number | null {
  if (pointRate === null || !Number.isFinite(pointRate) || pointRate < 0) {
    return null;
  }
  return Math.floor(totalAmount * pointRate);
}
