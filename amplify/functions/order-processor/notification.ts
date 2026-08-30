/**
 * 通知段階の内容の組み立て（要件 6.2 / 6.3 / 6.7、design §5.5）。
 *
 * メール送信は構造化ログの出力で代替する（スコープ外の定義）。
 * 「何を出すか」を純粋関数にしておくと、要件 6.2 の 4 項目
 * （注文番号・商品名・合計金額・到着予定）が揃っていることを
 * ログ出力を伴わずに単体テストで確かめられる。
 *
 * ## 商品名は商品マスタから解決する（要件 6.7）
 *
 * 注文レコードは SKU しか持たない（design §4.2）。商品名を注文レコードに
 * 複製すると、通知の文面が「注文時点の商品名」に固定されて商品マスタと
 * 食い違い得る。`shared/catalog.ts` を唯一の出典にする方針（design §5.8）に従い、
 * 通知の組み立て時に解決する。商品マスタはコード同梱の生成物なので
 * 追加の読み取りは発生しない（処理時間 D に乗らない）。
 *
 * ## 解決できない SKU があっても通知を止めない
 *
 * `order-accept` は商品マスタに無い SKU を 400 で弾く（要件 1.8）が、
 * 負荷生成は注文テーブルへ直接書き込む（design 論点 2）ため、
 * 商品マスタを差し替えた後の古い注文が残っていると解決に失敗し得る。
 * そのとき通知を技術的な失敗にすると、**商品マスタの世代差という
 * 検証と無関係な理由でシャードが塞がる**。SKU をそのまま名前に使って通知を通し、
 * 解決できなかった SKU を返り値に残してハンドラ側で警告ログにする。
 */

import { findProduct } from '../shared/catalog.js';
import type { OrderItem } from '../shared/types.js';

/**
 * 到着予定日までの日数。
 *
 * 業務的な根拠はない（Kiro Roasters の焙煎リードタイムを模した固定値）。
 * 通知の文面に「到着予定」が入っていること（要件 6.2）を満たすためだけの値であり、
 * 検証パラメータにはしていない。動かしても消費能力の式に影響しない。
 */
export const ARRIVAL_LEAD_DAYS = 3;

/** 通知に載せる明細 1 行 */
export interface NotificationLineItem {
  sku: string;
  /** 商品名（商品マスタから解決。解決できなければ SKU をそのまま入れる） */
  name: string;
  qty: number;
  price: number;
}

/** 通知の内容（要件 6.2 の 4 項目を含む） */
export interface NotificationContent {
  /** 注文番号 */
  orderId: string;
  customerId: string;
  /** 商品名を解決済みの明細 */
  items: NotificationLineItem[];
  /** 合計金額（税込） */
  totalAmount: number;
  /** 到着予定日（`YYYY-MM-DD`） */
  estimatedArrivalDate: string;
  /** 商品マスタから商品名を解決できなかった SKU。空でなければ警告に値する */
  unresolvedSkus: string[];
}

/** 通知の組み立てに必要な注文情報（`StreamOrder` の部分集合） */
export interface NotificationSource {
  orderId: string;
  customerId: string;
  items: readonly OrderItem[];
  totalAmount: number;
}

/**
 * 到着予定日を求める（`YYYY-MM-DD`）。
 *
 * UTC の暦日で計算する。JST に直さないのは、この値が業務判断に使われず
 * 通知の文面に現れるだけであり、日付境界のずれが検証結果に影響しないためである
 * （時刻を扱う他の属性はすべて ISO 8601 の UTC で記録している）。
 *
 * @param nowMs 起点時刻（ミリ秒）
 * @param leadDays 加算する日数。既定は `ARRIVAL_LEAD_DAYS`
 */
export function toEstimatedArrivalDate(
  nowMs: number,
  leadDays: number = ARRIVAL_LEAD_DAYS
): string {
  const arrival = new Date(nowMs + leadDays * 24 * 60 * 60 * 1000);
  return arrival.toISOString().slice(0, 10);
}

/**
 * 通知内容を組み立てる（要件 6.2）。
 *
 * @param order 通知対象の注文
 * @param nowMs 到着予定日の起点（ミリ秒）。既定は現在時刻
 */
export function buildNotificationContent(
  order: NotificationSource,
  nowMs: number = Date.now()
): NotificationContent {
  const unresolvedSkus: string[] = [];

  const items = order.items.map((item) => {
    const product = findProduct(item.sku);
    if (product === undefined) {
      unresolvedSkus.push(item.sku);
    }
    return {
      sku: item.sku,
      name: product?.name ?? item.sku,
      qty: item.qty,
      price: item.price,
    };
  });

  return {
    orderId: order.orderId,
    customerId: order.customerId,
    items,
    totalAmount: order.totalAmount,
    estimatedArrivalDate: toEstimatedArrivalDate(nowMs),
    unresolvedSkus,
  };
}
