import { describe, expect, it } from 'vitest';
import { PAYMENT_DECLINED_REASON, shouldDeclinePayment } from './payment.js';

/**
 * 決済の失敗判定の単体テスト（要件 4.8）。
 *
 * 検証の主眼は境界である。失敗率 0 で 1 件でも失敗すると、
 * 「壁の位置を測る」シナリオ（design §10.2 の A 系はすべて失敗率 0）に
 * `PAYMENT_FAILED` が混ざり、処理件数と滞留の突き合わせが合わなくなる。
 * 逆に失敗率 1 で 1 件でも成功すると、失敗経路の確認が不完全になる。
 */

describe('shouldDeclinePayment（要件 4.8）', () => {
  it('失敗率 0 では乱数がどの値でも拒否しない', () => {
    for (const sample of [0, 0.0001, 0.5, 0.9999]) {
      expect(shouldDeclinePayment(0, sample)).toBe(false);
    }
  });

  it('失敗率 1 では乱数がどの値でも拒否する', () => {
    for (const sample of [0, 0.5, 0.9999]) {
      expect(shouldDeclinePayment(1, sample)).toBe(true);
    }
  });

  it('失敗率より小さい乱数だけを拒否する', () => {
    expect(shouldDeclinePayment(0.3, 0.29)).toBe(true);
    expect(shouldDeclinePayment(0.3, 0.3)).toBe(false);
    expect(shouldDeclinePayment(0.3, 0.31)).toBe(false);
  });

  it('乱数 0 は失敗率が正なら拒否になる（Math.random の下限を取りこぼさない）', () => {
    expect(shouldDeclinePayment(0.01, 0)).toBe(true);
  });

  it('解釈できない失敗率は拒否しない（黙って全件失敗させない）', () => {
    expect(shouldDeclinePayment(Number.NaN, 0.5)).toBe(false);
    expect(shouldDeclinePayment(-1, 0.5)).toBe(false);
  });

  it('失敗率が 1 を超えても常に拒否する（範囲外でも判定が破綻しない）', () => {
    expect(shouldDeclinePayment(2, 0.99)).toBe(true);
  });
});

describe('PAYMENT_DECLINED_REASON（要件 4.5）', () => {
  it('意図的な失敗であることが読み取れる文面である', () => {
    expect(PAYMENT_DECLINED_REASON).toContain('ORDER_PAYMENT_FAILURE_RATE');
  });
});
