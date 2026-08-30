"use client";

/**
 * 実行状態のポーリング（`GET /executions/{executionId}`。要件 11.6 / 12.5）。
 *
 * ## なぜポーリングが必要か
 *
 * 開始 API（`POST /load-test/start` / `POST /measure/start`）は 202 を返し、
 * 応答には実行 ID しか入っていない（要件 11.9 / 12.1）。API Gateway の
 * 29 秒制限を超える継続時間に対応するため投入・計測は非同期に続くので、
 * 画面は実行レコードを繰り返し取得するしか進捗を知る手段を持たない。
 *
 * ## 負荷生成と並行計測で 1 つのフックを共有する
 *
 * 実行管理テーブルは両者で共有されており（design §4.3）、照会 API も
 * `executionType` の異なる 2 種類を同じルートで返す。したがって
 * 「取得 → 種別の判別 → 終端で停止」という流れは共通で、違うのは
 * 判別する型だけである。型引数と型ガード（`isLoadTestStatus` /
 * `isQueryImpactStatus`）で切り替える。
 *
 * 種別が期待と違った場合は失敗として扱う（`describeExecutionTypeMismatch`）。
 * 負荷テストのパネルに `MEASURE#...` を貼られたときに、
 * 空欄の並んだ表を描いて済ませないためである。
 *
 * ## 停止条件
 *
 * - 実行が `COMPLETED` / `FAILED` になったら止める（`shouldContinuePolling`）
 * - 失敗（404、通信エラー、種別の不一致）でも止める。数秒間隔で
 *   叩き直しても結果は変わらない
 *
 * 止め忘れると、並行計測が測っている API Gateway に画面のポーリングが
 * 乗り続け、測定対象そのものを歪める（要件 12.1）。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { getExecution } from "@/src/lib/orders/api";
import type { ExecutionStatusResponse, ExecutionType } from "@/src/lib/orders/types";

import {
  describeExecutionTypeMismatch,
  shouldContinuePolling,
} from "./execution-run";
import { describeOrderApiFailure, type FailureNotice } from "./order-api-failure";

/**
 * ポーリング間隔。
 *
 * 負荷生成ワーカーは実行レコードを 1 秒周期のループで更新する
 * （`load-plan.ts`）が、画面側を同じ周期にする必要はない。
 * 3 秒は「投入件数の伸びが目で追える」と「照会 API を無駄に叩かない」の
 * 折り合いで、注文照会（2 秒。`OrderStatusPanel`）より緩めてある。
 */
export const EXECUTION_POLL_INTERVAL_MS = 3_000;

export interface ExecutionPolling<T extends ExecutionStatusResponse> {
  /** 追跡中の実行 ID。未追跡なら null */
  executionId: string | null;
  execution: T | null;
  failure: FailureNotice | null;
  /** 初回取得中（表示を差し替える） */
  loading: boolean;
  /** ポーリングによる再取得中（表示は保つ） */
  refreshing: boolean;
  /** ポーリングが動いているか */
  polling: boolean;
  /** 最終取得時刻（ISO 8601） */
  fetchedAt: string | null;
  /** 実行 ID の追跡を始める（初回取得を含む） */
  track: (executionId: string) => void;
  /** 今すぐ再取得する */
  refresh: () => void;
}

/**
 * 実行状態を追跡する。
 *
 * @param expectedType このフックの利用側が扱う実行種別
 * @param narrow 応答を `T` に絞る型ガード（`isLoadTestStatus` など）
 */
export function useExecutionPolling<T extends ExecutionStatusResponse>(
  expectedType: ExecutionType,
  narrow: (execution: ExecutionStatusResponse) => execution is T
): ExecutionPolling<T> {
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [execution, setExecution] = useState<T | null>(null);
  const [failure, setFailure] = useState<FailureNotice | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  /**
   * 実行レコードを取得する。
   *
   * @param silent ポーリングによる取得。表示中のデータを消さずに差し替える
   */
  const fetchExecution = useCallback(
    async (id: string, silent: boolean) => {
      // 直前の取得を打ち切る。古い応答が新しい応答を上書きしないようにする
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
        setExecution(null);
        setFailure(null);
      }

      try {
        const response = await getExecution(id, { signal: controller.signal });
        if (controller.signal.aborted) {
          return;
        }
        if (!narrow(response)) {
          // 別種別の実行 ID。空欄の表を描くのではなく失敗として案内する
          setExecution(null);
          setFailure(describeExecutionTypeMismatch(expectedType, response.executionType));
          return;
        }
        setExecution(response);
        setFailure(null);
        setFetchedAt(new Date().toISOString());
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setFailure(describeOrderApiFailure(error, "getExecution"));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [expectedType, narrow]
  );

  // 終端と失敗で止める（このファイルの冒頭の理由）
  const polling = executionId !== null && failure === null && shouldContinuePolling(execution);

  useEffect(() => {
    if (!polling || executionId === null) {
      return;
    }
    const timer = setInterval(() => {
      void fetchExecution(executionId, true);
    }, EXECUTION_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [polling, executionId, fetchExecution]);

  // 画面を離れるときに進行中の取得を止める
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const track = useCallback(
    (id: string) => {
      setExecutionId(id);
      void fetchExecution(id, false);
    },
    [fetchExecution]
  );

  const refresh = useCallback(() => {
    if (executionId !== null) {
      void fetchExecution(executionId, true);
    }
  }, [executionId, fetchExecution]);

  return {
    executionId,
    execution,
    failure,
    loading,
    refreshing,
    polling,
    fetchedAt,
    track,
    refresh,
  };
}
