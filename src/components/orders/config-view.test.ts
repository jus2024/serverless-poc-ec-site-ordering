import { describe, expect, it } from "vitest";

import {
  SHARD_COUNT_SOURCE_LABELS,
  deriveCapacityCrossCheck,
  deriveVerificationConfigView,
  describeShardCountSource,
} from "./config-view";
import type { CapacityEstimate, VerificationConfigResponse } from "../../lib/orders/types";

/**
 * design §2.4 の数値例に整合した見積もり。
 *
 * S=40 / P=1 / D=3,600ms → 40 × 60,000 ÷ 3,600 = 666.7 件/分。
 * Lambda 側は小数第 1 位に丸めて返す。
 */
function capacityEstimate(overrides: Partial<CapacityEstimate> = {}): CapacityEstimate {
  return {
    openShardCount: 40,
    shardCountSource: "ASSUMED",
    parallelizationFactor: 1,
    maxConcurrency: 40,
    pseudoDelayMs: 3_600,
    assumedOverheadMs: 0,
    recordProcessingMs: 3_600,
    estimatedCapacityPerMinute: 666.7,
    ...overrides,
  };
}

function verificationConfig(
  capacity: CapacityEstimate = capacityEstimate()
): VerificationConfigResponse {
  return {
    pipelineMode: "direct",
    stream: { batchSize: 1, parallelizationFactor: capacity.parallelizationFactor },
    stageDelaysMs: { payment: 1_800, notification: 1_800 },
    paymentFailureRate: 0,
    dataTtlDays: 7,
    limits: {
      maxOrdersPerMinute: 16_000,
      maxDurationSeconds: 600,
      maxMeasureConcurrency: 50,
    },
    capacity,
  };
}

describe("describeShardCountSource", () => {
  it("実測値は実測と表示し、消費能力もその値によることを述べる", () => {
    const view = describeShardCountSource("MEASURED");

    expect(view.measured).toBe(true);
    expect(view.label).toBe(SHARD_COUNT_SOURCE_LABELS.MEASURED);
    expect(view.note).toContain("DescribeStream");
  });

  it("暫定値は暫定と表示し、実測値の確認先を案内する（design Property 10）", () => {
    const view = describeShardCountSource("ASSUMED");

    expect(view.measured).toBe(false);
    expect(view.label).toBe(SHARD_COUNT_SOURCE_LABELS.ASSUMED);
    // 実測値は実行レコードにしか残らないため、そこへ導く
    expect(view.note).toContain("実行レコード");
  });
});

describe("deriveCapacityCrossCheck", () => {
  it("API の見積もりと画面側の再計算が一致することを確かめる", () => {
    const check = deriveCapacityCrossCheck(capacityEstimate());

    expect(check.reported).toBe(666.7);
    expect(check.recomputed).toBeCloseTo(666.67, 2);
    expect(check.recordProcessingMs).toBe(3_600);
    expect(check.matches).toBe(true);
    expect(check.problem).toBeNull();
  });

  it("丸め誤差の範囲は一致とみなす（Lambda 側は小数第 1 位に丸める）", () => {
    const check = deriveCapacityCrossCheck(
      capacityEstimate({ estimatedCapacityPerMinute: 666.6 })
    );

    expect(check.matches).toBe(true);
  });

  it("式が食い違っていれば不一致として返す（重複した実装のドリフト検知）", () => {
    const check = deriveCapacityCrossCheck(
      capacityEstimate({ estimatedCapacityPerMinute: 1_000 })
    );

    expect(check.matches).toBe(false);
    expect(check.recomputed).toBeCloseTo(666.67, 2);
  });

  it("オーバーヘッドを含めた D で再計算する", () => {
    const check = deriveCapacityCrossCheck(
      capacityEstimate({
        assumedOverheadMs: 400,
        recordProcessingMs: 4_000,
        estimatedCapacityPerMinute: 600,
      })
    );

    expect(check.recordProcessingMs).toBe(4_000);
    expect(check.recomputed).toBeCloseTo(600, 6);
    expect(check.matches).toBe(true);
  });

  it("D が 0 の応答では例外を投げず、理由を返す", () => {
    const check = deriveCapacityCrossCheck(
      capacityEstimate({ pseudoDelayMs: 0, assumedOverheadMs: 0, recordProcessingMs: 0 })
    );

    expect(check.recomputed).toBeNull();
    expect(check.matches).toBeNull();
    expect(check.problem).not.toBeNull();
  });
});

describe("deriveVerificationConfigView", () => {
  it("S × P を突き合わせ、オーバーヘッドの割合を出す", () => {
    const view = deriveVerificationConfigView(
      verificationConfig(
        capacityEstimate({
          assumedOverheadMs: 400,
          recordProcessingMs: 4_000,
          estimatedCapacityPerMinute: 600,
        })
      )
    );

    expect(view.maxConcurrency).toBe(40);
    expect(view.maxConcurrencyMatches).toBe(true);
    expect(view.overheadShare).toBeCloseTo(0.1, 6);
    expect(view.shardCount.measured).toBe(false);
    expect(view.capacity.matches).toBe(true);
  });

  it("API の `maxConcurrency` が S × P と合わなければ不一致として返す", () => {
    const view = deriveVerificationConfigView(
      verificationConfig(capacityEstimate({ maxConcurrency: 10 }))
    );

    expect(view.maxConcurrency).toBe(40);
    expect(view.maxConcurrencyMatches).toBe(false);
  });

  it("D が 0 ならオーバーヘッドの割合は算出しない", () => {
    const view = deriveVerificationConfigView(
      verificationConfig(capacityEstimate({ recordProcessingMs: 0 }))
    );

    expect(view.overheadShare).toBeNull();
  });
});
