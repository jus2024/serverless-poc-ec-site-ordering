import { beforeEach, describe, expect, it } from "vitest";

import {
  LIGHT_MAX_STORED_RUNS,
  MAX_RUN_LABEL_LENGTH,
  MAX_STORED_RUNS,
  MEASUREMENT_SCHEMA_VERSION,
  MEASUREMENT_STORAGE_KEY,
  createMeasurementRun,
  isQuotaExceededError,
  loadMeasurementRuns,
  normalizeRunLabel,
  removeMeasurementRun,
  saveMeasurementRuns,
  summarizeExecution,
  upsertMeasurementRun,
  type MeasurementRun,
  type StorageLike,
} from "./measurement-store";
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
}

function queryImpactExecution(
  overrides: Partial<QueryImpactStatusResponse> = {}
): QueryImpactStatusResponse {
  return {
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
}

/** `localStorage` の代役。`quotaAt` バイトを超える書き込みを容量超過にする */
class FakeStorage implements StorageLike {
  private readonly entries = new Map<string, string>();
  /** `setItem` に渡された値の履歴（軽量版で書き直したことの確認に使う） */
  readonly writes: string[] = [];
  removeCount = 0;

  constructor(
    private readonly quotaAt: number = Number.POSITIVE_INFINITY,
    private readonly throwOnGet = false
  ) {}

  getItem(key: string): string | null {
    if (this.throwOnGet) {
      throw new Error("access denied");
    }
    return this.entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.writes.push(value);
    if (value.length > this.quotaAt) {
      const error = new Error("quota exceeded") as Error & { name: string };
      error.name = "QuotaExceededError";
      throw error;
    }
    this.entries.set(key, value);
  }

  removeItem(key: string): void {
    this.removeCount += 1;
    this.entries.delete(key);
  }
}

describe("summarizeExecution", () => {
  it("負荷生成では投入レートと乖離警告を写し、並行計測側の列は null にする", () => {
    const summary = summarizeExecution(loadTestExecution());

    expect(summary.executionType).toBe("LOAD_TEST");
    expect(summary.targetOrdersPerMinute).toBe(2_000);
    expect(summary.actualOrdersPerMinute).toBe(1_980);
    expect(summary.rateDeviationWarning).toBe(false);
    expect(summary.latencyPercentiles).toBeNull();
    expect(summary.throttleCount).toBeNull();
  });

  it("並行計測では分位点とエラー件数を写し、投入レート側の列は null にする", () => {
    const summary = summarizeExecution(queryImpactExecution());

    expect(summary.executionType).toBe("QUERY_IMPACT");
    expect(summary.latencyPercentiles).toEqual({ p50: 40, p95: 120, p99: 300, max: 900 });
    expect(summary.throttleCount).toBe(3);
    expect(summary.otherErrorCount).toBe(1);
    expect(summary.loadTestId).toBe("LOAD#01J000000000000000000001");
    expect(summary.targetOrdersPerMinute).toBeNull();
    expect(summary.rateDeviationWarning).toBeNull();
  });

  it("design §11.2 の実行条件（S / P / D / 消費能力）を写す", () => {
    const summary = summarizeExecution(loadTestExecution());

    expect(summary.openShardCount).toBe(4);
    expect(summary.parallelizationFactor).toBe(1);
    expect(summary.stageDelaysMs).toEqual({ payment: 1_800, notification: 1_800 });
    expect(summary.estimatedCapacityPerMinute).toBe(666.7);
  });

  it("シャード数を取得できなかった実行では S と消費能力が null のまま残る（要件 19.5）", () => {
    const summary = summarizeExecution(
      loadTestExecution({
        conditions: {
          ...CONDITIONS,
          openShardCount: null,
          shardCountError: "AccessDeniedException",
          estimatedCapacityPerMinute: null,
        },
      })
    );

    expect(summary.openShardCount).toBeNull();
    expect(summary.shardCountError).toBe("AccessDeniedException");
    expect(summary.estimatedCapacityPerMinute).toBeNull();
  });
});

describe("normalizeRunLabel", () => {
  it("前後の空白を落とす", () => {
    expect(normalizeRunLabel("  A3  ")).toBe("A3");
  });

  it("空欄と未指定は null", () => {
    expect(normalizeRunLabel("")).toBeNull();
    expect(normalizeRunLabel("   ")).toBeNull();
    expect(normalizeRunLabel(null)).toBeNull();
    expect(normalizeRunLabel(undefined)).toBeNull();
  });

  it("長すぎるラベルは切り詰める（保存容量を守る）", () => {
    const label = normalizeRunLabel("あ".repeat(MAX_RUN_LABEL_LENGTH + 10));
    expect(label).toHaveLength(MAX_RUN_LABEL_LENGTH);
  });
});

describe("upsertMeasurementRun / removeMeasurementRun", () => {
  it("同じ実行 ID は差し替え、先頭に移す（完了後の再取得で行が更新される）", () => {
    const running = createMeasurementRun({
      execution: loadTestExecution({ status: "RUNNING", actualOrdersPerMinute: null }),
      label: "A3",
      savedAt: "2025-01-01T00:00:00.000Z",
    });
    const other = createMeasurementRun({
      execution: queryImpactExecution(),
      savedAt: "2025-01-01T00:01:00.000Z",
    });
    const completed = createMeasurementRun({
      execution: loadTestExecution(),
      label: "A3",
      savedAt: "2025-01-01T00:06:00.000Z",
    });

    const runs = upsertMeasurementRun(upsertMeasurementRun([running], other), completed);

    expect(runs).toHaveLength(2);
    expect(runs[0].summary.executionId).toBe("LOAD#01J000000000000000000001");
    expect(runs[0].summary.actualOrdersPerMinute).toBe(1_980);
  });

  it("上限を超えた古い実行は落とす", () => {
    let runs: MeasurementRun[] = [];
    for (let index = 0; index < MAX_STORED_RUNS + 5; index += 1) {
      runs = upsertMeasurementRun(
        runs,
        createMeasurementRun({
          execution: loadTestExecution({ executionId: `LOAD#${index}` }),
          savedAt: `2025-01-01T00:00:0${index % 10}.000Z`,
        })
      );
    }

    expect(runs).toHaveLength(MAX_STORED_RUNS);
    expect(runs[0].summary.executionId).toBe(`LOAD#${MAX_STORED_RUNS + 4}`);
  });

  it("実行 ID で一覧から外せる", () => {
    const runs = [
      createMeasurementRun({ execution: loadTestExecution() }),
      createMeasurementRun({ execution: queryImpactExecution() }),
    ];

    const remaining = removeMeasurementRun(runs, "LOAD#01J000000000000000000001");

    expect(remaining).toHaveLength(1);
    expect(remaining[0].summary.executionType).toBe("QUERY_IMPACT");
  });
});

describe("isQuotaExceededError", () => {
  it("Chrome / Safari の名前とコードを容量超過とみなす", () => {
    expect(isQuotaExceededError({ name: "QuotaExceededError" })).toBe(true);
    expect(isQuotaExceededError({ code: 22 })).toBe(true);
  });

  it("Firefox の名前とコードも容量超過とみなす", () => {
    expect(isQuotaExceededError({ name: "NS_ERROR_DOM_QUOTA_REACHED" })).toBe(true);
    expect(isQuotaExceededError({ code: 1014 })).toBe(true);
  });

  it("それ以外の例外は容量超過ではない", () => {
    expect(isQuotaExceededError(new Error("boom"))).toBe(false);
    expect(isQuotaExceededError(null)).toBe(false);
    expect(isQuotaExceededError("QuotaExceededError")).toBe(false);
  });
});

describe("saveMeasurementRuns / loadMeasurementRuns", () => {
  let runs: MeasurementRun[];

  beforeEach(() => {
    runs = [
      createMeasurementRun({
        execution: loadTestExecution(),
        label: "A3",
        savedAt: "2025-01-01T00:06:00.000Z",
      }),
      createMeasurementRun({
        execution: queryImpactExecution(),
        label: "A3 並行計測",
        savedAt: "2025-01-01T00:03:00.000Z",
      }),
    ];
  });

  it("保存して読み直すと同じ行が新しい順で戻る", () => {
    const storage = new FakeStorage();

    const saved = saveMeasurementRuns(storage, runs);
    expect(saved).toEqual({ kind: "SAVED", mode: "FULL", storedCount: 2, droppedCount: 0 });

    const loaded = loadMeasurementRuns(storage);
    expect(loaded.problem).toBeNull();
    expect(loaded.light).toBe(false);
    expect(loaded.skippedCount).toBe(0);
    expect(loaded.runs.map((run) => run.summary.executionId)).toEqual([
      "LOAD#01J000000000000000000001",
      "MEASURE#01J000000000000000000002",
    ]);
    expect(loaded.runs[0].label).toBe("A3");
    // 完全版では生データが残る
    expect(loaded.runs[0].execution).not.toBeNull();
    expect(loaded.runs[0].execution?.errorMessage).toBeNull();
  });

  it("容量超過なら生データを落とした軽量版で再試行する（design §11.4）", () => {
    // 完全版は通らず、生データを落とした版なら通る大きさに合わせる
    const full = JSON.stringify({
      version: MEASUREMENT_SCHEMA_VERSION,
      light: false,
      runs: runs.map((run) => ({ savedAt: run.savedAt, label: run.label, execution: run.execution })),
    });
    const lightSize = JSON.stringify({
      version: MEASUREMENT_SCHEMA_VERSION,
      light: true,
      runs: runs.map((run) => ({ savedAt: run.savedAt, label: run.label, summary: run.summary })),
    }).length;
    expect(lightSize).toBeLessThan(full.length);

    const storage = new FakeStorage(lightSize);
    const saved = saveMeasurementRuns(storage, runs);

    expect(saved).toEqual({ kind: "SAVED", mode: "LIGHT", storedCount: 2, droppedCount: 0 });
    // 2 回書いている（完全版で失敗 → 軽量版で成功）
    expect(storage.writes).toHaveLength(2);

    const loaded = loadMeasurementRuns(storage);
    expect(loaded.light).toBe(true);
    expect(loaded.runs).toHaveLength(2);
    // 生データは落ちるが、比較表の列は残る
    expect(loaded.runs[0].execution).toBeNull();
    expect(loaded.runs[0].summary.estimatedCapacityPerMinute).toBe(666.7);
    expect(loaded.runs[0].summary.actualOrdersPerMinute).toBe(1_980);
  });

  it("軽量版でも乖離警告は落とさない（要件 11.11 / Property 11）", () => {
    const deviated = [
      createMeasurementRun({
        execution: loadTestExecution({ rateDeviationWarning: true, actualOrdersPerMinute: 900 }),
        savedAt: "2025-01-01T00:06:00.000Z",
      }),
    ];
    // 完全版が必ず失敗する大きさにする
    const storage = new FakeStorage(1);
    expect(saveMeasurementRuns(storage, deviated).kind).toBe("FAILED");

    // 軽量版が通る大きさで書き直す
    const permissive = new FakeStorage(
      JSON.stringify({
        version: MEASUREMENT_SCHEMA_VERSION,
        light: true,
        runs: deviated.map((run) => ({
          savedAt: run.savedAt,
          label: run.label,
          summary: run.summary,
        })),
      }).length
    );
    expect(saveMeasurementRuns(permissive, deviated)).toMatchObject({ mode: "LIGHT" });

    const loaded = loadMeasurementRuns(permissive);
    expect(loaded.runs[0].summary.rateDeviationWarning).toBe(true);
  });

  it("軽量版では上限を超えた古い実行を落とし、件数を返す", () => {
    let many: MeasurementRun[] = [];
    for (let index = 0; index < LIGHT_MAX_STORED_RUNS + 4; index += 1) {
      many = upsertMeasurementRun(
        many,
        createMeasurementRun({
          execution: loadTestExecution({ executionId: `LOAD#${index}` }),
          savedAt: new Date(Date.UTC(2025, 0, 1, 0, index)).toISOString(),
        })
      );
    }

    const light = JSON.stringify({
      version: MEASUREMENT_SCHEMA_VERSION,
      light: true,
      runs: many.slice(0, LIGHT_MAX_STORED_RUNS).map((run) => ({
        savedAt: run.savedAt,
        label: run.label,
        summary: run.summary,
      })),
    }).length;

    const storage = new FakeStorage(light);
    const saved = saveMeasurementRuns(storage, many);

    expect(saved).toEqual({
      kind: "SAVED",
      mode: "LIGHT",
      storedCount: LIGHT_MAX_STORED_RUNS,
      droppedCount: 4,
    });
  });

  it("軽量版でも書けなければ失敗として返し、例外は投げない", () => {
    const storage = new FakeStorage(1);
    const saved = saveMeasurementRuns(storage, runs);

    expect(saved).toMatchObject({ kind: "FAILED", reason: "QUOTA" });
  });

  it("空の一覧を保存するとキーを消す", () => {
    const storage = new FakeStorage();
    saveMeasurementRuns(storage, runs);

    const saved = saveMeasurementRuns(storage, []);

    expect(saved).toEqual({ kind: "SAVED", mode: "FULL", storedCount: 0, droppedCount: 0 });
    expect(storage.removeCount).toBe(1);
    expect(loadMeasurementRuns(storage).runs).toEqual([]);
  });

  it("`localStorage` が使えない環境では UNAVAILABLE を返す（SSR / プライベートモード）", () => {
    expect(saveMeasurementRuns(null, runs)).toEqual({ kind: "UNAVAILABLE" });
    expect(loadMeasurementRuns(null)).toEqual({
      runs: [],
      problem: "UNAVAILABLE",
      skippedCount: 0,
      light: false,
    });
  });

  it("読み取り自体が例外になる環境でも壊れない", () => {
    const storage = new FakeStorage(Number.POSITIVE_INFINITY, true);
    expect(loadMeasurementRuns(storage).problem).toBe("UNAVAILABLE");
  });

  it("未保存なら空の一覧を返す（異常ではない）", () => {
    const loaded = loadMeasurementRuns(new FakeStorage());
    expect(loaded).toEqual({ runs: [], problem: null, skippedCount: 0, light: false });
  });

  it("JSON として読めない値は捨てる", () => {
    const storage = new FakeStorage();
    storage.setItem(MEASUREMENT_STORAGE_KEY, "{ not json");

    expect(loadMeasurementRuns(storage)).toEqual({
      runs: [],
      problem: "CORRUPT",
      skippedCount: 0,
      light: false,
    });
  });

  it("版が違う値は捨てる", () => {
    const storage = new FakeStorage();
    storage.setItem(
      MEASUREMENT_STORAGE_KEY,
      JSON.stringify({ version: MEASUREMENT_SCHEMA_VERSION + 1, light: false, runs: [] })
    );

    expect(loadMeasurementRuns(storage).problem).toBe("CORRUPT");
  });

  it("形が合わない行だけを読み飛ばし、件数を返す", () => {
    const storage = new FakeStorage();
    storage.setItem(
      MEASUREMENT_STORAGE_KEY,
      JSON.stringify({
        version: MEASUREMENT_SCHEMA_VERSION,
        light: false,
        runs: [
          { savedAt: "2025-01-01T00:06:00.000Z", label: null, execution: loadTestExecution() },
          { savedAt: "2025-01-01T00:05:00.000Z", label: null },
          { label: "時刻が無い", execution: loadTestExecution() },
          "文字列",
        ],
      })
    );

    const loaded = loadMeasurementRuns(storage);
    expect(loaded.runs).toHaveLength(1);
    expect(loaded.skippedCount).toBe(3);
  });
});
