/**
 * 商品グリッドの表示ヘルパー（純粋関数。絞り込み・国名表示・容量順）。
 *
 * 産地の絞り込み（要件 2.4 / 2.5）に加えて、カードの産地欄に出す
 * 国名の抽出（{@link originCountry}）と、グリッドの並べ替え
 * （容量→焙煎度→産地の {@link sortProductsForDisplay}、容量のみの {@link sortProductsBySize}）を
 * 持つ。いずれも表示専用で、`sku` / `price` / 注文処理には影響しない。
 *
 * ## なぜ `cart.ts` と別モジュールにするか
 *
 * 産地の絞り込みは「商品マスタをどう見せるか」の関心事であり、
 * カートの状態遷移（`cart.ts`）とは扱う状態が別である。カートは
 * `CartLine[]` を入力に取り、注文へ向かう。絞り込みは
 * `CatalogProductView[]` を入力に取り、表示する集合を狭めるだけで
 * 注文には影響しない。同じファイルに置くと `cart.ts` の
 * 「カートは API に送らない」という一貫した説明に、注文と無関係な
 * 関数が混ざる。`ProductGrid`（表示）と `CartPanel`（注文）が
 * それぞれ必要なものだけを import できるよう分けている。
 *
 * ## SKU 文字列を解釈しない
 *
 * 産地は商品マスタの `origin` フィールドから取る。SKU
 * （`ITEM#ETH-YIRG-G1-MEDIUM-200G`）を切り出して産地を推定する方式は
 * 採らない（案 Y の目的。要件 1 の背景）。SKU の構成が変わっても
 * この画面は壊れない。
 */

import type { CatalogProductView } from "../../lib/orders/types";

/**
 * 「すべて」を表す絞り込み値。
 *
 * 産地名と衝突しない値にしている（商品マスタの `origin` は
 * `catalog.ts` の `ORIGINS[].name` で、いずれも日本語の産地名）。
 * `null` や空文字ではなく明示的な値にするのは、`select` の
 * `value` にそのまま載せられる形にするためである。
 */
export const ORIGIN_FILTER_ALL = "__ALL__";

/**
 * 産地の絞り込み値。
 *
 * {@link ORIGIN_FILTER_ALL}（すべて）または商品マスタの `origin` の値。
 * 商品マスタの再読み込みで消えた産地が選ばれたままになる場合があるため、
 * {@link filterProductsByOrigin} は未知の値を「すべて」として扱う。
 */
export type OriginFilter = string;

/** 絞り込みセレクトの選択肢 1 件 */
export interface OriginFilterOption {
  /** `option` の value。{@link ORIGIN_FILTER_ALL} か産地名 */
  value: OriginFilter;
  /** 表示ラベル */
  label: string;
  /** その産地の商品件数。「すべて」は全件 */
  count: number;
}

/**
 * 商品マスタから産地の重複なし一覧を作る（要件 2.4）。
 *
 * 並び順は**商品マスタに現れた順**である。`catalog.ts` は
 * 産地 → 焙煎度 → 容量の順にループして SKU を生成するため、
 * 産地は `ORIGINS` の定義順に現れる。ここで五十音や
 * アルファベットに並べ替えると、商品マスタ側の意図した順序
 * （産地の並び）が画面から失われる。同じ入力からは常に同じ順序が
 * 返り、テストで固定できる。
 *
 * 空文字・空白だけの `origin` は選択肢にならないため除く
 * （API が属性を返さない古い版を相手にした場合に、空の選択肢が
 * 並ぶのを防ぐ）。
 */
export function listOrigins(products: readonly CatalogProductView[]): string[] {
  const origins: string[] = [];
  const seen = new Set<string>();

  for (const product of products) {
    const origin = product.origin.trim();
    if (origin === "" || seen.has(origin)) {
      continue;
    }
    seen.add(origin);
    origins.push(origin);
  }

  return origins;
}

/**
 * 絞り込みセレクトの選択肢を組み立てる（要件 2.4 / 2.5）。
 *
 * 先頭は常に「すべて」である（要件 2.5）。件数を添えるのは、
 * 240 件のうち何件に絞られるのかを選ぶ前に読めるようにするためで、
 * 表示に使うかは `ProductGrid` の判断に委ねる。
 */
export function buildOriginFilterOptions(
  products: readonly CatalogProductView[]
): OriginFilterOption[] {
  const countByOrigin = new Map<string, number>();
  for (const product of products) {
    const origin = product.origin.trim();
    if (origin === "") {
      continue;
    }
    countByOrigin.set(origin, (countByOrigin.get(origin) ?? 0) + 1);
  }

  const options: OriginFilterOption[] = [
    { value: ORIGIN_FILTER_ALL, label: "すべて", count: products.length },
  ];

  for (const origin of listOrigins(products)) {
    options.push({ value: origin, label: origin, count: countByOrigin.get(origin) ?? 0 });
  }

  return options;
}

/**
 * 選ばれた産地で商品を絞る（要件 2.4 / 2.5）。
 *
 * 商品マスタの並び順は保つ（絞り込みで並びが変わると、
 * 「すべて」に戻したときにカードの位置が動いて追えなくなる）。
 *
 * 「すべて」および商品マスタに無い産地は全件を返す。後者は
 * 商品マスタを再読み込みして産地が消えた場合に、0 件の画面で
 * 操作が詰まるのを避けるためである。
 */
export function filterProductsByOrigin(
  products: readonly CatalogProductView[],
  filter: OriginFilter
): CatalogProductView[] {
  const target = filter.trim();
  if (target === "" || target === ORIGIN_FILTER_ALL) {
    return [...products];
  }

  const matched = products.filter((product) => product.origin.trim() === target);
  return matched.length === 0 ? [...products] : matched;
}

/**
 * 産地の表示名から国名（先頭語）だけを取り出す（カードの産地欄用）。
 *
 * `origin` を trim し、最初の空白より前の語を返す。例:
 * 「エチオピア イルガチェフェ G1」→「エチオピア」、
 * 「ブラジル セラード スペシャルティ」→「ブラジル」。空文字（trim 後に
 * 空になる場合を含む）は空文字を返す。
 *
 * ## SKU 文字列を解釈しない
 *
 * 国名は `origin` フィールドの文字列だけから決める。SKU
 * （`ITEM#ETH-YIRG-G1-...`）の `ETH` を国名に読み替える方式は採らない
 * （案 Y の方針。要件 1 の背景）。SKU の構成が変わってもこの表示は壊れない。
 *
 * ## 全角スペースも区切りに含める
 *
 * `catalog.ts` の `origin`（`ORIGINS[].name`）は半角スペース区切りだが、
 * 商品マスタの表記揺れに備え、防御的に全角スペースも区切りとして扱う。
 * これにより「エチオピア　イルガチェフェ」のような入力でも国名だけを返せる。
 */
export function originCountry(origin: string): string {
  const trimmed = origin.trim();
  if (trimmed === "") {
    return "";
  }

  // 半角・全角どちらのスペースでも最初の区切りより前を国名とみなす。
  const [country] = trimmed.split(/[\s\u3000]+/);
  return country ?? "";
}

/** 容量表示名（正規化後）→ グラム換算値。想定内の 4 種を昇順に単調な整数に写す */
const SIZE_GRAMS: ReadonlyMap<string, number> = new Map([
  ["100g", 100],
  ["200g", 200],
  ["500g", 500],
  ["1kg", 1000],
]);

/**
 * 容量表示名を昇順に単調な整数（グラム換算）に写す（容量ソート用）。
 *
 * 100g→100 / 200g→200 / 500g→500 / 1kg→1000 を返す。文字列順で並べると
 * "100g" < "1kg" < "200g" となり容量の大小と一致しないため、数値に写してから
 * 比較する。想定外の表示名（マップに無い / 単位を解釈できない）は
 * `Number.MAX_SAFE_INTEGER` を返して末尾に送り、既存の相対順を壊さない。
 *
 * ## 単位の解釈
 *
 * 表示名を trim・小文字化して正規化し、`kg` は ×1000、`g` はそのままの
 * グラム数として解釈する（`1kg` = 1000）。まず既知の 4 種を引き、
 * 無ければ数値 + 単位のパターンで解釈を試みる。
 */
export function sizeSortKey(size: string): number {
  const normalized = size.trim().toLowerCase();

  const known = SIZE_GRAMS.get(normalized);
  if (known !== undefined) {
    return known;
  }

  // 「<数値><単位>」を解釈する（例: "750g" / "2kg"）。単位は g / kg のみ。
  const match = /^(\d+(?:\.\d+)?)\s*(kg|g)$/.exec(normalized);
  if (match) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) {
      return match[2] === "kg" ? value * 1000 : value;
    }
  }

  // 解釈できない表示名は末尾へ送る。
  return Number.MAX_SAFE_INTEGER;
}

/**
 * 商品を容量の昇順（100g → 200g → 500g → 1kg）に並べ替える（表示専用）。
 *
 * {@link sizeSortKey} をキーに安定昇順ソートした**新しい配列**を返す
 * （引数は破壊しない）。`Array.prototype.sort` は安定なので、同一容量内は
 * 入力順（`catalog.ts` の産地 → 焙煎度の順）を保つ。並べ替えは見え方だけで、
 * `sku` / `origin` / `price` は変えない。
 */
export function sortProductsBySize(
  products: readonly CatalogProductView[]
): CatalogProductView[] {
  return [...products].sort((a, b) => sizeSortKey(a.size) - sizeSortKey(b.size));
}

/** 焙煎度表示名（trim 後）→ 焙煎の浅い→深いの順位。順序の正は `catalog.ts` の `ROASTS` 定義順 */
const ROAST_ORDER: ReadonlyMap<string, number> = new Map([
  ["ライト", 0],
  ["ミディアム", 1],
  ["シティ", 2],
  ["フルシティ", 3],
  ["フレンチ", 4],
  ["イタリアン", 5],
]);

/**
 * 焙煎度表示名を焙煎の浅い→深いの順位（整数）に写す（焙煎度ソート用）。
 *
 * ライト=0 / ミディアム=1 / シティ=2 / フルシティ=3 / フレンチ=4 / イタリアン=5 を返す。
 * 順序の正は `catalog.ts` の `ROASTS` 定義順（焙煎の浅い順）である。想定外の表示名は
 * `Number.MAX_SAFE_INTEGER` を返して末尾に送り、既存の相対順を壊さない。
 *
 * ## SKU 文字列を解釈しない
 *
 * 焙煎度は商品マスタの `roast` フィールド（表示名。例「ミディアム」）から取る。SKU
 * （`ITEM#ETH-YIRG-G1-MEDIUM-200G`）の `MEDIUM` を焙煎度に読み替える方式は採らない
 * （案 Y の方針）。表示名を trim して既知の順序マップに写すため、SKU の構成が
 * 変わってもこの並びは壊れない。{@link sizeSortKey} と同じ書き方に倣う。
 */
export function roastSortKey(roast: string): number {
  const normalized = roast.trim();

  const rank = ROAST_ORDER.get(normalized);
  if (rank !== undefined) {
    return rank;
  }

  // 未知の焙煎度は末尾へ送る。
  return Number.MAX_SAFE_INTEGER;
}

/**
 * 商品を「容量 → 焙煎度 → 産地」の順に並べ替える（表示専用）。
 *
 * グリッド表示で使う並び。狙いは、同じ容量・同じ焙煎度の中で全産地が連続して
 * 並ぶことである。産地ごとに色分けしたプレースホルダ（`product-visual.ts`）は
 * 産地＝色トーンなので、こうすると横一列（約 4 列）ごとに産地＝色が変わり、
 * 1 画面でカラーバリエーションが見える（色トーンの割り当て自体は不変で、
 * 並び順だけで散らす）。
 *
 * ## 並びの仕様
 *
 * 1. 第 1 キー: 容量昇順（{@link sizeSortKey}。100g → 200g → 500g → 1kg）。
 *    想定外の容量は末尾に回る（`sizeSortKey` の挙動を引き継ぐ）。
 * 2. 第 2 キー: 焙煎度の浅い→深い（{@link roastSortKey}。ライト → … → イタリアン）。
 *    想定外の焙煎度は末尾に回る。
 * 3. 第 3 キー: 産地の出現順（`origin`）。**産地の順序は入力順を保つ**
 *    （`catalog.ts` の `ORIGINS` 定義順 = 商品マスタの生成順）。{@link listOrigins}
 *    が「出現順・重複なし・trim 済み」の産地一覧を返すので、これを産地の
 *    順序の基準に使う。未知の産地（空文字など）は末尾に送る。
 *
 * ## SKU 文字列を解釈しない
 *
 * 容量・焙煎度・産地はいずれも商品マスタの表示用フィールド（`size` / `roast` /
 * `origin`）から取る。SKU（`ITEM#ETH-YIRG-G1-MEDIUM-200G`）を切り出して推定する
 * 方式は採らない（案 Y の方針）。SKU の構成が変わってもこの並びは壊れない。
 *
 * ## 安定性
 *
 * 容量 → 焙煎度 → 産地を順にキーにした安定ソート（`Array.prototype.sort`）で
 * 実現する。3 キーがすべて同じ要素同士は入力順が保たれる。引数は破壊せず
 * **新しい配列**を返す。並べ替えは見え方だけで、`sku` / `origin` / `price` は変えない。
 */
export function sortProductsForDisplay(
  products: readonly CatalogProductView[]
): CatalogProductView[] {
  // 産地の出現順（入力順）をインデックスに写す。listOrigins は trim 済みなので
  // 比較キーも trim して揃える。未知の産地（空文字など）は末尾に送る。
  const originOrder = new Map<string, number>();
  listOrigins(products).forEach((origin, index) => {
    originOrder.set(origin, index);
  });

  const originRank = (origin: string): number =>
    originOrder.get(origin.trim()) ?? Number.MAX_SAFE_INTEGER;

  return [...products].sort((a, b) => {
    const sizeDiff = sizeSortKey(a.size) - sizeSortKey(b.size);
    if (sizeDiff !== 0) {
      return sizeDiff;
    }
    const roastDiff = roastSortKey(a.roast) - roastSortKey(b.roast);
    if (roastDiff !== 0) {
      return roastDiff;
    }
    return originRank(a.origin) - originRank(b.origin);
  });
}
