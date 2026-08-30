import { describe, expect, it } from "vitest";

import {
  ARITHMETIC_BLOCK_LABELS,
  ARITHMETIC_USABLE_LABEL,
  deriveComparisonRow,
  deriveComparisonRows,
  describeLoadResult,
  describeSaveResult,
  formatArithmeticAvailability,
  formatBacklogGrowth,
  formatDataLossGrace,
  formatDurationSeconds,
  formatErrorCounts,
  formatLatencySummary,
  formatRateComparison,
  formatRecoveryTime,
  formatStageDelays,
  summarizeComparison,
} from "./measurement-comparison";
import { createMeasurementRun, type MeasurementRun } from "./measurement-store";
import { EMPTY_VALUE } from "./order-progress";
import type {
  ExecutionConditionsView,
  LoadTestStatusResponse,
  QueryImpactStatusResponse,
} from "../../lib/orders/types";

/**
 * design §2.4 の数値例に寄せた条件。
 *
 * S=4 / P=1 / D=3,600ms + オーバーヘッドで消費能力 666.7 件/分。
 * 投入 2,000 件/分に対して猶予は約 12 時間になる。
 */
const CONDITIONS: ExecutionConditionsView = {
  openShardCount: 4,
  shardCountError: null,
  parallelizationFactor: 1,
  stageDelaysMs: { payment: 1_800, notification: 1_800 },
  estimatedCapacityPerMinute: 666.7,
  warmThroughputWrite: null,
};

function loadRun(
  overrides: Partial<LoadTestStatusResponse> = {},
  options: { label?: string | null; savedAt?: string } = {}
): MeasurementRun {
  const execution: LoadTestStatusResponse = {
    executionId: "LOAD#01J000000000000000000001",
    executionType: "LOAD_TEST",
    status: "COMPLETED",
    durationSeconds: 300,
    startedAt: "2025-01-01T00:00:00.000Z",
    finishedAt: "2025-01-01T00:05:00.000Z",
    elapsedMs: 300_000,
    errorMessage: null,
    conditions: CONDITIONS,
    targetOrdersPerMinute: 2_000,
    actualOrdersPerMinute: 1_980,
    rateDeviationWarning: false,
    useRampCurve: false,
    submittedCount: 9_900,
    submitErrorCount: 0,
    ...overrides,
  };
  return createMeasurementRun({
    execution,
    label: options.label ?? null,
    savedAt: options.savedAt ?? "2025-01-01T00:06:00.000Z",
  });
}

function measureRun(overrides: Partial<QueryImpactStatusResponse> = {}): MeasurementRun {
  const execution: QueryImpactStatusResponse = {
    executionId: "MEASURE#01J000000000000000000002",
    executionType: "QUERY_IMPACT",
    status: "COMPLETED",
    durationSeconds: 120,
    startedAt: "2025-01-01T00:01:00.000Z",
    finishedAt: "2025-01-01T00:03:00.000Z",
    elapsedMs: 120_000,
    errorMessage: null,
    conditions: CONDITIONS,
    concurrency: 10,
    latencyPercentiles: { p50: 40, p95: 120, p99: 300, max: 900 },
    throttleCount: 3,
    otherErrorCount: 1,
    requestCount: 1_000,
    loadTestId: "LOAD#01J000000000000000000001",
    ...overrides,
  };
  return createMeasurementRun({ execution, savedAt: "2025-01-01T00:03:30.000Z" });
}

describe("deriveComparisonRow: 滞留の算術（design §2.4）", () => {
  it("実測レートと消費能力から滞留の増加率と猶予時間を算出する（要件 20.2 / 20.3）", () => {
    const row = deriveComparisonRow(loadRun());

    expect(row.blockedReason).toBeNull();
    expect(row.backlog).not.toBeNull();
    expect(row.backlog?.regime).toBe("GROWING");
    // 1,980 − 666.7
    expect(row.backlog?.backlogGrowthPerMinute).toBeCloseTo(1_313.3, 1);
    // 86,400 ÷ (1 − 666.7 ÷ 1,980) は約 36 時間（design §2.4 の数値例。訂正後の式）。
    // 訂正前の式 `86,400 ÷ (A ÷ C − 1)` では 43,861 秒 ≒ 12 時間だった
    expect(row.backlog?.secondsUntilDataLoss).toBeCloseTo(130_261, 0);
  });

  it("継続時間ぶん滞留した場合の回復時間を予測する（要件 20.4）", () => {
    const row = deriveComparisonRow(loadRun());

    // 増加率 1,313.3 件/分 × 5 分 ÷ 666.7 件/分 = 約 591 秒
    expect(row.projectedRecoverySeconds).toBeCloseTo(591, 0);
  });

  it("投入が消費能力を下回る実行は猶予時間を持たない（滞留しない）", () => {
    const row = deriveComparisonRow(loadRun({ targetOrdersPerMinute: 100, actualOrdersPerMinute: 99 }));

    expect(row.backlog?.regime).toBe("DRAINING");
    expect(row.backlog?.secondsUntilDataLoss).toBeNull();
    expect(row.projectedRecoverySeconds).toBe(0);
  });
});

describe("deriveComparisonRow: 算術に使えない行（要件 11.11 / Property 11）", () => {
  it("乖離警告が付いた実行は算出値を出さず、警告を立てる", () => {
    const row = deriveComparisonRow(
      loadRun({ rateDeviationWarning: true, actualOrdersPerMinute: 900 })
    );

    expect(row.rateDeviationWarning).toBe(true);
    expect(row.blockedReason).toBe("RATE_DEVIATION");
    expect(row.backlog).toBeNull();
    expect(row.projectedRecoverySeconds).toBeNull();
  });

  it("乖離は消費能力が算出できていても優先して弾く（S が取れていても使えない）", () => {
    const row = deriveComparisonRow(
      loadRun({ rateDeviationWarning: true, actualOrdersPerMinute: 900 })
    );

    expect(row.summary.estimatedCapacityPerMinute).toBe(666.7);
    expect(row.blockedReason).toBe("RATE_DEVIATION");
  });

  it("実行中で実測レートが未記録の行は算出しない", () => {
    const row = deriveComparisonRow(
      loadRun({ status: "RUNNING", actualOrdersPerMinute: null, rateDeviationWarning: null })
    );

    expect(row.blockedReason).toBe("RATE_NOT_RECORDED");
    expect(row.rateDeviationWarning).toBe(false);
    expect(row.backlog).toBeNull();
  });

  it("シャード数が取れず消費能力が算出できない行は算出しない（要件 19.5）", () => {
    const row = deriveComparisonRow(
      loadRun({
        conditions: {
          ...CONDITIONS,
          openShardCount: null,
          shardCountError: "AccessDeniedException",
          estimatedCapacityPerMinute: null,
        },
      })
    );

    expect(row.blockedReason).toBe("SHARD_COUNT_MISSING");
    expect(row.backlog).toBeNull();
  });

  it("並行計測は投入レートを持たないため対象外にする", () => {
    const row = deriveComparisonRow(measureRun());

    expect(row.blockedReason).toBe("NOT_LOAD_TEST");
    expect(row.backlog).toBeNull();
    expect(row.rateDeviationWarning).toBe(false);
  });

  it("保存済みの値が負や非有限でも例外にせず使えない行として扱う", () => {
    const broken = loadRun();
    const row = deriveComparisonRow({
      ...broken,
      summary: { ...broken.summary, actualOrdersPerMinute: -1 },
    });

    expect(row.blockedReason).toBe("RATE_NOT_RECORDED");
    expect(row.backlog).toBeNull();
  });
});

describe("deriveComparisonRows / summarizeComparison", () => {
  it("乖離した実行とシャード数が欠けた実行を表の上でまとめる", () => {
    const rows = deriveComparisonRows([
      loadRun({}, { label: "A3" }),
      loadRun(
        {
          executionId: "LOAD#deviated",
          rateDeviationWarning: true,
          actualOrdersPerMinute: 900,
        },
        { label: "A7" }
      ),
      measureRun({
        conditions: { ...CONDITIONS, openShardCount: null, estimatedCapacityPerMinute: null },
      }),
    ]);

    const summary = summarizeComparison(rows);

    expect(summary.rowCount).toBe(3);
    expect(summary.loadTestCount).toBe(2);
    expect(summary.queryImpactCount).toBe(1);
    expect(summary.deviatedExecutionIds).toEqual(["LOAD#deviated"]);
    expect(summary.shardCountMissingExecutionIds).toEqual([
      "MEASURE#01J000000000000000000002",
    ]);
    expect(summary.hasLightRows).toBe(false);
  });

  it("生データを持たない行（軽量版）を検出する（design §11.4）", () => {
    const run = loadRun();
    const rows = deriveComparisonRows([{ ...run, execution: null }]);

    expect(rows[0].hasRawSnapshot).toBe(false);
    expect(summarizeComparison(rows).hasLightRows).toBe(true);
  });

  it("空の一覧でも壊れない", () => {
    const summary = summarizeComparison(deriveComparisonRows([]));
    expect(summary.rowCount).toBe(0);
    expect(summary.deviatedExecutionIds).toEqual([]);
  });
});

describe("書式", () => {
  it("擬似処理時間は内訳のまま出す（どちらの段階を動かしたかを読めるように）", () => {
    expect(formatStageDelays({ payment: 1_800, notification: 1_800 })).toBe("1,800 + 1,800 ms");
  });

  it("レイテンシ分位点を 1 セルにまとめる（要件 12.3）", () => {
    expect(formatLatencySummary({ p50: 40, p95: 120, p99: 300, max: 900 })).toBe(
      "p50 40 ms / p95 120 ms / p99 300 ms / 最大 900 ms"
    );
  });

  it("計測未完了の分位点は空欄にする", () => {
    expect(formatLatencySummary(null)).toBe(EMPTY_VALUE);
  });

  it("スロットルとその他のエラーを併記する（要件 12.2）", () => {
    expect(formatErrorCounts(measureRun().summary)).toBe("スロットル 3 件 / その他 1 件");
  });

  it("負荷生成の行にはエラー件数の列を出さない", () => {
    expect(formatErrorCounts(loadRun().summary)).toBe(EMPTY_VALUE);
  });

  it("目標と実測の投入レートを並べる（要件 11.11）", () => {
    expect(formatRateComparison(loadRun().summary)).toBe(
      "目標 2,000.0 件/分 / 実測 1,980.0 件/分"
    );
  });

  it("実測が未記録なら実測側だけを空欄にする", () => {
    expect(
      formatRateComparison(loadRun({ actualOrdersPerMinute: null }).summary)
    ).toBe(`目標 2,000.0 件/分 / 実測 ${EMPTY_VALUE}`);
  });

  it("並行計測の行には投入レートの列を出さない", () => {
    expect(formatRateComparison(measureRun().summary)).toBe(EMPTY_VALUE);
  });

  it("滞留の増加率は滞留する行だけ増加として出し、余力の行は余力として出す", () => {
    const growing = deriveComparisonRow(loadRun());
    expect(formatBacklogGrowth(growing.backlog)).toBe("+1,313.3 件/分");

    const draining = deriveComparisonRow(
      loadRun({ targetOrdersPerMinute: 100, actualOrdersPerMinute: 100 })
    );
    expect(formatBacklogGrowth(draining.backlog)).toBe("余力 566.7 件/分");
  });

  it("投入と消費能力が等しい行は均衡として出す（0 件/分と書かない）", () => {
    const steady = deriveComparisonRow(
      loadRun({ targetOrdersPerMinute: 667, actualOrdersPerMinute: 666.7 })
    );
    expect(formatBacklogGrowth(steady.backlog)).toBe("均衡（滞留せず）");
  });

  it("算出できない行の増加率は空欄にする", () => {
    expect(formatBacklogGrowth(null)).toBe(EMPTY_VALUE);
  });

  it("猶予時間は滞留する行だけ時間で出し、しない行は「発生しない」と書く", () => {
    const growing = deriveComparisonRow(loadRun());
    expect(formatDataLossGrace(growing.backlog)).toMatch(/^36 時間 /);

    const draining = deriveComparisonRow(
      loadRun({ targetOrdersPerMinute: 100, actualOrdersPerMinute: 99 })
    );
    expect(formatDataLossGrace(draining.backlog)).toBe("発生しない");
    expect(formatDataLossGrace(null)).toBe(EMPTY_VALUE);
  });

  it("回復時間は滞留していない行を「滞留なし」と書く", () => {
    expect(formatRecoveryTime(0)).toBe("滞留なし");
    expect(formatRecoveryTime(null)).toBe(EMPTY_VALUE);
    expect(formatRecoveryTime(591)).toBe("9 分 51 秒");
  });

  it("秒数を桁に応じて秒・分・時間で出す", () => {
    expect(formatDurationSeconds(12.34)).toBe("12.3 秒");
    expect(formatDurationSeconds(90)).toBe("1 分 30 秒");
    expect(formatDurationSeconds(43_200)).toBe("12 時間 0 分");
    expect(formatDurationSeconds(-1)).toBe(EMPTY_VALUE);
    expect(formatDurationSeconds(null)).toBe(EMPTY_VALUE);
  });

  it("算術の可否をセルの文字にする", () => {
    expect(formatArithmeticAvailability(deriveComparisonRow(loadRun()))).toBe(
      ARITHMETIC_USABLE_LABEL
    );
    expect(
      formatArithmeticAvailability(
        deriveComparisonRow(loadRun({ rateDeviationWarning: true, actualOrdersPerMinute: 900 }))
      )
    ).toBe(ARITHMETIC_BLOCK_LABELS.RATE_DEVIATION);
  });
});

describe("describeSaveResult", () => {
  it("完全版で保存できたときは何も言わない", () => {
    expect(
      describeSaveResult({ kind: "SAVED", mode: "FULL", storedCount: 3, droppedCount: 0 })
    ).toBeNull();
  });

  it("軽量版に落ちたことを伝える（生データが落ちる。design §11.4）", () => {
    const notice = describeSaveResult({
      kind: "SAVED",
      mode: "LIGHT",
      storedCount: 10,
      droppedCount: 0,
    });

    expect(notice).toContain("軽量版");
    expect(notice).toContain("比較表の列は保持されます");
  });

  it("軽量版で件数も落ちたときは落ちた件数を伝える", () => {
    const notice = describeSaveResult({
      kind: "SAVED",
      mode: "LIGHT",
      storedCount: 10,
      droppedCount: 4,
    });

    expect(notice).toContain("4 件は保存されていません");
  });

  it("ストレージが使えない環境では画面を離れると失われることを伝える", () => {
    expect(describeSaveResult({ kind: "UNAVAILABLE" })).toContain("失われます");
  });

  it("軽量版でも書けなかったときは行の削除を促す", () => {
    expect(
      describeSaveResult({ kind: "FAILED", reason: "QUOTA", message: "quota exceeded" })
    ).toContain("削除");
  });
});

describe("describeLoadResult", () => {
  it("正常な読み込みでは何も言わない", () => {
    expect(
      describeLoadResult({ runs: [], problem: null, skippedCount: 0, light: false })
    ).toBeNull();
  });

  it("壊れた値を破棄したことを伝える（黙って消さない）", () => {
    expect(
      describeLoadResult({ runs: [], problem: "CORRUPT", skippedCount: 0, light: false })
    ).toContain("破棄");
  });

  it("読み飛ばした件数と軽量版であることを伝える", () => {
    const notice = describeLoadResult({
      runs: [],
      problem: null,
      skippedCount: 2,
      light: true,
    });

    expect(notice).toContain("2 件");
    expect(notice).toContain("軽量版");
  });

  it("ストレージが使えない環境を伝える", () => {
    expect(
      describeLoadResult({ runs: [], problem: "UNAVAILABLE", skippedCount: 0, light: false })
    ).toContain("読み込めません");
  });
});
