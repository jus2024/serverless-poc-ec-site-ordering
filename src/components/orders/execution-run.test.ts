import { describe, expect, it } from "vitest";

import {
  AVERAGE_RAMP_FACTOR,
  deriveLoadTestProgress,
  deriveQueryImpactProgress,
  describeExecutionTypeMismatch,
  executionStatusBadgeClass,
  formatPercent,
  formatRatePerMinute,
  formatRatePerSecond,
  formatSeconds,
  isTerminalExecutionStatus,
  parseConcurrencyInput,
  parseDurationSecondsInput,
  parseExecutionIdInput,
  parseOptionalIdInput,
  parseOrdersPerMinuteInput,
  previewLoadTestPlan,
  previewLoadTestPlanFromInputs,
  shouldContinuePolling,
} from "./execution-run";
import { EMPTY_VALUE } from "./order-progress";
import type {
  ExecutionConditionsView,
  LoadTestStatusResponse,
  QueryImpactStatusResponse,
} from "../../lib/orders/types";

/** シャード数が取れた実行の条件（design §4.3） */
const CONDITIONS: ExecutionConditionsView = {
  openShardCount: 4,
  shardCountError: null,
  parallelizationFactor: 1,
  stageDelaysMs: { payment: 1_800, notification: 1_800 },
  estimatedCapacityPerMinute: 666.7,
  warmThroughputWrite: null,
};

function loadTestExecution(
  overrides: Partial<LoadTestStatusResponse> = {}
): LoadTestStatusResponse {
  return {
    executionId: "LOAD#01J000000000000000000000",
    executionType: "LOAD_TEST",
    status: "RUNNING",
    durationSeconds: 300,
    startedAt: "2025-01-01T00:00:00.000Z",
    finishedAt: null,
    elapsedMs: 60_000,
    errorMessage: null,
    conditions: CONDITIONS,
    targetOrdersPerMinute: 1_000,
    actualOrdersPerMinute: null,
    rateDeviationWarning: null,
    useRampCurve: false,
    submittedCount: 1_000,
    submitErrorCount: 0,
    ...overrides,
  };
}

function queryImpactExecution(
  overrides: Partial<QueryImpactStatusResponse> = {}
): QueryImpactStatusResponse {
  return {
    executionId: "MEASURE#01J000000000000000000000",
    executionType: "QUERY_IMPACT",
    status: "RUNNING",
    durationSeconds: 120,
    startedAt: "2025-01-01T00:00:00.000Z",
    finishedAt: null,
    elapsedMs: 60_000,
    errorMessage: null,
    conditions: CONDITIONS,
    concurrency: 10,
    latencyPercentiles: null,
    throttleCount: 0,
    otherErrorCount: 0,
    requestCount: 0,
    loadTestId: null,
    ...overrides,
  };
}

describe("isTerminalExecutionStatus / shouldContinuePolling", () => {
  it("RUNNING は終端ではない", () => {
    expect(isTerminalExecutionStatus("RUNNING")).toBe(false);
  });

  it("COMPLETED / FAILED は終端", () => {
    expect(isTerminalExecutionStatus("COMPLETED")).toBe(true);
    expect(isTerminalExecutionStatus("FAILED")).toBe(true);
  });

  it("実行中はポーリングを続ける", () => {
    expect(shouldContinuePolling({ status: "RUNNING" })).toBe(true);
  });

  it("終端に達したらポーリングを止める（測定対象に自分の照会を混ぜない）", () => {
    expect(shouldContinuePolling({ status: "COMPLETED" })).toBe(false);
    expect(shouldContinuePolling({ status: "FAILED" })).toBe(false);
  });

  it("まだ 1 度も取得できていない状態では続ける", () => {
    // 「状態が分からない」と「終わった」は違う
    expect(shouldContinuePolling(null)).toBe(true);
  });
});

describe("executionStatusBadgeClass", () => {
  it("状態ごとに globals.css のバッジトークンを返す", () => {
    expect(executionStatusBadgeClass("RUNNING")).toBe("badge badge-running");
    expect(executionStatusBadgeClass("COMPLETED")).toBe("badge badge-completed");
    expect(executionStatusBadgeClass("FAILED")).toBe("badge badge-failed");
  });
});

describe("describeExecutionTypeMismatch", () => {
  it("別種別の実行 ID を貼られたことを案内する（404 と区別する）", () => {
    const notice = describeExecutionTypeMismatch("LOAD_TEST", "QUERY_IMPACT");

    expect(notice.title).toContain("負荷生成");
    expect(notice.message).toContain("並行計測");
    expect(notice.retryable).toBe(false);
    expect(notice.isConfigError).toBe(false);
    expect(notice.reference).toBe("executionType: QUERY_IMPACT");
  });
});

describe("パラメータの検証（上限は GET /config 由来）", () => {
  it("上限内の整数を受け付ける", () => {
    expect(parseOrdersPerMinuteInput("1000", 16_000)).toEqual({ ok: true, value: 1_000 });
    expect(parseDurationSecondsInput("300", 900)).toEqual({ ok: true, value: 300 });
    expect(parseConcurrencyInput("10", 100)).toEqual({ ok: true, value: 10 });
  });

  it("上限と下限の境界を含む", () => {
    expect(parseOrdersPerMinuteInput("1", 16_000).ok).toBe(true);
    expect(parseOrdersPerMinuteInput("16000", 16_000).ok).toBe(true);
    expect(parseConcurrencyInput("1", 1).ok).toBe(true);
  });

  it("上限を超えた値を弾き、範囲を案内に含める", () => {
    const result = parseOrdersPerMinuteInput("16001", 16_000);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue).toContain("16,000");
    }
  });

  it("下限（0 件/分・0 並行）を弾く", () => {
    expect(parseOrdersPerMinuteInput("0", 16_000).ok).toBe(false);
    expect(parseConcurrencyInput("0", 100).ok).toBe(false);
    expect(parseDurationSecondsInput("0", 900).ok).toBe(false);
  });

  it("空欄は既定値で補わない（API 側に既定値が無い）", () => {
    const result = parseDurationSecondsInput("   ", 900);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue).toContain("入力してください");
    }
  });

  it("整数以外を弾く", () => {
    expect(parseOrdersPerMinuteInput("1000.5", 16_000).ok).toBe(false);
    expect(parseOrdersPerMinuteInput("-10", 16_000).ok).toBe(false);
    expect(parseOrdersPerMinuteInput("1e3", 16_000).ok).toBe(false);
    expect(parseConcurrencyInput("十", 100).ok).toBe(false);
  });

  it("上限が未取得（null）なら値の妥当性を判断せず弾く（要件 10.6）", () => {
    // 画面に上限を焼き込まないので、上限を知らないうちは通さない
    const result = parseOrdersPerMinuteInput("1000", null);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue).toContain("上限を取得できていない");
    }
  });
});

describe("parseExecutionIdInput / parseOptionalIdInput", () => {
  it("前後の空白を落として受け付ける", () => {
    expect(parseExecutionIdInput("  LOAD#01J  ")).toEqual({ ok: true, value: "LOAD#01J" });
  });

  it("空欄は弾く", () => {
    expect(parseExecutionIdInput("").ok).toBe(false);
  });

  it("接頭辞の形式は検査しない（API の 404 と画面の判定を混ぜない）", () => {
    expect(parseExecutionIdInput("MEASURE#01J").ok).toBe(true);
    expect(parseExecutionIdInput("手で組み立てた ID").ok).toBe(true);
  });

  it("長すぎる ID は弾く", () => {
    expect(parseExecutionIdInput("L".repeat(129)).ok).toBe(false);
  });

  it("省略可能な ID の空欄は未指定（undefined）として扱う", () => {
    expect(parseOptionalIdInput("  ", "顧客 ID")).toEqual({ ok: true, value: undefined });
    expect(parseOptionalIdInput(" test-0001 ", "顧客 ID")).toEqual({
      ok: true,
      value: "test-0001",
    });
  });

  it("省略可能な ID でも長さの上限は効く", () => {
    const result = parseOptionalIdInput("x".repeat(129), "顧客 ID");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issue).toContain("顧客 ID");
    }
  });
});

describe("previewLoadTestPlan（開始前の事前確認）", () => {
  it("定常負荷では 目標レート × 継続時間 が見込み件数になる", () => {
    const preview = previewLoadTestPlan({
      ordersPerMinute: 1_000,
      durationSeconds: 300,
      useRampCurve: false,
    });

    expect(preview.expectedOrdersPerMinute).toBe(1_000);
    expect(preview.estimatedOrderCount).toBe(5_000);
  });

  it("カーブでは平均係数 0.7 を掛けた件数になる（ピークで掛けない）", () => {
    expect(AVERAGE_RAMP_FACTOR).toBeCloseTo(0.7, 10);

    const preview = previewLoadTestPlan({
      ordersPerMinute: 1_000,
      durationSeconds: 300,
      useRampCurve: true,
    });

    expect(preview.peakOrdersPerMinute).toBe(1_000);
    expect(preview.expectedOrdersPerMinute).toBeCloseTo(700, 10);
    expect(preview.estimatedOrderCount).toBe(3_500);
  });

  it("桁を 1 つ間違えた入力は件数も 1 桁変わる（誤りに気づける）", () => {
    const intended = previewLoadTestPlan({
      ordersPerMinute: 1_600,
      durationSeconds: 60,
      useRampCurve: false,
    });
    const mistyped = previewLoadTestPlan({
      ordersPerMinute: 16_000,
      durationSeconds: 60,
      useRampCurve: false,
    });

    expect(intended.estimatedOrderCount).toBe(1_600);
    expect(mistyped.estimatedOrderCount).toBe(16_000);
  });
});

describe("previewLoadTestPlanFromInputs", () => {
  const limits = { maxOrdersPerMinute: 16_000, maxDurationSeconds: 900 };

  it("両方の入力が有効なら計画を返す", () => {
    const preview = previewLoadTestPlanFromInputs({
      ordersPerMinuteInput: "2000",
      durationSecondsInput: "120",
      useRampCurve: false,
      limits,
    });

    expect(preview?.estimatedOrderCount).toBe(4_000);
  });

  it("片方でも無効なら計画を出さない", () => {
    expect(
      previewLoadTestPlanFromInputs({
        ordersPerMinuteInput: "2000",
        durationSecondsInput: "",
        useRampCurve: false,
        limits,
      })
    ).toBeNull();
    expect(
      previewLoadTestPlanFromInputs({
        ordersPerMinuteInput: "99999",
        durationSecondsInput: "120",
        useRampCurve: false,
        limits,
      })
    ).toBeNull();
  });

  it("上限が未取得なら計画を出さない（開始させない）", () => {
    expect(
      previewLoadTestPlanFromInputs({
        ordersPerMinuteInput: "2000",
        durationSecondsInput: "120",
        useRampCurve: false,
        limits: null,
      })
    ).toBeNull();
  });
});

describe("deriveLoadTestProgress", () => {
  it("実行中は実測レートと乖離警告を null のまま保つ（未評価と区別する）", () => {
    const progress = deriveLoadTestProgress(loadTestExecution());

    expect(progress.actualOrdersPerMinute).toBeNull();
    expect(progress.rateDeviationWarning).toBeNull();
    expect(progress.rateAchievement).toBeNull();
  });

  it("投入件数 ÷ 経過時間から暫定レートを出す", () => {
    const progress = deriveLoadTestProgress(
      loadTestExecution({ submittedCount: 500, elapsedMs: 30_000 })
    );

    expect(progress.interimOrdersPerMinute).toBe(1_000);
  });

  it("経過時間が 0 なら暫定レートを出さない", () => {
    const progress = deriveLoadTestProgress(
      loadTestExecution({ submittedCount: 0, elapsedMs: 0 })
    );

    expect(progress.interimOrdersPerMinute).toBeNull();
  });

  it("完了時は記録された実測レートと達成率を出す", () => {
    const progress = deriveLoadTestProgress(
      loadTestExecution({
        status: "COMPLETED",
        submittedCount: 4_900,
        elapsedMs: 300_000,
        actualOrdersPerMinute: 980,
        rateDeviationWarning: false,
      })
    );

    expect(progress.statusLabel).toBe("完了");
    expect(progress.actualOrdersPerMinute).toBe(980);
    expect(progress.rateAchievement).toBeCloseTo(0.98, 10);
    expect(progress.rateDeviationWarning).toBe(false);
  });

  it("カーブ実行の期待レートは目標 × 0.7 になる", () => {
    const progress = deriveLoadTestProgress(
      loadTestExecution({ useRampCurve: true, targetOrdersPerMinute: 1_000 })
    );

    expect(progress.expectedOrdersPerMinute).toBeCloseTo(700, 10);
  });

  it("乖離警告はそのまま持ち上げる（要件 11.11）", () => {
    const progress = deriveLoadTestProgress(
      loadTestExecution({
        status: "COMPLETED",
        actualOrdersPerMinute: 600,
        rateDeviationWarning: true,
      })
    );

    expect(progress.rateDeviationWarning).toBe(true);
  });

  it("投入エラー率は 成功 + 失敗 を分母にする", () => {
    const progress = deriveLoadTestProgress(
      loadTestExecution({ submittedCount: 900, submitErrorCount: 100 })
    );

    expect(progress.attemptedCount).toBe(1_000);
    expect(progress.submitErrorRate).toBeCloseTo(0.1, 10);
  });

  it("1 件も試行していなければエラー率は算出しない", () => {
    const progress = deriveLoadTestProgress(
      loadTestExecution({ submittedCount: 0, submitErrorCount: 0 })
    );

    expect(progress.submitErrorRate).toBeNull();
  });

  it("経過の進捗率は 100 を超えない", () => {
    const progress = deriveLoadTestProgress(
      loadTestExecution({ durationSeconds: 60, elapsedMs: 90_000 })
    );

    expect(progress.progressPercent).toBe(100);
  });

  it("経過時間が取れなければ進捗率を出さない", () => {
    const progress = deriveLoadTestProgress(loadTestExecution({ elapsedMs: null }));

    expect(progress.progressPercent).toBeNull();
  });
});

describe("deriveQueryImpactProgress", () => {
  it("開始直後（リクエスト 0 件）は率を算出しない", () => {
    const progress = deriveQueryImpactProgress(queryImpactExecution());

    expect(progress.errorRate).toBeNull();
    expect(progress.throttleRate).toBeNull();
    expect(progress.requestsPerSecond).toBe(0);
  });

  it("スロットルとその他のエラーを別々に率にする（要件 12.2）", () => {
    const progress = deriveQueryImpactProgress(
      queryImpactExecution({ requestCount: 1_000, throttleCount: 50, otherErrorCount: 10 })
    );

    expect(progress.throttleRate).toBeCloseTo(0.05, 10);
    expect(progress.errorRate).toBeCloseTo(0.06, 10);
    expect(progress.errorCount).toBe(60);
    expect(progress.successCount).toBe(940);
  });

  it("エラー件数が総数を超えても成功件数を負にしない", () => {
    const progress = deriveQueryImpactProgress(
      queryImpactExecution({ requestCount: 10, throttleCount: 20, otherErrorCount: 0 })
    );

    expect(progress.successCount).toBe(0);
  });

  it("実測スループットを件/秒で出す", () => {
    const progress = deriveQueryImpactProgress(
      queryImpactExecution({ requestCount: 6_000, elapsedMs: 120_000 })
    );

    expect(progress.requestsPerSecond).toBe(50);
  });

  it("完了時の分位点はそのまま参照できる（要件 12.3）", () => {
    const execution = queryImpactExecution({
      status: "COMPLETED",
      requestCount: 1_000,
      latencyPercentiles: { p50: 30, p95: 80, p99: 250, max: 900 },
    });
    const progress = deriveQueryImpactProgress(execution);

    expect(progress.statusLabel).toBe("完了");
    expect(execution.latencyPercentiles?.p99).toBe(250);
  });
});

describe("書式", () => {
  it("レートは小数第 1 位まで出す（低レートの差を潰さない）", () => {
    expect(formatRatePerMinute(2)).toBe("2.0 件/分");
    expect(formatRatePerMinute(1_234.56)).toBe("1,234.6 件/分");
    expect(formatRatePerMinute(null)).toBe(EMPTY_VALUE);
  });

  it("スループットは件/秒で出す", () => {
    expect(formatRatePerSecond(50)).toBe("50.0 件/秒");
    expect(formatRatePerSecond(undefined)).toBe(EMPTY_VALUE);
  });

  it("秒数は 3 桁区切りで出す", () => {
    expect(formatSeconds(300)).toBe("300 秒");
    expect(formatSeconds(3_600)).toBe("3,600 秒");
    expect(formatSeconds(null)).toBe(EMPTY_VALUE);
  });

  it("比率は百分率で出し、算出できない場合は 0% に丸めない", () => {
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(0.1234)).toBe("12.3%");
    expect(formatPercent(1)).toBe("100.0%");
    expect(formatPercent(null)).toBe(EMPTY_VALUE);
    expect(formatPercent(Number.NaN)).toBe(EMPTY_VALUE);
  });
});
