/**
 * `api.ts` の単体テスト。
 *
 * `fetch` はスタブに差し替え、ネットワークには一切出ない（`.kiro/steering/testing.md`）。
 * 検証するのは design §5.8 の 9 ルートへの写像、パスセグメントの percent-encode、
 * ベース URL の解決（要件 14.10）、design §E-1 のエラー応答の変換である。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOrder,
  getCatalog,
  getExecution,
  getOrder,
  getVerificationConfig,
  INVALID_RESPONSE_CODE,
  listOrders,
  OrderApiConfigError,
  OrderApiError,
  OrderApiNetworkError,
  OrderApiRequestError,
  ORDER_API_BASE_URL_ENV,
  resetIdTokenProvider,
  resolveOrderApiBaseUrl,
  seedInventory,
  setIdTokenProvider,
  startLoadTest,
  startQueryImpact,
} from "./api";

const BASE_URL = "https://example.execute-api.us-west-2.amazonaws.com";

/** テスト用の固定 ID トークン。方式 A で全リクエストに付く */
const ID_TOKEN = "test-id-token";

/** 成功応答のスタブ */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** `fetch` をスタブに差し替え、呼び出しを記録する */
function stubFetch(response: Response | (() => Promise<Response>)) {
  const mock = vi.fn(
    typeof response === "function" ? response : () => Promise.resolve(response)
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** スタブに記録された 1 件目の呼び出し（URL と RequestInit） */
function firstCall(mock: ReturnType<typeof stubFetch>): [string, RequestInit] {
  expect(mock).toHaveBeenCalledTimes(1);
  const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
  return [url, init ?? {}];
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_ORDER_API_URL", BASE_URL);
  // 既定の取得方法は `aws-amplify/auth` の `fetchAuthSession()` を呼ぶため、
  // Amplify 未設定のテスト環境では例外になる。固定トークンを返す関数に差し替える
  setIdTokenProvider(() => Promise.resolve(ID_TOKEN));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetIdTokenProvider();
});

describe("resolveOrderApiBaseUrl", () => {
  it("環境変数の値をそのまま返す", () => {
    expect(resolveOrderApiBaseUrl()).toBe(BASE_URL);
  });

  it("末尾のスラッシュを落とす（パス結合で // にならないようにする）", () => {
    vi.stubEnv("NEXT_PUBLIC_ORDER_API_URL", `${BASE_URL}///`);
    expect(resolveOrderApiBaseUrl()).toBe(BASE_URL);
  });

  it("前後の空白を落とす", () => {
    vi.stubEnv("NEXT_PUBLIC_ORDER_API_URL", `  ${BASE_URL}  `);
    expect(resolveOrderApiBaseUrl()).toBe(BASE_URL);
  });

  it("未設定なら明示的なエラーを投げる（相対 URL に暗黙フォールバックしない）", () => {
    vi.stubEnv("NEXT_PUBLIC_ORDER_API_URL", undefined);

    expect(() => resolveOrderApiBaseUrl()).toThrow(OrderApiConfigError);
    // 案内メッセージに設定すべき環境変数名が含まれること（design §11.3）
    expect(() => resolveOrderApiBaseUrl()).toThrow(ORDER_API_BASE_URL_ENV);
  });

  it("空文字は未設定として扱う", () => {
    vi.stubEnv("NEXT_PUBLIC_ORDER_API_URL", "   ");
    expect(() => resolveOrderApiBaseUrl()).toThrow(OrderApiConfigError);
  });

  it("URL として解釈できない値はエラーにする", () => {
    vi.stubEnv("NEXT_PUBLIC_ORDER_API_URL", "example.execute-api.amazonaws.com");
    expect(() => resolveOrderApiBaseUrl()).toThrow(OrderApiConfigError);
  });

  it("http(s) 以外のスキームはエラーにする", () => {
    vi.stubEnv("NEXT_PUBLIC_ORDER_API_URL", "ftp://example.com");
    expect(() => resolveOrderApiBaseUrl()).toThrow(OrderApiConfigError);
  });

  it("ベース URL が未設定ならクライアント関数は fetch を呼ばない", async () => {
    vi.stubEnv("NEXT_PUBLIC_ORDER_API_URL", undefined);
    const mock = stubFetch(jsonResponse({}));

    await expect(getCatalog()).rejects.toBeInstanceOf(OrderApiConfigError);
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("エンドポイントの写像（design §5.8）", () => {
  const routes: {
    name: string;
    call: () => Promise<unknown>;
    method: string;
    url: string;
    status: number;
  }[] = [
    {
      name: "POST /orders",
      call: () => createOrder(),
      method: "POST",
      url: `${BASE_URL}/orders`,
      status: 201,
    },
    {
      name: "GET /orders/{orderId}",
      call: () => getOrder("ORD#01JABC"),
      method: "GET",
      url: `${BASE_URL}/orders/ORD%2301JABC`,
      status: 200,
    },
    {
      name: "GET /orders",
      call: () => listOrders({ customerId: "test-0001" }),
      method: "GET",
      url: `${BASE_URL}/orders?customerId=test-0001`,
      status: 200,
    },
    {
      name: "GET /config",
      call: () => getVerificationConfig(),
      method: "GET",
      url: `${BASE_URL}/config`,
      status: 200,
    },
    {
      name: "GET /catalog",
      call: () => getCatalog(),
      method: "GET",
      url: `${BASE_URL}/catalog`,
      status: 200,
    },
    {
      name: "POST /inventory/seed",
      call: () => seedInventory(),
      method: "POST",
      url: `${BASE_URL}/inventory/seed`,
      status: 200,
    },
    {
      name: "POST /load-test/start",
      call: () => startLoadTest(),
      method: "POST",
      url: `${BASE_URL}/load-test/start`,
      status: 202,
    },
    {
      name: "POST /measure/start",
      call: () => startQueryImpact(),
      method: "POST",
      url: `${BASE_URL}/measure/start`,
      status: 202,
    },
    {
      name: "GET /executions/{executionId}",
      call: () => getExecution("EXEC#01JXYZ"),
      method: "GET",
      url: `${BASE_URL}/executions/EXEC%2301JXYZ`,
      status: 200,
    },
  ];

  it.each(routes)("$name を正しいメソッドと URL で呼ぶ", async ({ call, method, url, status }) => {
    const mock = stubFetch(jsonResponse({ ok: true }, status));

    await expect(call()).resolves.toEqual({ ok: true });

    const [calledUrl, init] = firstCall(mock);
    expect(calledUrl).toBe(url);
    expect(init.method).toBe(method);
  });
});

describe("パスパラメータの encode", () => {
  it("注文 ID の # を percent-encode する（# 以降が落ちるのを防ぐ）", async () => {
    const mock = stubFetch(jsonResponse({}));

    await getOrder("ORD#01JABCDEF");

    const [url] = firstCall(mock);
    expect(url).toBe(`${BASE_URL}/orders/ORD%2301JABCDEF`);
    expect(url).not.toContain("#");
  });

  it("実行 ID の # を percent-encode する", async () => {
    const mock = stubFetch(jsonResponse({}));

    await getExecution("EXEC#LOAD#01JXYZ");

    const [url] = firstCall(mock);
    expect(url).toBe(`${BASE_URL}/executions/EXEC%23LOAD%2301JXYZ`);
  });

  it("空の注文 ID は送信前に弾く（別ルートに当たるのを防ぐ）", async () => {
    const mock = stubFetch(jsonResponse({}));

    await expect(getOrder("  ")).rejects.toBeInstanceOf(OrderApiRequestError);
    expect(mock).not.toHaveBeenCalled();
  });

  it("空の顧客 ID は送信前に弾く", async () => {
    const mock = stubFetch(jsonResponse({}));

    await expect(listOrders({ customerId: "" })).rejects.toBeInstanceOf(OrderApiRequestError);
    expect(mock).not.toHaveBeenCalled();
  });
});

describe("クエリパラメータ", () => {
  it("limit と nextToken を載せる", async () => {
    const mock = stubFetch(jsonResponse({ orders: [], nextToken: null }));

    await listOrders({ customerId: "test-0001", limit: 50, nextToken: "abc+/=" });

    const [url] = firstCall(mock);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/orders");
    expect(parsed.searchParams.get("customerId")).toBe("test-0001");
    expect(parsed.searchParams.get("limit")).toBe("50");
    expect(parsed.searchParams.get("nextToken")).toBe("abc+/=");
  });

  it("未指定のパラメータはクエリに含めない", async () => {
    const mock = stubFetch(jsonResponse({ orders: [], nextToken: null }));

    await listOrders({ customerId: "test-0001" });

    const [url] = firstCall(mock);
    expect(url).toBe(`${BASE_URL}/orders?customerId=test-0001`);
  });
});

describe("リクエスト本文", () => {
  it("POST は JSON 本文と Content-Type を送る", async () => {
    const mock = stubFetch(jsonResponse({}, 201));

    await createOrder({ customerId: "test-0001", items: [{ sku: "ITEM#A", qty: 2, price: 100 }] });

    const [, init] = firstCall(mock);
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      customerId: "test-0001",
      items: [{ sku: "ITEM#A", qty: 2, price: 100 }],
    });
  });

  it("引数を省略した POST は空オブジェクトを送る（サーバ側でランダム生成される）", async () => {
    const mock = stubFetch(jsonResponse({}, 201));

    await createOrder();

    const [, init] = firstCall(mock);
    expect(init.body).toBe("{}");
  });

  it("GET は本文を送らない", async () => {
    const mock = stubFetch(jsonResponse({}));

    await getCatalog();

    const [, init] = firstCall(mock);
    expect(init.body).toBeUndefined();
  });
});

describe("認証ヘッダー（方式 A: Cognito ID トークン）", () => {
  it("GET に Authorization: Bearer <idToken> を付ける", async () => {
    const mock = stubFetch(jsonResponse({}));

    await getCatalog();

    const [, init] = firstCall(mock);
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${ID_TOKEN}` });
  });

  it("POST は Content-Type と Authorization の両方を送る", async () => {
    const mock = stubFetch(jsonResponse({}, 201));

    await createOrder();

    const [, init] = firstCall(mock);
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: `Bearer ${ID_TOKEN}`,
    });
  });

  it("トークンが取得できない場合は Authorization を付けずに送る（API Gateway 側で 401）", async () => {
    setIdTokenProvider(() => Promise.resolve(null));
    const mock = stubFetch(jsonResponse({}));

    await getCatalog();

    const [, init] = firstCall(mock);
    // ヘッダーが無い、または Authorization を含まないこと
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("エラー応答の変換（design §E-1）", () => {
  it("{ error, message, details } を型付きエラーに写す", async () => {
    stubFetch(
      jsonResponse(
        {
          error: "UNKNOWN_SKU",
          message: "商品マスタに存在しない SKU が含まれています",
          details: { unknownSkus: ["ITEM#NOPE"] },
        },
        400
      )
    );

    const error = await createOrder().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OrderApiError);
    const apiError = error as OrderApiError;
    expect(apiError.kind).toBe("HTTP");
    expect(apiError.status).toBe(400);
    expect(apiError.code).toBe("UNKNOWN_SKU");
    expect(apiError.message).toBe("商品マスタに存在しない SKU が含まれています");
    expect(apiError.details).toEqual({ unknownSkus: ["ITEM#NOPE"] });
  });

  it("注文の 404 と実行の 404 を別のコードとして保つ", async () => {
    stubFetch(jsonResponse({ error: "ORDER_NOT_FOUND", message: "注文が見つかりません" }, 404));
    const orderError = (await getOrder("ORD#X").catch((e: unknown) => e)) as OrderApiError;
    expect(orderError.code).toBe("ORDER_NOT_FOUND");

    stubFetch(
      jsonResponse({ error: "EXECUTION_NOT_FOUND", message: "実行が見つかりません" }, 404)
    );
    const executionError = (await getExecution("EXEC#X").catch(
      (e: unknown) => e
    )) as OrderApiError;
    expect(executionError.code).toBe("EXECUTION_NOT_FOUND");
  });

  it("details が無い応答では details を undefined のままにする", async () => {
    stubFetch(jsonResponse({ error: "ORDER_NOT_FOUND", message: "注文が見つかりません" }, 404));

    const error = (await getOrder("ORD#X").catch((e: unknown) => e)) as OrderApiError;

    expect(error.details).toBeUndefined();
  });

  it("§E-1 の形でない応答（API Gateway 自身のエラー）は INVALID_RESPONSE にする", async () => {
    stubFetch(new Response("<html>429</html>", { status: 429 }));

    const error = (await getCatalog().catch((e: unknown) => e)) as OrderApiError;

    expect(error).toBeInstanceOf(OrderApiError);
    expect(error.status).toBe(429);
    expect(error.code).toBe(INVALID_RESPONSE_CODE);
    expect(error.details).toBe("<html>429</html>");
  });

  it("成功応答が JSON でない場合もエラーにする", async () => {
    stubFetch(new Response("not json", { status: 200 }));

    const error = (await getCatalog().catch((e: unknown) => e)) as OrderApiError;

    expect(error).toBeInstanceOf(OrderApiError);
    expect(error.code).toBe(INVALID_RESPONSE_CODE);
  });

  it("通信自体の失敗は NETWORK として区別する", async () => {
    const cause = new TypeError("Failed to fetch");
    stubFetch(() => Promise.reject(cause));

    const error = (await getCatalog().catch((e: unknown) => e)) as OrderApiNetworkError;

    expect(error).toBeInstanceOf(OrderApiNetworkError);
    expect(error.kind).toBe("NETWORK");
    expect(error.cause).toBe(cause);
  });
});

describe("オプション", () => {
  it("baseUrl の上書きは環境変数より優先される", async () => {
    const mock = stubFetch(jsonResponse({}));

    await getCatalog({ baseUrl: "https://override.example.com" });

    const [url] = firstCall(mock);
    expect(url).toBe("https://override.example.com/catalog");
  });

  it("環境変数が未設定でも baseUrl を渡せば呼べる", async () => {
    vi.stubEnv("NEXT_PUBLIC_ORDER_API_URL", undefined);
    const mock = stubFetch(jsonResponse({ products: [], count: 0, pointRate: 0.01 }));

    await expect(getCatalog({ baseUrl: BASE_URL })).resolves.toEqual({
      products: [],
      count: 0,
      pointRate: 0.01,
    });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("signal を fetch に渡す（ポーリングの中断用）", async () => {
    const mock = stubFetch(jsonResponse({}));
    const controller = new AbortController();

    await getExecution("EXEC#1", { signal: controller.signal });

    const [, init] = firstCall(mock);
    expect(init.signal).toBe(controller.signal);
  });
});
