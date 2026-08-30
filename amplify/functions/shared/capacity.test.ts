import { describe, expect, it } from 'vitest';
import {
  ASSUMED_OPEN_SHARD_COUNT as SYNTH_ASSUMED_OPEN_SHARD_COUNT,
  ASSUMED_STAGE_OVERHEAD_MS as SYNTH_ASSUMED_STAGE_OVERHEAD_MS,
  estimateCapacityPerMinute as synthEstimateCapacityPerMinute,
} from '../../custom/verification-config.js';
import {
  ASSUMED_OPEN_SHARD_COUNT,
  ASSUMED_STAGE_OVERHEAD_MS,
  buildCapacityEstimate,
  estimateCapacityPerMinute,
  resolveRecordProcessingMs,
} from './capacity.js';

/**
 * 消費能力の見積もりの単体テスト（design §2.1 / §2.2、要件 19.3）。
 *
 * 検算の基準は **設計時の想定 D = 3,600ms**（擬似待機 3,500ms + `ASSUMED_STAGE_OVERHEAD_MS`
 * = 100ms）であり、S = 4 のとき P=1 → 67/分、P=10 → 667/分 になる。
 *
 * **これは design §2.2 が現在載せている数字ではない。** タスク 14 の実測 D は
 * 3,652.57ms で、式 `S × P ÷ D` が与える値は 65.7/分 と 657/分 である
 * （オーバーヘッドの実測 152.57ms、ウォーム n = 25、`us-west-2`、2026-08-29）。
 *
 * **さらに「式の値」と「実測の壁の位置」も別物である**（design §2.2 の 7'）。
 * P = 1 の壁は式どおり **66.30/分**（実測、−0.2%）だが、
 * **P = 10 の壁は 557.5〜569.6/分 で、式の 0.84〜0.85 倍にとどまる。**
 * この層が検証するのは式そのものなので、期待値は式の値のままで正しい。
 * **スケール損失 0.84 をここに持ち込まないこと。**
 *
 * ここが想定 D のままなのは、この層が検証しているのが
 * `ASSUMED_STAGE_OVERHEAD_MS` を既定値として使う `GET /config` の見積もり
 * （`shardCountSource` = `ASSUMED`）そのものだからである。定数を据え置いている
 * 理由と帰結は `capacity.ts` の当該定数のコメントを参照。
 * 実測 D による式の検証は `src/lib/orders/capacity.test.ts` にある。
 *
 * したがって、design の数字に合わせてここを書き換えてはならない。
 * 落ちるべきなのは `ASSUMED_STAGE_OVERHEAD_MS` を変えたときである。
 */

describe('estimateCapacityPerMinute（design §2.1: S × P ÷ D）', () => {
  it('S=4, P=1, D=3.6 秒 で約 67/分（想定 D。実測 D では 65.7/分）', () => {
    const capacity = estimateCapacityPerMinute({
      shardCount: 4,
      parallelizationFactor: 1,
      recordProcessingMs: 3_600,
    });

    expect(Math.round(capacity)).toBe(67);
  });

  it('S=4, P=10, D=3.6 秒 で約 667/分（想定 D。実測 D では 657/分）', () => {
    const capacity = estimateCapacityPerMinute({
      shardCount: 4,
      parallelizationFactor: 10,
      recordProcessingMs: 3_600,
    });

    expect(Math.round(capacity)).toBe(667);
  });

  it('S を 100 に増やすと同時実行 1,000（Lambda の枠）に届く（design §2.6 の軸 B）', () => {
    const capacity = estimateCapacityPerMinute({
      shardCount: 100,
      parallelizationFactor: 10,
      recordProcessingMs: 3_600,
    });

    // S × P = 1,000。毎分 1,000 × 60,000 / 3,600 ≒ 16,667 件
    expect(Math.round(capacity)).toBe(16_667);
  });

  it('処理時間が 0 以下なら例外にする（消費能力が定義できない）', () => {
    expect(() =>
      estimateCapacityPerMinute({
        shardCount: 4,
        parallelizationFactor: 1,
        recordProcessingMs: 0,
      })
    ).toThrow(RangeError);
    expect(() =>
      estimateCapacityPerMinute({
        shardCount: 4,
        parallelizationFactor: 1,
        recordProcessingMs: -1,
      })
    ).toThrow(RangeError);
  });
});

describe('resolveRecordProcessingMs', () => {
  it('擬似待機（決済 + 通知）にオーバーヘッド想定を足す', () => {
    expect(resolveRecordProcessingMs({ payment: 3_000, notification: 500 })).toBe(
      3_500 + ASSUMED_STAGE_OVERHEAD_MS
    );
  });

  it('既定値では design §2.2 の前提 D = 3.6 秒 になる', () => {
    expect(resolveRecordProcessingMs({ payment: 3_000, notification: 500 })).toBe(3_600);
  });

  it('オーバーヘッドを実測値で置き換えられる（タスク 14）', () => {
    expect(resolveRecordProcessingMs({ payment: 3_000, notification: 500 }, 900)).toBe(4_400);
  });
});

describe('buildCapacityEstimate', () => {
  const stageDelaysMs = { payment: 3_000, notification: 500 };

  it('シャード数を渡さないと暫定値を使い、その事実を応答に残す', () => {
    const estimate = buildCapacityEstimate({ parallelizationFactor: 1, stageDelaysMs });

    expect(estimate.openShardCount).toBe(ASSUMED_OPEN_SHARD_COUNT);
    expect(estimate.shardCountSource).toBe('ASSUMED');
    expect(estimate.maxConcurrency).toBe(ASSUMED_OPEN_SHARD_COUNT);
    expect(estimate.pseudoDelayMs).toBe(3_500);
    expect(estimate.assumedOverheadMs).toBe(ASSUMED_STAGE_OVERHEAD_MS);
    expect(estimate.recordProcessingMs).toBe(3_600);
    expect(Math.round(estimate.estimatedCapacityPerMinute)).toBe(67);
  });

  it('実測シャード数を渡すと MEASURED になる（要件 19.1 の記録に使う）', () => {
    const estimate = buildCapacityEstimate({
      parallelizationFactor: 10,
      stageDelaysMs,
      openShardCount: 12,
    });

    expect(estimate.openShardCount).toBe(12);
    expect(estimate.shardCountSource).toBe('MEASURED');
    expect(estimate.maxConcurrency).toBe(120);
    expect(Math.round(estimate.estimatedCapacityPerMinute)).toBe(2_000);
  });

  it('PF を上げると見積もりが比例して増える', () => {
    const p1 = buildCapacityEstimate({ parallelizationFactor: 1, stageDelaysMs });
    const p10 = buildCapacityEstimate({ parallelizationFactor: 10, stageDelaysMs });

    expect(p10.estimatedCapacityPerMinute).toBeCloseTo(
      p1.estimatedCapacityPerMinute * 10,
      6
    );
  });

  it('擬似処理時間を下げると見積もりが増える（シナリオ A6 の条件）', () => {
    const estimate = buildCapacityEstimate({
      parallelizationFactor: 10,
      stageDelaysMs: { payment: 100, notification: 500 },
    });

    // D = 100 + 500 + 100 = 700ms → 4 × 10 × 60000 / 700
    expect(estimate.recordProcessingMs).toBe(700);
    expect(Math.round(estimate.estimatedCapacityPerMinute)).toBe(3_429);
  });
});

/**
 * 合成側（`amplify/custom/verification-config.ts`）との突き合わせ。
 *
 * 同じ式と暫定値が 2 箇所にある（`shared/` は Lambda からのみ参照する規約のため）。
 * 片方だけ更新すると `GET /config` の見積もりとデプロイ時のログが食い違うので、
 * `runtime-config.test.ts` と同じ方式でここで縛る。
 */
describe('合成側との一致', () => {
  it('暫定値（S とオーバーヘッド）が一致する', () => {
    expect(ASSUMED_OPEN_SHARD_COUNT).toBe(SYNTH_ASSUMED_OPEN_SHARD_COUNT);
    expect(ASSUMED_STAGE_OVERHEAD_MS).toBe(SYNTH_ASSUMED_STAGE_OVERHEAD_MS);
  });

  it('同じ入力で同じ消費能力を返す', () => {
    for (const parallelizationFactor of [1, 5, 10]) {
      for (const recordProcessingMs of [700, 3_600, 10_000]) {
        const input = {
          shardCount: ASSUMED_OPEN_SHARD_COUNT,
          parallelizationFactor,
          recordProcessingMs,
        };
        expect(estimateCapacityPerMinute(input)).toBe(synthEstimateCapacityPerMinute(input));
      }
    }
  });
});
