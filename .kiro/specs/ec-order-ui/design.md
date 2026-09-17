# 設計: EC 注文画面のリニューアル（ec-order-ui）

## Overview

注文タブを API 操作コンソールから EC の購買導線（商品グリッド → カート → 注文 → 状況）へ
作り直す。案 Y を採り、`GET /catalog` に表示用属性（産地・焙煎度・容量）を持たせて
フロントが SKU 文字列を解釈しないようにする。検証操作（初期在庫の投入・顧客 ID 指定・
ランダム生成）は顧客画面から外し、初期在庫の投入は設定タブへ移す。

**変更はレイヤーをまたぐが、注文処理パイプラインには触れない。**

| レイヤー | 変更 | 再デプロイ |
|---------|------|----------|
| `amplify/functions/shared/catalog.ts` | 商品に `origin` / `roast` / `size` を追加 | 要 |
| `amplify/functions/order-query/views.ts` | `buildCatalogResponse` が追加属性を返す | 要 |
| `amplify/functions/shared/types.ts` | `CatalogProduct` に追加属性 | 要 |
| `src/lib/orders/types.ts` | `CatalogProductView` に追加属性 | フロント再ビルド |
| `src/components/orders/` | 注文タブの再構成、カート、設定タブへの移設 | フロント再ビルド |
| `src/components/orders/orders.module.css` | グリッド・カート・カードのスタイル | フロント再ビルド |
| `src/app/globals.css` | `--max-width` 960 → 1120px | フロント再ビルド |

**注文処理・テーブル定義・IAM・負荷/計測タブは変更しない。** `docs/poc/` の実測結果に影響はない。

## 1. バックエンド: 商品マスタの表示用属性（要件 1）

### 1.1 `catalog.ts` の変更

現状 `buildCatalog()` は `origin.name` / `roast.name` / `size.name` を連結して
`name` を作っている。これらの部品はすでに手元にあるので、連結前の値を商品に添えるだけでよい。

```ts
export interface CatalogProduct {
  sku: string;
  name: string;
  price: number;
  origin: string; // 例: "エチオピア イルガチェフェ G1"（ORIGINS[].name）
  roast: string;  // 例: "ミディアム"（ROASTS[].name）
  size: string;   // 例: "200g"（SIZES[].name）
}
```

`buildCatalog()` のループ内で `origin.name` / `roast.name` / `size.name` をそのまま
`origin` / `roast` / `size` に入れる。**SKU・価格・`name` の生成ロジックは一切変えない**
（要件 1.5 / 1.6）。追加属性は既存の部品から導出されるため SKU と矛盾しない。

`randomOrderItems` / `calculateTotal` / `findProduct` など他の関数は `OrderItem`（`sku` / `qty` /
`price`）を扱っており、追加属性に依存しないため変更不要。

### 1.2 応答形状の変更

`shared/types.ts` の `CatalogProductView`（Lambda 側）と、`views.ts` の
`buildCatalogResponse` に追加属性を通す。

```ts
// buildCatalogResponse
products: CATALOG.map((product) => ({
  sku: product.sku,
  name: product.name,
  price: product.price,
  origin: product.origin,
  roast: product.roast,
  size: product.size,
})),
```

`GET /catalog` の応答は 240 件で現状約 30 KB。1 件あたり数十バイト増えるだけでページングは不要。

### 1.3 フロント側の型（`src/lib/orders/types.ts`）

`CatalogProductView` に `origin` / `roast` / `size: string` を追加する。
Lambda 側の型と意図的に重複させている方針（要件 18.6）は維持し、import はしない。
**API のレスポンス形状を変えるので両方を更新する**旨のコメントに従い、両ファイルを同時に直す。

## 2. フロント: 注文タブの再構成（要件 2 / 3 / 4）

### 2.1 コンポーネント構成

現状の `OrdersTabPanel`（`OrderSubmitPanel` + `OrderStatusPanel`）を、
購買導線のコンポーネントに置き換える。

```
OrdersTabPanel（注文タブの外枠。商品マスタの取得とカート状態を持つ）
├── ProductGrid       … 商品グリッド + 産地絞り込み（要件 2）
│   └── ProductCard   … 商品 1 件のカード（要件 2.2 / 2.3 / 2.8）
├── CartPanel         … カート（要件 3, 4）
└── OrderStatusPanel  … 既存を再利用（注文後の状況表示）
```

- 商品マスタの取得（`getCatalog`）とカート状態は `OrdersTabPanel` が持ち、
  子には props で渡す。既存の `OrderSubmitPanel` が持っていた catalog 取得ロジックを
  ここへ移す形になる。
- `OrderStatusPanel` は変更しない。注文成功時に `orderId` を渡す既存の連携をそのまま使う。

### 2.1.1 メモ: Stream が溢れたときに影響が出るのはこの画面だけ

本 PoC の検証結果（`docs/poc/` の A8 / A5）を、この EC 画面の操作に当てはめた対応表。
**記事で「画面のどこに溢れが現れるか」を示すときの根拠**であり、実装を変える話ではない。

| 操作 | 経路 | Stream 溢れの影響 | 根拠 |
|------|------|-----------------|------|
| 商品を見る / 産地で絞る | `GET /catalog`（Lambda がメモリ上のマスタを返す） | **なし**。DynamoDB も Streams も経由しない | — |
| カートに入れる / 数量変更 | 画面上の状態。API を呼ばない | **なし** | — |
| 注文する | `POST /orders`（orders テーブルに書くだけ） | **なし**。受付は健全、注文番号は普通に返る | A8（滞留 6,721 件でも `order-accept` 健全） |
| 注文直後の受付結果を見る | `createOrder` の応答 | **なし** | 同上 |
| **注文後のステータス進行を見る** | `GET /orders/{orderId}`（`OrderStatusPanel`） | **ここに出る**。照会 API 自体は速い（A8 で p99 110ms）が、**ステータスが `PENDING` のまま進まない**。後続処理が滞留の後ろで待つため | A5（停止時 42,814 件、最後の注文の完了まで約 76 分） |

**帰結: この画面で溢れが現れるのは `OrderStatusPanel` のステータス進行だけ。**
商品閲覧・カート・注文受付はすべて健全に見える。**画面はエラーを出さない**（照会は 200 を返す）。
顧客の視点では「ご注文ありがとうございます」の後、ステータスが「処理中」で止まり続ける。
これが記事 2・3（気づけない障害 / 90% は余裕ではない）を顧客視点で見せる装置になる。

`OrderStatusPanel` は段階ごとの経過時間（`stages[].elapsedMs`）と全段階完了までの経過
（`endToEndMs`）を表で既に表示しており、2 秒間隔の自動更新で段階が埋まる様子が見える。
**溢れの遅延は画面から数値として読める**（追加実装は不要）。記事のスクショはこの表を使える。

### 2.2 商品グリッドと絞り込み（要件 2）

- カードは `name` / `origin` / `roast` / `size` / `price` を表示する。
- 産地の絞り込みは `products` から `origin` の一意集合を作り、セレクトで選ばせる。
  「すべて」を先頭に置く。SKU 文字列は解釈しない（案 Y の目的）。
- グリッドは CSS Grid の `repeat(auto-fill, minmax(...))` で列数を画面幅に追従させる（要件 6.3）。
- プレースホルダ画像は産地に応じた背景色 + 豆アイコン。産地は 10 種類あり、
  色は `globals.css` のブランド系トークンから数色を巡回で割り当てる
  （産地名のハッシュで index を決め、固定の対応にする）。**新しい生の色値は追加しない**（要件 6.2）。

### 2.3 カート（要件 3）

カートは画面上の状態で、API には送らない。既存の注文明細検証（`order-form.ts` の
`buildOrderDraft`）を再利用するため、**カートの明細を `OrderLineDraft[]` に変換して渡す**。

```
CartLine { sku: string; qty: number }   ← カートの内部状態（SKU ごとに 1 行、数量を集約）
  ↓ 注文時に変換
OrderLineDraft[] { id, sku, qty:string } ← buildOrderDraft に渡す既存の形式
```

- 同一 SKU の追加は数量を加算し、明細は重複させない（要件 3.2）。
  これにより `buildOrderDraft` にはユニークな SKU だけが渡り、
  既存の「同一 SKU 重複はエラー」ロジックと矛盾しない（要件 3.7。requirements のレビューで合意済み）。
- 合計金額と獲得予定ポイントはカート内容から算出する。単価は商品マスタの値を使う
  （`order-form.ts` の方針どおり、フォームで単価を持たない）。ポイントは `price × pointRate`
  （`getCatalog` が返す `pointRate`）で概算表示する。確定値は API が返す。
- 数量の上限は `MAX_ITEM_QTY`（`order-form.ts` の既存定数）で送信前に検証する（要件 3.8）。
- カートが空なら注文ボタンを無効化する（要件 3.6）。

### 2.4 注文と状況表示（要件 4）

- 注文時、カートを `OrderLineDraft[]` に変換し `buildOrderDraft` で検証 → `items` を `createOrder` に渡す。
  `customerId` は指定しない（要件 4.7、API がテスト顧客を割り当てる）。
- 成功時: 注文番号と受付結果を表示（既存の `submitResult` 表示を流用）、`onOrderCreated(orderId)` で
  `OrderStatusPanel` に引き継ぎ、カートを空にする（要件 4.2 / 4.3 / 4.4）。
- 失敗時: `describeOrderApiFailure` で整形して表示、カートは保持（要件 4.5）。既存の `FailureAlert` を使う。
- 送信中はボタンを無効化（要件 4.6）。
- 非同期の結果は既存同様 `role="status"` / `aria-live` で読み上げる（要件 6.5）。

**ランダム生成の選択肢は設けない**（要件 4.8）。`useRandomItems` の分岐と UI を落とす。

## 3. フロント: 検証操作の設定タブへの移設（要件 5）

### 3.1 初期在庫の投入

現状 `OrderSubmitPanel` 内にある「初期在庫の投入」セクション（`handleSeedInventory`、
在庫数入力、`seedInventory` 呼び出し、結果表示）を、独立した `InventorySeedPanel` として切り出し、
設定タブ（`ConfigPanel` の隣）に置く。

- ロジック（`seedInventory` の呼び出し、`parseInitialQuantityInput` の検証、結果表示）は
  現状のまま移す（要件 5.2）。
- 設定タブは現状 `ConfigPanel` 単体。`SettingsTabPanel` を作り、`ConfigPanel` と
  `InventorySeedPanel` を縦に積む（既存の `panelStack` パターン）。
- `ConfigPanel` の既存表示（検証パラメータ・消費能力）は変更しない（要件 5.5）。

### 3.2 顧客 ID・ランダム生成の削除

顧客 ID 入力とランダム生成チェックボックスは移設ではなく**削除**する（要件 4.7 / 4.8 / 5.4）。
`parseCustomerIdInput` は `order-form.ts` に残すが、UI からは参照しなくなる
（純粋関数なので害はない。将来必要なら再利用できる）。

## 4. スタイルとレイアウト（要件 6）

### 4.1 画面幅

`globals.css` の `--max-width: 960px` を `1120px` に変更する（要件 6.1）。
`.dashboard` がこの変数を参照しているので、全タブに反映される。
負荷/計測タブのレイアウトは幅が広がるだけで崩れない（既存はカードの縦積みのため）。

### 4.2 追加するスタイル（`orders.module.css`）

- `.productGrid`: CSS Grid、`repeat(auto-fill, minmax(200px, 1fr))`、`gap`。
- `.productCard`: 既存の `card` を基にした枠。プレースホルダ・商品名・属性・価格・追加ボタン。
- `.productThumb`: プレースホルダ画像の枠（産地色 + アイコン）。
- `.cart` / `.cartLine`: カートの明細行、数量調整、削除、合計。

すべて `globals.css` のトークン（`--color-*` / `--radius` / `card` / `btn-*`）で組み、
生の色値は追加しない（要件 6.2）。

### 4.3 アクセシビリティ（要件 6.4 / 6.5）

- 商品追加・数量変更・削除・注文はすべてネイティブの `button` / `select` / `input` で作り、
  キーボードだけで完結させる。
- カートの数量変更と削除は対象商品が分かるラベル（`aria-label` に商品名）を付ける。
- 非同期の結果は `role="status"` / `aria-live="polite"` で通知（既存パターンを踏襲）。

## 5. テスト方針

- **純粋関数を優先してテストする。** カートの状態遷移（追加で数量加算、削除、
  `OrderLineDraft[]` への変換、合計・ポイント算出）を純粋関数に切り出し、単体テストを書く
  （`src/components/orders/cart.ts` + `cart.test.ts` を新設）。
- 産地の一意集合の抽出も純粋関数にしてテストする。
- `catalog.ts` の変更は既存の `catalog.test.ts` に「追加属性が SKU と矛盾しない」検証を足す。
- コンポーネント自体の結合は sandbox 目視で確認する（フロントとエージェントの結合テストは
  デプロイ環境という testing 方針に対し、本 Spec はエージェント非関与なので sandbox で足りる）。
- `npm run lint` / `npx tsc --noEmit` を通す（非機能要件 1）。

## 6. 段階的な進め方（sandbox 反復と相性を取る）

1. バックエンド（`catalog.ts` → `types.ts` → `views.ts`）を先に変え、`GET /catalog` が
   追加属性を返すことを sandbox で確認する。ここまでは UI に影響しない。
2. フロントの型（`src/lib/orders/types.ts`）を合わせる。
3. カートの純粋関数（`cart.ts`）とテストを先に作る。
4. UI コンポーネント（`ProductGrid` / `ProductCard` / `CartPanel`）を作り、`OrdersTabPanel` を差し替える。
5. 初期在庫の投入を `InventorySeedPanel` に切り出し、設定タブへ移す。
6. 幅とスタイルを調整する。
7. lint / 型チェック / sandbox 目視。

各段は前の段が動く状態を保つ（要件の非機能 5）。

## 7. 未解決の論点

| # | 論点 | 暫定方針 |
|---|------|---------|
| 1 | 産地色の割り当て方 | 産地名のハッシュで既存トークンを巡回。10 産地で色が重複しても可（要件は「プレースホルダを出す」まで） |
| 2 | カートの永続化（リロードで消えるか） | 消えてよい。検証用途であり、注文履歴は `OrderStatusPanel` と負荷テストが担う |
| 3 | 数量調整の粒度（± ボタンか直接入力か） | 直接入力（既存の数量入力の作法に合わせる）。± ボタンは任意 |
