import type { CancellationReason } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { DEFAULT_WAREHOUSE_ID } from '../shared/inventory-keys.js';
import type { OrderItem } from '../shared/types.js';
import {
  CONDITIONAL_CHECK_FAILED_CODE,
  NO_CANCELLATION_CODE,
  buildAllocationTransactItems,
  interpretCancellationReasons,
  toAllocationTargets,
} from './allocation.js';

/**
 * 引当のトランザクション組み立てと失敗の解釈の単体テスト
 * （要件 5.3 / 5.5 / 5.6 / 5.8、design 論点 1 / §E-3、Property 5）。
 *
 * 検証の主眼は 3 点。
 *
 * 1. 全明細が 1 トランザクションに入り、各明細に在庫数の条件式が付くこと（Property 5）
 * 2. 同一 SKU が畳まれること（`TransactWriteItems` は同一アイテムの二重操作を拒否する）
 * 3. `CancellationReasons` が業務的な失敗と技術的な失敗に正しく振り分けられること（design §E-3）
 */

const TABLE = 'kiro-roasters-order-inventory';
const NOW = '2025-01-01T00:00:10.000Z';

const SKU_A = 'ITEM#ETH-YIRG-G1-MEDIUM-200G';
const SKU_B = 'ITEM#BRA-SANT-NY2-CITY-500G';

function item(sku: string, qty: number, price = 1800): OrderItem {
  return { sku, qty, price };
}

function reason(code: string): CancellationReason {
  return { Code: code };
}

describe('toAllocationTargets（design 論点 1）', () => {
  it('明細の順序を保って SKU と数量を取り出す', () => {
    expect(toAllocationTargets([item(SKU_A, 1), item(SKU_B, 2)])).toEqual([
      { sku: SKU_A, qty: 1 },
      { sku: SKU_B, qty: 2 },
    ]);
  });

  it('同一 SKU の明細を 1 件に合算する（同一アイテムの二重操作を避ける）', () => {
    const targets = toAllocationTargets([item(SKU_A, 1), item(SKU_B, 2), item(SKU_A, 3)]);

    expect(targets).toHaveLength(2);
    expect(targets[0]).toEqual({ sku: SKU_A, qty: 4 });
    // 最初に現れた位置を保つ（CancellationReasons と位置で対応付けるため）
    expect(targets[1]).toEqual({ sku: SKU_B, qty: 2 });
  });
});

describe('buildAllocationTransactItems（要件 5.5 / 5.8、Property 5）', () => {
  const input = {
    tableName: TABLE,
    targets: toAllocationTargets([item(SKU_A, 1), item(SKU_B, 2)]),
    now: NOW,
  };

  it('全明細を 1 トランザクションに入れる（部分的な減算を残さない）', () => {
    const command = buildAllocationTransactItems(input);
    expect(command.TransactItems).toHaveLength(2);
  });

  it('各明細に在庫数の条件式を付ける（在庫を負にしない）', () => {
    const command = buildAllocationTransactItems(input);

    for (const transactItem of command.TransactItems ?? []) {
      expect(transactItem.Update?.ConditionExpression).toBe('quantity >= :qty');
    }
  });

  it('条件式と減算が同じ数量を参照する（引ける量だけ引く）', () => {
    const command = buildAllocationTransactItems(input);
    const update = command.TransactItems?.[1]?.Update;

    expect(update?.UpdateExpression).toBe(
      'SET quantity = quantity - :qty, lastUpdated = :now'
    );
    expect(update?.ExpressionAttributeValues?.[':qty']).toBe(2);
    expect(update?.ExpressionAttributeValues?.[':now']).toBe(NOW);
  });

  it('在庫テーブルのキーを SKU と既定倉庫から組み立てる（要件 5.9）', () => {
    const command = buildAllocationTransactItems(input);

    expect(command.TransactItems?.[0]?.Update?.TableName).toBe(TABLE);
    expect(command.TransactItems?.[0]?.Update?.Key).toEqual({
      itemId: SKU_A,
      warehouseId: DEFAULT_WAREHOUSE_ID,
    });
  });

  it('倉庫 ID を指定できる（投入側と引当側で出典を揃えるため）', () => {
    const command = buildAllocationTransactItems({ ...input, warehouseId: 'WH-OSAKA' });

    expect(command.TransactItems?.[0]?.Update?.Key).toEqual({
      itemId: SKU_A,
      warehouseId: 'WH-OSAKA',
    });
  });
});

describe('interpretCancellationReasons（design §E-3）', () => {
  const targets = toAllocationTargets([item(SKU_A, 1), item(SKU_B, 2)]);

  it('ConditionalCheckFailed は業務的な失敗にし、不足 SKU を特定する（要件 5.3 / 5.6）', () => {
    const failure = interpretCancellationReasons(targets, [
      reason(NO_CANCELLATION_CODE),
      reason(CONDITIONAL_CHECK_FAILED_CODE),
    ]);

    expect(failure.kind).toBe('BUSINESS');
    expect(failure.insufficientSkus).toEqual([SKU_B]);
    expect(failure.reason).toContain(SKU_B);
  });

  it('複数の明細が不足していればすべて記録する', () => {
    const failure = interpretCancellationReasons(targets, [
      reason(CONDITIONAL_CHECK_FAILED_CODE),
      reason(CONDITIONAL_CHECK_FAILED_CODE),
    ]);

    expect(failure.insufficientSkus).toEqual([SKU_A, SKU_B]);
  });

  it('TransactionConflict は技術的な失敗にする（再試行する）', () => {
    const failure = interpretCancellationReasons(targets, [
      reason('TransactionConflict'),
      reason(NO_CANCELLATION_CODE),
    ]);

    expect(failure.kind).toBe('TECHNICAL');
    expect(failure.insufficientSkus).toEqual([]);
    expect(failure.technicalCodes).toEqual(['TransactionConflict']);
  });

  it('スロットルは技術的な失敗にする（再試行する）', () => {
    for (const code of ['ThrottlingError', 'ProvisionedThroughputExceeded']) {
      expect(interpretCancellationReasons(targets, [reason(code)]).kind).toBe('TECHNICAL');
    }
  });

  it('在庫不足と技術的な理由が混ざる場合は業務的な失敗を優先する（終端にする）', () => {
    const failure = interpretCancellationReasons(targets, [
      reason(CONDITIONAL_CHECK_FAILED_CODE),
      reason('ThrottlingError'),
    ]);

    expect(failure.kind).toBe('BUSINESS');
    expect(failure.insufficientSkus).toEqual([SKU_A]);
    // 技術的な理由も捨てずに残す（ログで原因を追えるようにする）
    expect(failure.technicalCodes).toEqual(['ThrottlingError']);
  });

  it('design §E-3 の表に無い Code は技術的な失敗にする（DLQ で気づけるようにする）', () => {
    const failure = interpretCancellationReasons(targets, [reason('ValidationError')]);

    expect(failure.kind).toBe('TECHNICAL');
    expect(failure.technicalCodes).toEqual(['ValidationError']);
  });

  it('CancellationReasons が無い場合も技術的な失敗として扱う（成功扱いにしない）', () => {
    for (const reasons of [undefined, [], [reason(NO_CANCELLATION_CODE)]]) {
      const failure = interpretCancellationReasons(targets, reasons);
      expect(failure.kind).toBe('TECHNICAL');
      expect(failure.reason).toContain('理由不明');
    }
  });

  it('明細数より多い理由が返っても落ちない（位置が対応しない SKU は伏せる）', () => {
    const failure = interpretCancellationReasons(targets, [
      reason(NO_CANCELLATION_CODE),
      reason(NO_CANCELLATION_CODE),
      reason(CONDITIONAL_CHECK_FAILED_CODE),
    ]);

    expect(failure.kind).toBe('BUSINESS');
    expect(failure.insufficientSkus).toEqual(['#2']);
  });
});
