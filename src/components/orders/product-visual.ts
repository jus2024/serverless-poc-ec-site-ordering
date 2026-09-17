/**
 * 商品カードのプレースホルダ画像の色づけ（純粋関数。要件 2.3 / 6.2）。
 *
 * ## なぜ `product-filter.ts` と別モジュールにするか
 *
 * `product-filter.ts` は「どの商品を見せるか」（表示する集合）を決める。
 * こちらは「1 件をどう見せるか」（見た目）を決める。絞り込みは選択状態に
 * 依存し、色づけは商品の属性だけに依存する。同じファイルに置くと
 * 「SKU 文字列を解釈しない」という絞り込み側の説明に、注文にも絞り込みにも
 * 関与しない装飾の話が混ざる。`ProductGrid`（絞り込み）と
 * `ProductCard`（1 件の描画）が必要なものだけを import できるよう分けている。
 *
 * ## 生の色値を持たない（要件 6.2）
 *
 * このモジュールが返すのは `globals.css` に定義済みの **CSS 変数名** である。
 * `#6b4f3f` のような色そのものは書かない。理由は 2 つある。
 *
 * 1. ダークモードの対応が自動で効く。`globals.css` は
 *    `prefers-color-scheme: dark` でトークンの値を差し替えており、
 *    変数名を渡している限り明暗どちらでも読める色になる。
 * 2. 色の出典が `globals.css` の 1 箇所に固定される。
 *
 * ## 産地と色の対応をハッシュで決める理由
 *
 * 産地は `catalog.ts` の `ORIGINS` に 10 件あり、増減しうる。産地名 → 色の
 * 対応表を持つと、商品マスタに産地を足したときにこちらの表も直す必要があり、
 * 直し漏れると色が付かない産地が出る。産地名から決める方式なら
 * 商品マスタ側の増減に追従でき、**同じ産地には常に同じ色が付く**
 * （240 件を絞り込みで出し入れしてもカードの色が変わらない）。
 *
 * トークンの数（{@link PRODUCT_THUMB_TONES}）より産地が多いため、
 * 別の産地が同じ色になることはある。要件 2.3 は「産地に応じた色の
 * プレースホルダを出す」までで、色から産地を一意に読み取れることは
 * 求めていない（design §7 論点 1 で合意済み）。産地名はカードに文字で出る。
 */

/**
 * プレースホルダ 1 通りの配色。値は `globals.css` の CSS 変数名。
 *
 * 背景と前景（豆アイコン）を組で持つのは、片方だけを巡回させると
 * 背景と前景が同系色になる組み合わせが出て、アイコンが沈むためである。
 */
export interface ProductThumbTone {
  /** 背景に使う CSS 変数名（例: `--color-brand-light`） */
  background: string;
  /** 豆アイコンに使う CSS 変数名 */
  foreground: string;
}

/**
 * 巡回させる配色。値は `globals.css` の産地プレースホルダ専用トークン
 * （`--color-origin-*`）で、**生の色値は書かない**（要件 6.2）。
 *
 * 以前は茶系 2 色（`--color-brand` / `--color-brand-secondary`）と茶〜ベージュの
 * 背景だけだったため、どの産地もほぼ同じ茶色に見えていた。コーヒー産地を
 * 連想させる 6 色相（茶・深緑・赤=チェリー・琥珀・ティール・紫）に散らし、
 * 各色相は淡い背景（`-bg`）と濃い前景（豆アイコン）の組で使う。
 *
 * セマンティックなトークン（`--color-danger-bg` / `--color-warning-bg` など）は
 * 使わない。商品の装飾に使うと、同じ色が意味を持つ他の表示（失敗・警告）と
 * 読み分けられなくなる。だから `--color-origin-*` を装飾専用に独立させている。
 *
 * この配列の**順序と内容を変えると既存の産地の色が変わる**。表示上の影響は
 * あるが機能には影響しない（`product-visual.test.ts` は特定の色ではなく
 * 「同じ産地なら同じ色」「範囲内に収まる」「背景 ≠ 前景」を固定している）。
 */
export const PRODUCT_THUMB_TONES: readonly ProductThumbTone[] = [
  { background: "--color-origin-coffee-bg", foreground: "--color-origin-coffee" },
  { background: "--color-origin-forest-bg", foreground: "--color-origin-forest" },
  { background: "--color-origin-cherry-bg", foreground: "--color-origin-cherry" },
  { background: "--color-origin-amber-bg", foreground: "--color-origin-amber" },
  { background: "--color-origin-teal-bg", foreground: "--color-origin-teal" },
  { background: "--color-origin-plum-bg", foreground: "--color-origin-plum" },
];

/**
 * 産地名から配色の index を決める（0 以上 {@link PRODUCT_THUMB_TONES} の長さ未満）。
 *
 * 前後の空白は落とす。`product-filter.ts` の `listOrigins` が空白を落として
 * 同じ産地とみなすので、色の付け方も揃えないと絞り込みの選択肢と
 * カードの色で産地の同一性の判断が食い違う。
 *
 * ハッシュは 31 進の積和（`String.prototype.hashCode` 相当）を
 * 2^31-1 で丸めたもの。暗号用途ではなく、産地名を安定した整数に写すだけである。
 * 空文字（属性を返さない古い API 相手の保険）は 0 になり、先頭の配色が付く。
 */
export function originToneIndex(origin: string): number {
  const trimmed = origin.trim();
  let hash = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    hash = (hash * 31 + trimmed.charCodeAt(index)) % 0x7fffffff;
  }
  return hash % PRODUCT_THUMB_TONES.length;
}

/** 産地名に対応する配色を引く（要件 2.3） */
export function pickProductThumbTone(origin: string): ProductThumbTone {
  return PRODUCT_THUMB_TONES[originToneIndex(origin)];
}

/**
 * CSS 変数名を `var()` 参照に変換する。
 *
 * インラインスタイルに載せる値を組み立てるのはここだけにして、
 * コンポーネント側にトークン名の文字列連結を散らさない。
 */
export function cssVarRef(token: string): string {
  return `var(${token})`;
}
