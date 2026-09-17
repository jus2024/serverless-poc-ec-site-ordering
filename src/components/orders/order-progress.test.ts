import { describe, expect, it } from "vitest";

import type { OrderStatusResponse, StageProgress } from "../../lib/orders/types";
import {
  EMPTY_VALUE,
  deriveStageProgress,
  formatCount,
  formatElapsedMs,
  formatJpy,
  formatTimestamp,
  isTerminalOrderStatus,
  orderStatusBadgeClass,
} from "./order-progress";

/** 完了した段階を組み立てる */
function done(
  stage: StageProgress["stage"],
  elapsedMs: number,
  completedAt = "2025-01-01T00:00:00.000Z"
): StageProgress {
  return { stage, status: "DONE", completedAt, elapsedMs };
}

/** 未完了の段階 */
function waiting(stage: StageProgress["stage"]): StageProgress {
  return { stage, status: "WAITING", completedAt: null, elapsedMs: null };
}

describe("formatElapsedMs", () => {
  it("1 秒未満はミリ秒で表示する", () => {
    expect(formatElapsedMs(0)).toBe("0 ms");
    expect(formatElapsedMs(1)).toBe("1 ms");
    expect(formatElapsedMs(999)).toBe("999 ms");
  });

  it("1 分未満は秒で表示する", () => {
    expect(formatElapsedMs(1_000)).toBe("1.00 秒");
    expect(formatElapsedMs(3_600)).toBe("3.60 秒");
    expect(formatElapsedMs(12_345)).toBe("12.34 秒");
  });

  it("秒の端数は切り捨てる（分の桁へ繰り上げない）", () => {
    // 59_999ms を「60.00 秒」と出すと分に達したように見える
    expect(formatElapsedMs(59_999)).toBe("59.99 秒");
  });

  it("1 分以上は分と秒で表示する", () => {
    expect(formatElapsedMs(60_000)).toBe("1 分 0.0 秒");
    expect(formatElapsedMs(90_500)).toBe("1 分 30.5 秒");
    expect(formatElapsedMs(3_600_000)).toBe("60 分 0.0 秒");
  });

  it("未完了・不正値は空表示にする", () => {
    expect(formatElapsedMs(null)).toBe(EMPTY_VALUE);
    expect(formatElapsedMs(undefined)).toBe(EMPTY_VALUE);
    expect(formatElapsedMs(-1)).toBe(EMPTY_VALUE);
    expect(formatElapsedMs(Number.NaN)).toBe(EMPTY_VALUE);
    expect(formatElapsedMs(Number.POSITIVE_INFINITY)).toBe(EMPTY_VALUE);
  });
});

describe("formatTimestamp", () => {
  it("ブラウザのタイムゾーンに依存せず UTC で表示する", () => {
    expect(formatTimestamp("2025-01-02T03:04:05.678Z")).toBe("2025-01-02 03:04:05.678 UTC");
  });

  it("オフセット付きの時刻も UTC に正規化する", () => {
    expect(formatTimestamp("2025-01-02T12:00:00.000+09:00")).toBe("2025-01-02 03:00:00.000 UTC");
  });

  it("未完了・解釈できない値は空表示にする", () => {
    expect(formatTimestamp(null)).toBe(EMPTY_VALUE);
    expect(formatTimestamp(undefined)).toBe(EMPTY_VALUE);
    expect(formatTimestamp("")).toBe(EMPTY_VALUE);
    expect(formatTimestamp("not-a-date")).toBe(EMPTY_VALUE);
  });
});

describe("formatJpy", () => {
  it("3 桁区切りを入れる", () => {
    expect(formatJpy(0)).toBe("¥0");
    expect(formatJpy(999)).toBe("¥999");
    expect(formatJpy(1_000)).toBe("¥1,000");
    expect(formatJpy(1_234_567)).toBe("¥1,234,567");
  });

  it("不正値は空表示にする", () => {
    expect(formatJpy(null)).toBe(EMPTY_VALUE);
    expect(formatJpy(Number.NaN)).toBe(EMPTY_VALUE);
  });
});

describe("formatCount", () => {
  it("件数を 3 桁区切りで表示する", () => {
    expect(formatCount(10_000_000)).toBe("10,000,000");
    expect(formatCount(0)).toBe("0");
    expect(formatCount(null)).toBe(EMPTY_VALUE);
  });
});

describe("isTerminalOrderStatus", () => {
  it("COMPLETED と業務的な失敗は終端", () => {
    expect(isTerminalOrderStatus("COMPLETED")).toBe(true);
    expect(isTerminalOrderStatus("PAYMENT_FAILED")).toBe(true);
    expect(isTerminalOrderStatus("ALLOCATION_FAILED")).toBe(true);
  });

  it("進行中のステータスは終端でない", () => {
    expect(isTerminalOrderStatus("PENDING")).toBe(false);
    expect(isTerminalOrderStatus("PAID")).toBe(false);
    expect(isTerminalOrderStatus("ALLOCATED")).toBe(false);
    expect(isTerminalOrderStatus("NOTIFIED")).toBe(false);
  });
});

describe("orderStatusBadgeClass", () => {
  it("globals.css が持つ 3 種のバッジに割り当てる", () => {
    expect(orderStatusBadgeClass("COMPLETED")).toBe("badge badge-completed");
    expect(orderStatusBadgeClass("PAYMENT_FAILED")).toBe("badge badge-failed");
    expect(orderStatusBadgeClass("ALLOCATION_FAILED")).toBe("badge badge-failed");
    expect(orderStatusBadgeClass("PENDING")).toBe("badge badge-running");
    expect(orderStatusBadgeClass("NOTIFIED")).toBe("badge badge-running");
  });
});

describe("deriveStageProgress", () => {
  it("応答が空でも 4 段階を未完了として並べる", () => {
    const view = deriveStageProgress({ stages: [], stagesDone: 0, endToEndMs: null });

    expect(view.rows.map((row) => row.stage)).toEqual([
      "payment",
      "allocation",
      "notification",
      "point",
    ]);
    expect(view.rows.every((row) => row.status === "WAITING")).toBe(true);
    expect(view.rows.every((row) => row.elapsedMs === null)).toBe(true);
    expect(view.stagesDone).toBe(0);
    expect(view.progressPercent).toBe(0);
    expect(view.failedStage).toBeNull();
  });

  it("応答の順序に関係なく決済 → 引当 → 通知 → ポイントの順に並べる", () => {
    const view = deriveStageProgress({
      stages: [done("point", 4_000), done("payment", 1_000), done("notification", 3_000)],
      stagesDone: 3,
    });

    expect(view.rows.map((row) => row.stage)).toEqual([
      "payment",
      "allocation",
      "notification",
      "point",
    ]);
    expect(view.rows[0].elapsedMs).toBe(1_000);
    expect(view.rows[1].status).toBe("WAITING");
  });

  it("段階ごとの所要時間を直前の完了からの差で算出する", () => {
    const view = deriveStageProgress({
      stages: [
        done("payment", 1_500),
        done("allocation", 1_800),
        done("notification", 3_400),
        done("point", 3_500),
      ],
      stagesDone: 4,
      endToEndMs: 3_500,
    });

    // 1 段目は注文受付（経過 0）を起点にする
    expect(view.rows[0].stageDurationMs).toBe(1_500);
    expect(view.rows[1].stageDurationMs).toBe(300);
    expect(view.rows[2].stageDurationMs).toBe(1_600);
    expect(view.rows[3].stageDurationMs).toBe(100);
    expect(view.endToEndMs).toBe(3_500);
    expect(view.progressPercent).toBe(100);
  });

  it("未完了の段階の所要時間は算出しない", () => {
    const view = deriveStageProgress({
      stages: [done("payment", 1_000), waiting("allocation")],
      stagesDone: 1,
    });

    expect(view.rows[1].stageDurationMs).toBeNull();
    expect(view.rows[1].completedAt).toBeNull();
  });

  it("経過時間が逆行している段階の所要時間は算出しない", () => {
    // 時刻の取り違えを負の所要時間として表示しない
    const view = deriveStageProgress({
      stages: [done("payment", 2_000), done("allocation", 1_000)],
      stagesDone: 2,
    });

    expect(view.rows[1].elapsedMs).toBe(1_000);
    expect(view.rows[1].stageDurationMs).toBeNull();
  });

  it("失敗した段階を特定する", () => {
    const view = deriveStageProgress({
      stages: [
        done("payment", 1_000),
        { stage: "allocation", status: "FAILED", completedAt: null, elapsedMs: 1_200 },
      ],
      stagesDone: 1,
    });

    expect(view.failedStage).toBe("allocation");
    expect(view.progressPercent).toBe(25);
  });

  it("stagesDone が範囲外なら段階の状態から数え直す", () => {
    // 5 / 4 = 125% のような進捗率を出さない
    const view = deriveStageProgress({
      stages: [done("payment", 1_000), done("allocation", 1_200)],
      stagesDone: 9,
    });

    expect(view.stagesDone).toBe(2);
    expect(view.progressPercent).toBe(50);
  });

  it("stages が欠落している応答でも壊れない", () => {
    const view = deriveStageProgress({});

    expect(view.rows).toHaveLength(4);
    expect(view.stagesDone).toBe(0);
    expect(view.endToEndMs).toBeNull();
  });

  it("未知の段階は無視する", () => {
    const view = deriveStageProgress({
      // API が段階を追加しても既知の 4 行だけを表示する
      stages: [{ stage: "shipping", status: "DONE", completedAt: null, elapsedMs: 1 } as never],
      stagesDone: 0,
    });

    expect(view.rows).toHaveLength(4);
    expect(view.rows.every((row) => row.status === "WAITING")).toBe(true);
  });

  it("OrderStatusResponse をそのまま渡せる", () => {
    const response: OrderStatusResponse = {
      orderId: "ORD#01HZ",
      customerId: "CUST#test-0001",
      orderStatus: "COMPLETED",
      totalAmount: 3_600,
      pointEarned: 36,
      items: [{ sku: "ITEM#ETH-YIRG-G1-MEDIUM-200G", qty: 2, price: 1_800 }],
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:03.500Z",
      stagesDone: 4,
      stages: [
        done("payment", 1_500),
        done("allocation", 1_800),
        done("notification", 3_400),
        done("point", 3_500),
      ],
      failureReason: null,
      pipelineMode: "direct",
      endToEndMs: 3_500,
    };

    expect(deriveStageProgress(response).stagesDone).toBe(4);
  });
});
