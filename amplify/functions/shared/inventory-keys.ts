/**
 * 引当在庫テーブルのキー形式（design §4.4、要件 5.9）。
 *
 * `order-keys.ts` と同じ狙いで独立させている。倉庫 ID の値と
 * 「SKU をそのまま PK に使う」という規則を初期在庫投入（`inventory-seed`）と
 * 引当（`order-processor`。タスク 11）の双方が必要とするため、
 * 出典を 1 箇所に固定する。片方だけ倉庫 ID を書き換えると、
 * 投入した在庫とは別のパーティションを引当が読み、
 * 全注文が `ALLOCATION_FAILED`（在庫レコード不在 = 在庫不足。要件 5.6）になる。
 * しかもエラーにはならないので、原因が在庫ゼロなのか配線違いなのか判別できない。
 */

/**
 * 引当対象の倉庫 ID（SK）。**単一倉庫に固定する**（要件 5.9、design 論点 6）。
 *
 * 倉庫を複数持たせると引当先の振り分け規則が検証の変数に加わり、
 * 「壁がどこに来るか」という問いに関係しない差分が結果に混ざる。
 * 在庫管理編の Good Table は複数倉庫を扱うが、本 PoC では 1 つに絞る。
 *
 * API のパラメータにもしない。投入側と引当側で別の倉庫を指定できてしまうと、
 * 上記の「静かに全件失敗」を作り込む余地が残る。
 */
export const DEFAULT_WAREHOUSE_ID = 'WH-TOKYO';

/** 引当在庫テーブルの主キー（design §4.4: PK `itemId` / SK `warehouseId`） */
export interface InventoryKey {
  /** PK: 商品 SKU（`ITEM#...`）をそのまま使う */
  itemId: string;
  /** SK: 倉庫 ID */
  warehouseId: string;
}

/**
 * SKU から在庫レコードのキーを組み立てる。
 *
 * SKU に接頭辞を足さない（`ITEM#` は SKU 自身が持っている。要件 3.2）。
 * 注文明細の `sku` をそのまま `itemId` として使えることが、
 * 引当で明細から在庫キーを導ける前提になっている。
 */
export function inventoryKey(
  sku: string,
  warehouseId: string = DEFAULT_WAREHOUSE_ID
): InventoryKey {
  return { itemId: sku, warehouseId };
}
