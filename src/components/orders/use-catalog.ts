"use client";

/**
 * 商品マスタを取得する（`GET /catalog`。要件 2.1 / 2.6 / 2.7）。
 *
 * ## 取得を 1 箇所に集約する
 *
 * 商品グリッド（`ProductGrid`）とカート（`CartPanel`）は同じ商品マスタを見る。
 * グリッドは表示用属性、カートは単価とポイント付与率を引く。取得を両方に
 * 持たせると同じ `GET /catalog` を 2 回呼び、「グリッドとカートで単価が違う」
 * 状態が起こりうる（`ProductGrid` の注記）。取得は注文タブに 1 つだけ置き、
 * その手順をこのフックに閉じる。
 *
 * ## `OrderSubmitPanel` から引き継ぐもの・落とすもの
 *
 * 引き継ぐ: `getCatalog` の呼び出し、`AbortController` による打ち切り、
 * 失敗時の `describeOrderApiFailure` による言い換え、再取得（要件 2.6）。
 * 旧実装と同じ作法なので、注文タブの見た目が変わっても取得の挙動は変わらない
 * （非機能 3。取得の実装をここに移すだけで、新しく書き起こしていない）。
 *
 * 落とす: 取得直後に明細を 1 行用意する処理。カートは空から始まり、
 * 商品カードの「カートに追加」で初めて明細ができる（要件 3.1）。
 *
 * ## `useVerificationConfig` と同じ形にしている
 *
 * 状態（`loading` / `ready` / `error`）と `reload` を返すだけの読み取り専用の
 * フックである。`GET /config` と `GET /catalog` はどちらも Lambda がメモリ上の
 * 値を返す軽い読み取りで、失敗時にタブ内で再試行できることが要る。
 * 2 つのフックで作法を揃えておくと、片方だけが古い扱いをすることがない。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { getCatalog } from "@/src/lib/orders/api";
import type { CatalogProductView } from "@/src/lib/orders/types";

import { describeOrderApiFailure, type FailureNotice } from "./order-api-failure";

/** 商品マスタの読み込み状態 */
export type CatalogState = "loading" | "ready" | "error";

export interface CatalogResult {
  state: CatalogState;
  /** 取得できた商品。未取得・失敗時は空配列 */
  products: CatalogProductView[];
  /** ポイント付与率。未取得なら null（獲得予定ポイントを出さない） */
  pointRate: number | null;
  /** 取得に失敗したときの案内。無ければ null（要件 2.6） */
  failure: FailureNotice | null;
  /** 再取得する（失敗時の再試行に使う。要件 2.6） */
  reload: () => void;
}

export function useCatalog(): CatalogResult {
  const [state, setState] = useState<CatalogState>("loading");
  const [products, setProducts] = useState<CatalogProductView[]>([]);
  const [pointRate, setPointRate] = useState<number | null>(null);
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
      const response = await getCatalog({ signal: controller.signal });
      if (controller.signal.aborted) {
        return;
      }
      setProducts(response.products);
      setPointRate(response.pointRate);
      setState("ready");
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      /*
       * 失敗時は商品マスタを空に戻す。古い商品を残したまま「取得に失敗した」と
       * 出すと、表示中の単価がいつのものか読めなくなる。カートの明細は残るが、
       * 単価を引けない明細として `summarizeCart` が知らせる（`hasUnknownSku`）。
       */
      setProducts([]);
      setPointRate(null);
      setState("error");
      setFailure(describeOrderApiFailure(error, "loadCatalog"));
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

  return { state, products, pointRate, failure, reload };
}
