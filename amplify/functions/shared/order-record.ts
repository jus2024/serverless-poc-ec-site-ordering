/**
 * 注文レコードの組み立て（design §4.2、要件 1.2 / 1.3 / 1.5 / 1.6 / 1.9）。
 *
 * ## なぜ共有モジュールに置くのか
 *
 * 注文テーブルへ書き込む経路は 2 つある。
 *
 * | 経路 | 実装 | 目的 |
 * |------|------|------|
 * | `POST /orders` | `order-accept` | 手動投入・フロントエンドからの投入（要件 1） |
 * | 負荷生成の `BatchWriteItem` | `load-generator` | 投入レートの測定（要件 11.10、design 論点 2） |
 *
 * 負荷生成が `order-accept` を経由しないのは、受付 Lambda 自身が
 * 計測対象の同時実行枠を消費して測定を歪めるからである（design 論点 2）。
 * その代償として**注文レコードを作る箇所が 2 つになる**。
 *
 * ここを重複させると、両者が食い違ったときに壊れるのは `order-processor` である。
 * 後続処理は Streams の `NewImage` をそのまま読む（テーブルを読み直さない。design §5.5）ため、
 * 片方の経路だけ属性が欠けていても**書き込みは成功し、処理段階で初めて落ちる**。
 * しかも落ちるのは非同期側なので、投入した検証者には成功に見える。
 * 組み立てを 1 関数に閉じ込め、経路による差分を `load_test_id` の有無だけに限定する。
 *
 * `order-accept/order-request.ts` は後方互換のためここで定義した関数を再エクスポートしている。
 */

import { monotonicFactory } from 'ulid';
import { calculateTotal, randomCustomerId, randomOrderItems } from './catalog.js';
import { ORDER_ID_PREFIX } from './order-keys.js';
import { expiresAtFromNow } from './runtime-config.js';
import type { CreateOrderRequest, OrderRecord } from './types.js';

/**
 * ULID 生成器。
 *
 * **単調増加版（`monotonicFactory`）を使う。** 素の `ulid()` は乱数部を毎回引き直すため、
 * 同一ミリ秒内に生成した 2 つの ID の大小が生成順と一致しない。
 * 要件 1.4 は「生成順にソート可能」を求めており、負荷生成では
 * 1 ミリ秒に複数件の注文が生まれる（16,000 件/分でも同一ミリ秒の衝突は起きる）。
 *
 * 単調増加が保証されるのは**同一プロセス内**である。
 * Lambda インスタンスが複数並ぶと、同一ミリ秒内の順序は保証されない
 * （時刻部の精度がミリ秒であるため、これは ULID の構造上の限界）。
 * 注文 ID を「ミリ秒精度の時系列キー」として扱う分には支障がない。
 */
const nextUlid = monotonicFactory();

/** 新しい注文 ID を生成する（要件 1.4。ULID なので生成順にソートできる） */
export function newOrderId(): string {
  return `${ORDER_ID_PREFIX}${nextUlid()}`;
}

export interface BuildOrderRecordInput {
  /** 検証済みのリクエスト（`parseCreateOrderRequest` の戻り値、または負荷生成の指定） */
  request: CreateOrderRequest;
  /** TTL の保持日数（`runtime-config` の `dataTtlDays`。design 論点 5） */
  dataTtlDays: number;
  /** 起点時刻（ミリ秒）。既定は現在時刻。テストで固定するために外から渡せる */
  nowMs?: number;
  /** 注文 ID。既定は新規生成。テストで固定するために外から渡せる */
  orderId?: string;
}

/**
 * 注文レコードを組み立てる（要件 1.2 / 1.3 / 1.5 / 1.6 / 1.9、design §4.2）。
 *
 * 段階属性（`payment_status` など）は**一切設定しない**。
 * 「存在しないこと」が二重実行の検知条件（design §5.4）であり、
 * 受付時点で既定値を入れると条件式が機能しなくなる。
 *
 * `point_earned` は 0 で作る。実際の付与額はポイント段階が上書きする（要件 7.5）。
 *
 * `order_status = PENDING` / `stages_done = 0` / `pipeline_mode = 'direct'` は
 * 経路によらず同じである。負荷生成が投入した注文だけ初期状態が違う、という状況を作らない。
 */
export function buildOrderRecord(input: BuildOrderRecordInput): OrderRecord {
  const { request, dataTtlDays } = input;
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();

  // 明細が未指定なら商品マスタからランダム生成（要件 1.5 / 11.4）
  const items = request.items ?? randomOrderItems();
  // 顧客 ID が未指定ならテスト顧客を割り当てる（要件 1.6）
  const customerId = request.customerId ?? randomCustomerId();

  const record: OrderRecord = {
    order_id: input.orderId ?? newOrderId(),
    customer_id: customerId,
    order_status: 'PENDING',
    items,
    total_amount: calculateTotal(items),
    point_earned: 0,
    created_at: now,
    updated_at: now,
    stages_done: 0,
    pipeline_mode: 'direct',
    expires_at: expiresAtFromNow(dataTtlDays, nowMs),
  };

  if (request.loadTestId !== undefined) {
    record.load_test_id = request.loadTestId;
  }

  return record;
}
