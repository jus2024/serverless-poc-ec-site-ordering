/**
 * `types.ts` が公開する判別ヘルパーの単体テスト。
 *
 * 型定義そのものは `npx tsc --noEmit` が検証する。ここで確かめるのは
 * 実行時に分岐する 3 つの関数だけである。
 */

import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  isApiErrorCode,
  isLoadTestStatus,
  isQueryImpactStatus,
  type ExecutionStatusResponse,
  type LoadTestStatusResponse,
  type QueryImpactStatusResponse,
} from "./types";

const conditions = {
  openShardCount: 4,
  shardCountError: null,
  parallelizationFactor: 1,
  stageDelaysMs: { payment: 3000, notification: 500 },
  estimatedCapacityPerMinute: 68,
  warmThroughputWrite: null,
};

const loadTest: LoadTestStatusResponse = {
  executionId: "EXEC#LOAD#01J",
  executionType: "LOAD_TEST",
  status: "RUNNING",
  durationSeconds: 300,
  startedAt: "2025-01-01T00:00:00.000Z",
  finishedAt: null,
  elapsedMs: 1000,
  errorMessage: null,
  conditions,
  targetOrdersPerMinute: 2000,
  actualOrdersPerMinute: null,
  rateDeviationWarning: null,
  useRampCurve: false,
  submittedCount: 0,
  submitErrorCount: 0,
};

const queryImpact: QueryImpactStatusResponse = {
  executionId: "EXEC#QUERY#01J",
  executionType: "QUERY_IMPACT",
  status: "RUNNING",
  durationSeconds: 60,
  startedAt: "2025-01-01T00:00:00.000Z",
  finishedAt: null,
  elapsedMs: 1000,
  errorMessage: null,
  conditions,
  concurrency: 20,
  latencyPercentiles: null,
  throttleCount: 0,
  otherErrorCount: 0,
  requestCount: 0,
  loadTestId: "EXEC#LOAD#01J",
};

describe("実行種別の判別（design §11.1 のパネル振り分け）", () => {
  it("負荷生成の実行を判別する", () => {
    const execution: ExecutionStatusResponse = loadTest;

    expect(isLoadTestStatus(execution)).toBe(true);
    expect(isQueryImpactStatus(execution)).toBe(false);
  });

  it("並行計測の実行を判別する", () => {
    const execution: ExecutionStatusResponse = queryImpact;

    expect(isQueryImpactStatus(execution)).toBe(true);
    expect(isLoadTestStatus(execution)).toBe(false);
  });
});

describe("isApiErrorCode", () => {
  it("design §E-1 の全コードを既知として扱う", () => {
    for (const code of Object.values(API_ERROR_CODES)) {
      expect(isApiErrorCode(code)).toBe(true);
    }
  });

  it("未知のコードは false（画面は汎用の失敗表示に落ちる）", () => {
    expect(isApiErrorCode("INVALID_RESPONSE")).toBe(false);
    expect(isApiErrorCode("")).toBe(false);
  });

  it("Object のプロトタイプ由来の名前を既知と誤判定しない", () => {
    expect(isApiErrorCode("toString")).toBe(false);
    expect(isApiErrorCode("constructor")).toBe(false);
  });
});
