/**
 * 引当段階のトランザクション組み立てと失敗の解釈（要件 5.1〜5.6 / 5.8、design 論点 1 / §E-3）。
 *
 * ## 全明細を 1 トランザクションにする（design 論点 1）
 *
 * 明細ごとに順次 `UpdateItem` すると、3 品目中 2 品目で成功して 3 品目目で
 * 失敗したときに**在庫が減ったまま `ALLOCATION_FAILED`** になる。
 * 在庫は消え、注文は成立しない。補償処理（戻し）を書くと補償自体の失敗という
 * 状態が増える。`TransactWriteItems` なら全成功か全失敗のいずれかになり、
 * 部分的に減算された状態が存在しない（要件 5.8 / Property 5）。
 *
 * 代償は WCU が通常の書き込みの 2 倍になることだが、1 注文の明細は 1〜3 件
 * （`shared/catalog.ts` の `randomOrderItems`）でトランザクションの上限 100 に対して
 * 十分小さく、DynamoDB の書き込みは本 PoC の壁の候補ではない（design §2.2 の #3 / #4）。
 *
 * ## 在庫レコードが無い場合も在庫不足として扱える（要件 5.6）
 *
 * 条件式 `quantity >= :qty` は属性が存在しない場合も**偽**になる。
 * 「在庫レコードが存在しない」ために特別な分岐を書く必要はなく、
 * 在庫不足と同じ `ConditionalCheckFailed` として返ってくる。
 * 初期在庫を投入せずに検証を始めると全注文がここで終端になる
 * （`inventory-seed/handler.ts` の冒頭に同じ注記がある）。
 */

import type { CancellationReason } from '@aws-sdk/client-dynamodb';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { DEFAULT_WAREHOUSE_ID, inventoryKey } from '../shared/inventory-keys.js';
import type { OrderItem } from '../shared/types.js';

/** 引当 1 件（SKU 単位に集約済み） */
export interface AllocationTarget {
  /** 商品 SKU。在庫テーブルの PK `itemId` にそのまま使う */
  sku: string;
  /** 減算する数量（同一 SKU の明細を合算した値） */
  qty: number;
}

/** 引当の失敗をどう扱うか（design §E-2 の区別） */
export type AllocationFailureKind =
  /** 在庫不足 / 在庫レコード不在。終端として記録し再試行しない（要件 5.3 / 5.6 / 16.7） */
  | 'BUSINESS'
  /** 並行トランザクションの競合、スロットル、その他。再試行する（要件 9.8） */
  | 'TECHNICAL';

export interface AllocationFailure {
  kind: AllocationFailureKind;
  /** `failure_reason` に記録する文面（要件 5.3） */
  reason: string;
  /** 在庫が不足していた SKU（`kind = 'BUSINESS'` のとき 1 件以上） */
  insufficientSkus: string[];
  /** 技術的な失敗として返ってきた `CancellationReasons` の `Code`（ログ用） */
  technicalCodes: string[];
}

/**
 * 在庫不足を表す `CancellationReasons` の `Code`（design §E-3）。
 *
 * 条件式 `quantity >= :qty` が落ちたことを意味する。
 * 在庫不足と在庫レコード不在の双方がこの 1 つに集約される（要件 5.6）。
 */
export const CONDITIONAL_CHECK_FAILED_CODE = 'ConditionalCheckFailed';

/** 失敗しなかった明細に付く `Code`（DynamoDB の仕様） */
export const NO_CANCELLATION_CODE = 'None';

/**
 * 同一明細に複数の数量が現れたときに合算する。
 *
 * `TransactWriteItems` は **1 トランザクション内で同じアイテムを 2 回操作できない**
 * （`ValidationException` でトランザクションごと失敗する）。
 * `randomOrderItems` は SKU が重複しないよう生成するが、`POST /orders` は
 * 呼び出し側が明細を指定できる（要件 1.5）ため、同じ SKU が 2 行に分かれて
 * 届く可能性がある。ここで畳んでおかないと、その注文だけが
 * 「引当で必ず技術的な失敗になり、3 回再試行して DLQ に落ちる」挙動になる。
 *
 * 出現順を保つのは、`CancellationReasons` が**トランザクションの並び順**で
 * 返るためである（`interpretCancellationReasons` が位置で突き合わせる）。
 */
export function toAllocationTargets(items: readonly OrderItem[]): AllocationTarget[] {
  const totals = new Map<string, number>();
  for (const item of items) {
    totals.set(item.sku, (totals.get(item.sku) ?? 0) + item.qty);
  }
  return [...totals].map(([sku, qty]) => ({ sku, qty }));
}

export interface AllocationTransactInput {
  /** 引当在庫テーブル名 */
  tableName: string;
  /** 引当対象（`toAllocationTargets` の結果） */
  targets: readonly AllocationTarget[];
  /** `lastUpdated` に書く時刻（ISO 8601） */
  now: string;
  /** 倉庫 ID。既定は単一倉庫（要件 5.9） */
  warehouseId?: string;
}

/**
 * 引当の `TransactWriteItems` 入力を組み立てる（要件 5.5、design 論点 1）。
 *
 * 各明細に `ConditionExpression: quantity >= :qty` を付ける。
 * これが在庫数を負にしない唯一の保証である（Property 5）。
 * 読んでから引くのではなく**条件付きの減算 1 回**で済ませているので、
 * 読み取りと書き込みの間に別の引当が割り込む余地がない。
 *
 * `quantity` と `lastUpdated` は予約語ではないため属性名の別名を使わない。
 */
export function buildAllocationTransactItems(
  input: AllocationTransactInput
): TransactWriteCommandInput {
  const warehouseId = input.warehouseId ?? DEFAULT_WAREHOUSE_ID;

  return {
    TransactItems: input.targets.map((target) => ({
      Update: {
        TableName: input.tableName,
        Key: inventoryKey(target.sku, warehouseId),
        UpdateExpression: 'SET quantity = quantity - :qty, lastUpdated = :now',
        ConditionExpression: 'quantity >= :qty',
        ExpressionAttributeValues: { ':qty': target.qty, ':now': input.now },
      },
    })),
  };
}

/**
 * `TransactionCanceledException` の `CancellationReasons` を解釈する（design §E-3）。
 *
 * `CancellationReasons` は `TransactItems` と**同じ並び順**で返るため、
 * 位置で SKU に対応付けられる。`targets` は
 * `buildAllocationTransactItems` に渡したものと同一の配列でなければならない。
 *
 * ## 在庫不足を技術的な失敗より優先する
 *
 * 在庫不足（`ConditionalCheckFailed`）とスロットルが同時に返ることがある。
 * このとき**業務的な失敗として終端にする**。理由は 2 つある。
 *
 * 1. 本 PoC には在庫を補充する経路が無い。条件が落ちた明細は再試行しても
 *    落ち続けるため、トランザクション全体が成功する見込みがない
 * 2. 終端にすれば注文レコードに `ALLOCATION_FAILED` と不足 SKU が残り、
 *    検証者が照会 API で理由を読める。再試行に回すと 3 回失敗した後
 *    DLQ にメタデータだけが落ち（design 論点 4）、注文側には何も残らない
 *
 * 実運用（補充がある系）ではこの優先順位は妥当でない。
 * その場合は「不足 SKU を記録した上で再試行する」形に変える必要がある。
 *
 * ## 想定外の `Code` は技術的な失敗にする
 *
 * design §E-3 の表に無い `Code`（`ValidationError` など）は再試行に回す。
 * 再試行しても直らないが、3 回で打ち切られて DLQ に落ちるため
 * アラーム（design §6.2）で気づける。静かに成功扱いにするより良い。
 */
export function interpretCancellationReasons(
  targets: readonly AllocationTarget[],
  reasons: readonly CancellationReason[] | undefined
): AllocationFailure {
  const insufficientSkus: string[] = [];
  const technicalCodes: string[] = [];

  (reasons ?? []).forEach((reason, index) => {
    const code = reason.Code;
    if (code === undefined || code === NO_CANCELLATION_CODE) return;
    if (code === CONDITIONAL_CHECK_FAILED_CODE) {
      // 位置に対応する SKU が取れない場合（想定外の件数）は SKU 名を伏せる
      insufficientSkus.push(targets[index]?.sku ?? `#${index}`);
      return;
    }
    technicalCodes.push(code);
  });

  if (insufficientSkus.length > 0) {
    return {
      kind: 'BUSINESS',
      reason: `在庫が不足しています: ${insufficientSkus.join(', ')}`,
      insufficientSkus,
      technicalCodes,
    };
  }

  const codes = technicalCodes.length > 0 ? technicalCodes.join(', ') : '理由不明';
  return {
    kind: 'TECHNICAL',
    reason: `引当トランザクションが取り消されました: ${codes}`,
    insufficientSkus,
    technicalCodes,
  };
}
