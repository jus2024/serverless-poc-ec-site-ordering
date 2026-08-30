import { describe, expect, it } from 'vitest';
import { CATALOG } from '../shared/catalog.js';
import {
  ARRIVAL_LEAD_DAYS,
  buildNotificationContent,
  toEstimatedArrivalDate,
  type NotificationSource,
} from './notification.js';

/**
 * 通知内容の組み立ての単体テスト（要件 6.2 / 6.7）。
 *
 * 要件 6.2 は通知に 4 項目（注文番号・商品名・合計金額・到着予定）を
 * 含めることを求めている。項目が欠けてもエラーにはならず、
 * 構造化ログの中身が静かに貧しくなるだけなので、機械的に確かめる価値がある。
 */

const PRODUCT = CATALOG[0];
const OTHER_PRODUCT = CATALOG[1];
const NOW_MS = Date.parse('2025-01-01T00:00:00.000Z');

function source(overrides: Partial<NotificationSource> = {}): NotificationSource {
  return {
    orderId: 'ORD#01J000000000000000000000',
    customerId: 'CUST#test-0001',
    items: [{ sku: PRODUCT.sku, qty: 2, price: PRODUCT.price }],
    totalAmount: PRODUCT.price * 2,
    ...overrides,
  };
}

describe('toEstimatedArrivalDate（要件 6.2）', () => {
  it('到着予定日を YYYY-MM-DD で返す', () => {
    expect(toEstimatedArrivalDate(NOW_MS)).toBe('2025-01-04');
  });

  it('既定のリードタイムは ARRIVAL_LEAD_DAYS 日である', () => {
    const expected = new Date(NOW_MS + ARRIVAL_LEAD_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(toEstimatedArrivalDate(NOW_MS)).toBe(expected);
  });

  it('月末を跨いでも暦日として正しく進む', () => {
    expect(toEstimatedArrivalDate(Date.parse('2025-01-30T12:00:00.000Z'))).toBe('2025-02-02');
  });
});

describe('buildNotificationContent（要件 6.2 / 6.7）', () => {
  it('要件 6.2 の 4 項目を含む', () => {
    const content = buildNotificationContent(source(), NOW_MS);

    expect(content.orderId).toBe('ORD#01J000000000000000000000');
    expect(content.items.map((line) => line.name)).toEqual([PRODUCT.name]);
    expect(content.totalAmount).toBe(PRODUCT.price * 2);
    expect(content.estimatedArrivalDate).toBe('2025-01-04');
  });

  it('商品名を商品マスタから解決する（注文レコードは SKU しか持たない）', () => {
    const content = buildNotificationContent(
      source({
        items: [
          { sku: PRODUCT.sku, qty: 1, price: PRODUCT.price },
          { sku: OTHER_PRODUCT.sku, qty: 1, price: OTHER_PRODUCT.price },
        ],
      }),
      NOW_MS
    );

    expect(content.items.map((line) => line.name)).toEqual([
      PRODUCT.name,
      OTHER_PRODUCT.name,
    ]);
    expect(content.unresolvedSkus).toEqual([]);
  });

  it('明細の数量と単価をそのまま載せる', () => {
    const content = buildNotificationContent(source(), NOW_MS);

    expect(content.items[0]).toEqual({
      sku: PRODUCT.sku,
      name: PRODUCT.name,
      qty: 2,
      price: PRODUCT.price,
    });
  });

  it('解決できない SKU は名前に SKU を使い、事実を返り値に残す（通知を止めない）', () => {
    const content = buildNotificationContent(
      source({ items: [{ sku: 'ITEM#UNKNOWN-SKU', qty: 1, price: 100 }] }),
      NOW_MS
    );

    expect(content.items[0]?.name).toBe('ITEM#UNKNOWN-SKU');
    expect(content.unresolvedSkus).toEqual(['ITEM#UNKNOWN-SKU']);
  });
});
