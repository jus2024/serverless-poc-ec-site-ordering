# Implementation Plan

EC 注文画面のリニューアル（ec-order-ui）

design 第 6 章の段階順に並べる。各段は前の段が動く状態を保つ。
バックエンド → フロント型 → カート純粋関数 → UI → 移設 → スタイルの順。
各タスクの末尾に対応する要件番号を記す。

---

- [x] 1. バックエンド: 商品マスタに表示用属性を追加する
- [x] 1.1 `amplify/functions/shared/catalog.ts` の `CatalogProduct` に `origin` / `roast` / `size` を追加
  - `buildCatalog()` のループ内で `origin.name` / `roast.name` / `size.name` をそのまま代入する
  - SKU・価格・`name` の生成ロジックは変更しない
  - _要件: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_
- [x] 1.2 `amplify/functions/shared/types.ts` の `CatalogProduct`（Lambda 側）に追加属性を反映
  - _要件: 1.1, 1.6_
- [x] 1.3 `amplify/functions/order-query/views.ts` の `buildCatalogResponse` が追加属性を返すようにする
  - `CATALOG.map` に `origin` / `roast` / `size` を追加する
  - _要件: 1.1_
- [x] 1.4 `catalog.test.ts` に「追加属性が SKU と矛盾しない」検証を追加
  - 各商品の `origin` / `roast` / `size` が SKU の対応部分と整合することを確認する
  - _要件: 1.5_
- [x] 1.5 sandbox で `GET /catalog` が追加属性を返すことを確認する（デプロイを伴う）
  - `curl -s "$API/catalog" | jq '.products[0]'` で 6 項目が揃うことを見る
  - _要件: 1.1, 非機能 4_

- [x] 2. フロント: 型を合わせる
- [x] 2.1 `src/lib/orders/types.ts` の `CatalogProductView` に `origin` / `roast` / `size: string` を追加
  - Lambda 側と重複させる方針（要件 18.6）を維持し import はしない
  - _要件: 1.7_

- [x] 3. フロント: カートの純粋関数を作る（UI より先にテストを通す）
- [x] 3.1 `src/components/orders/cart.ts` を新設する
  - `CartLine { sku, qty }` の配列を状態とする
  - 追加（同一 SKU は数量加算）、数量変更、削除、`OrderLineDraft[]` への変換、
    合計金額・獲得予定ポイントの算出を純粋関数で提供する
  - 単価・ポイント率は商品マスタ（引数）から引く。フォームで持たない
  - _要件: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7_
- [x] 3.2 産地の一意集合を抽出する純粋関数を `cart.ts` または別モジュールに置く
  - `CatalogProductView[]` から `origin` の重複なし一覧を作る（表示順は安定させる）
  - _要件: 2.4, 2.5_
- [x] 3.3 `cart.test.ts` を書く
  - 同一 SKU 追加で数量加算・明細非重複、削除、変換、合計・ポイント算出、
    数量上限（`MAX_ITEM_QTY`）超過の検出、産地の一意抽出
  - _要件: 3.2, 3.3, 3.4, 3.7, 3.8, 2.4_

- [x] 4. フロント: 商品グリッドを作る
- [x] 4.1 `ProductCard` を作る
  - 商品名・産地・焙煎度・容量・価格・「カートに追加」を表示する
  - プレースホルダ画像（産地色 + アイコン）を表示する。産地色は産地名のハッシュで
    既存トークンを巡回。新しい生の色値は追加しない
  - _要件: 2.2, 2.3, 2.8, 6.2_
- [x] 4.2 `ProductGrid` を作る
  - 産地の絞り込みセレクト（先頭に「すべて」）と商品カードのグリッド
  - 読み込み中・取得失敗（再取得手段つき）の表示
  - _要件: 2.1, 2.4, 2.5, 2.6, 2.7_

- [x] 5. フロント: カート UI を作る
- [x] 5.1 `CartPanel` を作る
  - 明細（商品名・数量・小計）、数量変更、削除、合計金額、獲得予定ポイント
  - カートが空なら注文操作を無効化する
  - 数量変更・削除は対象商品が分かる `aria-label` を付ける
  - _要件: 3.3, 3.4, 3.5, 3.6, 6.4_
- [x] 5.2 注文の送信と結果表示を `CartPanel`（または親）に実装する
  - カートを `OrderLineDraft[]` に変換 → `buildOrderDraft` で検証 → `createOrder`
  - `customerId` は指定しない。ランダム生成の分岐は持たない
  - 成功: 受付結果表示、`onOrderCreated(orderId)`、カートを空にする
  - 失敗: `describeOrderApiFailure` + `FailureAlert`、カート保持
  - 送信中は操作を無効化。結果は `role="status"` / `aria-live` で通知
  - _要件: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 6.5_

- [x] 6. フロント: 注文タブを差し替える
- [x] 6.1 `OrdersTabPanel` を再構成する
  - 商品マスタ取得（`getCatalog`）とカート状態をここで持つ
  - `ProductGrid` + `CartPanel` + `OrderStatusPanel`（既存を再利用）を組む
  - 注文成功時の `orderId` を `OrderStatusPanel` へ引き継ぐ既存連携を保つ
  - _要件: 2.1, 4.3, 6.6_

- [x] 7. フロント: 検証操作を設定タブへ移す
- [x] 7.1 `InventorySeedPanel` を切り出す
  - `OrderSubmitPanel` の初期在庫投入セクション（在庫数入力、`seedInventory`、結果表示）を移す
  - `parseInitialQuantityInput` の検証はそのまま使う
  - _要件: 5.1, 5.2_
- [x] 7.2 設定タブを `SettingsTabPanel`（`ConfigPanel` + `InventorySeedPanel`）にする
  - `ConfigPanel` の既存表示は変更しない
  - _要件: 5.1, 5.5_
- [x] 7.3 旧 `OrderSubmitPanel` を撤去する
  - 顧客 ID 入力・ランダム生成チェックボックスを削除（移設しない）
  - `parseCustomerIdInput` は `order-form.ts` に残す（未使用でよい）
  - _要件: 4.7, 4.8, 5.3, 5.4_

- [x] 8. スタイルとレイアウト
- [x] 8.1 `src/app/globals.css` の `--max-width` を 960px → 1120px にする
  - _要件: 6.1_
- [x] 8.2 `orders.module.css` にグリッド・カード・カートのスタイルを追加
  - `.productGrid`（`repeat(auto-fill, minmax(...))`）、`.productCard`、`.productThumb`、
    `.cart` / `.cartLine`
  - すべて既存トークンで組み、生の色値を書かない
  - _要件: 6.2, 6.3_

- [x] 9. 仕上げの検証
- [x] 9.1 `npm run lint` と `npx tsc --noEmit` を通す
  - _要件: 非機能 1_
- [x] 9.2 `npm test`（カートと catalog の単体テスト）を通す
  - _要件: 3.x, 1.5_
- [x] 9.3 sandbox で目視確認する
  - 商品グリッド・産地絞り込み・カート・注文 → ステータス進行、設定タブの在庫投入、
    注文タブに顧客 ID / ランダム生成が無いこと、幅 1120px
  - キーボードのみで注文まで到達できること
  - _要件: 2, 3, 4, 5, 6_
