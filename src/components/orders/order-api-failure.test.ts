import { describe, expect, it } from "vitest";

import {
  INVALID_RESPONSE_CODE,
  OrderApiConfigError,
  OrderApiError,
  OrderApiNetworkError,
  OrderApiRequestError,
} from "../../lib/orders/api";
import { describeOrderApiFailure } from "./order-api-failure";

describe("describeOrderApiFailure", () => {
  it("ベース URL 未設定はセットアップ案内として区別する（要件 14.10）", () => {
    const notice = describeOrderApiFailure(
      new OrderApiConfigError("NEXT_PUBLIC_ORDER_API_URL を .env.local に設定してください"),
      "createOrder"
    );

    expect(notice.isConfigError).toBe(true);
    // 再試行しても直らない
    expect(notice.retryable).toBe(false);
    // api.ts が組み立てた手順をそのまま見せる
    expect(notice.message).toContain("NEXT_PUBLIC_ORDER_API_URL");
  });

  it("送信前に弾いた引数不備は入力の誤りとして扱う", () => {
    const notice = describeOrderApiFailure(new OrderApiRequestError("注文 ID を指定してください"), "getOrder");

    expect(notice.isConfigError).toBe(false);
    expect(notice.retryable).toBe(false);
    expect(notice.title).toContain("入力");
    expect(notice.message).toBe("注文 ID を指定してください");
  });

  it("通信エラーは再試行を促し、操作名を見出しに入れる", () => {
    const notice = describeOrderApiFailure(
      new OrderApiNetworkError("通信に失敗しました", new Error("fetch failed")),
      "seedInventory"
    );

    expect(notice.retryable).toBe(true);
    expect(notice.isConfigError).toBe(false);
    expect(notice.title).toContain("初期在庫の投入");
    expect(notice.hint).not.toBeNull();
  });

  it("ORDER_NOT_FOUND は注文 ID の確認を促す", () => {
    const notice = describeOrderApiFailure(
      new OrderApiError(404, "ORDER_NOT_FOUND", "注文が見つかりません"),
      "getOrder"
    );

    expect(notice.title).toBe("注文が見つかりません");
    expect(notice.retryable).toBe(false);
    expect(notice.reference).toBe("HTTP 404 / ORDER_NOT_FOUND");
    expect(notice.hint).not.toBeNull();
  });

  it("UNKNOWN_SKU は商品マスタの再読み込みを促す（要件 3.5）", () => {
    const notice = describeOrderApiFailure(
      new OrderApiError(400, "UNKNOWN_SKU", "商品マスタに存在しない SKU です", {
        unknownSkus: ["ITEM#UNKNOWN"],
      }),
      "createOrder"
    );

    expect(notice.retryable).toBe(false);
    expect(notice.hint).toContain("商品マスタ");
  });

  it("INTERNAL_ERROR は再試行の対象にする", () => {
    const notice = describeOrderApiFailure(
      new OrderApiError(500, "INTERNAL_ERROR", "内部エラー"),
      "createOrder"
    );

    expect(notice.retryable).toBe(true);
    expect(notice.reference).toBe("HTTP 500 / INTERNAL_ERROR");
  });

  it("PARAMETER_OUT_OF_RANGE は上限の参照先を案内する", () => {
    const notice = describeOrderApiFailure(
      new OrderApiError(400, "PARAMETER_OUT_OF_RANGE", "initialQuantity が範囲外です"),
      "seedInventory"
    );

    expect(notice.retryable).toBe(false);
    expect(notice.hint).not.toBeNull();
  });

  it("エラー応答の形でない 404 はルート設定の確認を促す", () => {
    // API Gateway 自身の応答（design §E-1 の形ではない）
    const notice = describeOrderApiFailure(
      new OrderApiError(404, INVALID_RESPONSE_CODE, "注文 API がエラーを返しました（HTTP 404）"),
      "loadCatalog"
    );

    expect(notice.retryable).toBe(false);
    expect(notice.hint).toContain("NEXT_PUBLIC_ORDER_API_URL");
  });

  it("スロットル（429）は再試行の対象にする", () => {
    const notice = describeOrderApiFailure(
      new OrderApiError(429, INVALID_RESPONSE_CODE, "Too Many Requests"),
      "getOrder"
    );

    expect(notice.retryable).toBe(true);
    expect(notice.hint).toContain("スロットル");
  });

  it("未知のエラーコードでも分類を失わない", () => {
    const notice = describeOrderApiFailure(
      new OrderApiError(503, "SOMETHING_NEW", "Service Unavailable"),
      "getOrder"
    );

    expect(notice.reference).toBe("HTTP 503 / SOMETHING_NEW");
    expect(notice.retryable).toBe(true);
    expect(notice.message).toBe("Service Unavailable");
  });

  it("API クライアント以外の例外もそのまま案内する", () => {
    expect(describeOrderApiFailure(new Error("想定外"), "createOrder")).toMatchObject({
      message: "想定外",
      isConfigError: false,
      retryable: false,
    });
    expect(describeOrderApiFailure("文字列で投げられた", "createOrder").message).toBe(
      "文字列で投げられた"
    );
  });
});
