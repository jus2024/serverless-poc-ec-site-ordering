import { describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_EXPIRY_SECONDS,
  IDEMPOTENCY_KEY_JMES_PATH,
  isRetryableIdempotencyError,
  stageIdempotencyKeyLabel,
} from './idempotency.js';
import { METRIC_DIMENSIONS, METRIC_NAMES, METRICS_NAMESPACE } from './metrics.js';
import { ORDER_STAGES } from './types.js';

/**
 * 冪等性とメトリクスのうち、AWS への接続を伴わない部分の単体テスト。
 *
 * 冪等キーの形（design 論点 7）とメトリクス名（design 論点 9 / §6.1）は
 * ダッシュボード定義（IaC）と観測結果の解釈が依存する「約束」であり、
 * 変更が意図的であることを機械的に確かめる価値がある。
 * 永続化層と EMF 出力そのものはデプロイ後の検証（design §12 の段階 3 以降）で確かめる。
 */

describe('冪等キー（design 論点 7）', () => {
  it('論理キーは {stage}#{order_id}', () => {
    expect(stageIdempotencyKeyLabel('payment', 'ORD#01J000000000000000000000')).toBe(
      'payment#ORD#01J000000000000000000000'
    );
  });

  it('段階ごとに異なるキーになる（段階単位の再実行を可能にするため。要件 16.5）', () => {
    const orderId = 'ORD#01J000000000000000000000';
    const keys = ORDER_STAGES.map((stage) => stageIdempotencyKeyLabel(stage, orderId));
    expect(new Set(keys).size).toBe(ORDER_STAGES.length);
  });

  it('ハッシュ対象は注文 ID だけ（引数の他の項目でキーが変わらない）', () => {
    expect(IDEMPOTENCY_KEY_JMES_PATH).toBe('orderId');
  });

  it('冪等レコードは TTL で失効する（要件 16.6）', () => {
    expect(IDEMPOTENCY_EXPIRY_SECONDS).toBeGreaterThan(0);
  });
});

describe('isRetryableIdempotencyError（design §E-5）', () => {
  it('冪等性と無関係な例外は再試行対象と判定しない', () => {
    expect(isRetryableIdempotencyError(new Error('boom'))).toBe(false);
    expect(isRetryableIdempotencyError(undefined)).toBe(false);
    expect(isRetryableIdempotencyError('在庫不足')).toBe(false);
  });
});

describe('カスタムメトリクス（design 論点 9 / §6.1）', () => {
  it('ダッシュボードが参照する名前と一致する', () => {
    expect(METRIC_NAMES.ordersProcessed).toBe('OrdersProcessed');
    expect(METRIC_NAMES.stageDurationMs).toBe('StageDurationMs');
  });

  it('段階別に見るためのディメンションを持つ', () => {
    expect(METRIC_DIMENSIONS.stage).toBe('Stage');
  });

  it('名前空間を明示している（環境変数任せにしない）', () => {
    expect(METRICS_NAMESPACE).toBe('KiroRoasters/OrderPipeline');
  });
});
