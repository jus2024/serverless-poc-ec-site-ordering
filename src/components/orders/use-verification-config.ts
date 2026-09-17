"use client";

/**
 * デプロイ済みの検証パラメータを取得する（`GET /config`。要件 10.6）。
 *
 * ## なぜフックにしているか
 *
 * 負荷生成（`LoadTestPanel`）と並行計測（`QueryImpactPanel`）は、
 * どちらもパラメータの上限を `limits` から取る。上限を画面の定数として
 * 持たないことが要件 10.6 の要点であり（`execution-run.ts` の注記）、
 * その取得と失敗時の案内を 2 つのパネルで別々に書くと、
 * 片方だけが古い扱いをする余地が残る。
 *
 * タスク 22.4 の `ConfigPanel` も同じ応答を表示するため、
 * 取得の作法をここに 1 つ持つ。
 *
 * ## パネルごとに取得する（親で 1 回にしない）
 *
 * `OrderDashboard` は 4 つのパネルを常にマウントしたままにしている。
 * 取得を親に上げると外枠がデータ取得の責務を持つことになり、
 * タブごとの再試行もできなくなる。`GET /config` は環境変数を読んで返すだけの
 * 軽い読み取りなので、パネルごとに 1 回取得する側を選んでいる。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { getVerificationConfig } from "@/src/lib/orders/api";
import type { VerificationConfigResponse } from "@/src/lib/orders/types";

import { describeOrderApiFailure, type FailureNotice } from "./order-api-failure";

/** 取得の状態 */
export type VerificationConfigState = "loading" | "ready" | "error";

export interface VerificationConfigResult {
  state: VerificationConfigState;
  /** 取得できた検証パラメータ。未取得なら null */
  config: VerificationConfigResponse | null;
  failure: FailureNotice | null;
  /** 再取得する（失敗時の再試行に使う） */
  reload: () => void;
}

export function useVerificationConfig(): VerificationConfigResult {
  const [state, setState] = useState<VerificationConfigState>("loading");
  const [config, setConfig] = useState<VerificationConfigResponse | null>(null);
  const [failure, setFailure] = useState<FailureNotice | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    // 直前の取得を打ち切る。古い応答が新しい応答を上書きしないようにする
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState("loading");
    setFailure(null);
    try {
      const response = await getVerificationConfig({ signal: controller.signal });
      if (controller.signal.aborted) {
        return;
      }
      setConfig(response);
      setState("ready");
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      setConfig(null);
      setState("error");
      setFailure(describeOrderApiFailure(error, "loadConfig"));
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      abortRef.current?.abort();
    };
  }, [load]);

  const reload = useCallback(() => {
    void load();
  }, [load]);

  return { state, config, failure, reload };
}
