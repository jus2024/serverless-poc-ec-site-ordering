/**
 * 注文 API の fetch クライアント（design §5.8 の 9 ルート / §11.3）。
 *
 * ## 何をこの層に閉じ込めているか
 *
 * - ベース URL の解決（要件 14.10。ハードコードしない）
 * - パスセグメントの percent-encode（注文 ID / 実行 ID は `#` を含む）
 * - エラー応答 `{ error, message, details? }`（design §E-1）から型付き例外への変換
 *
 * コンポーネント（タスク 22）は `OrderApiFailure` を捕まえて `kind` で分岐し、
 * HTTP エラーならさらに `code` で分岐する。素の `Error` や `Response` を
 * 画面側に漏らさないことで、「404 が注文の 404 か実行の 404 か」を
 * 各パネルが取り違えないようにする（design §E-1 の `EXECUTION_NOT_FOUND` の注記）。
 *
 * ## Lambda 側のモジュールを参照しない
 *
 * 型は `./types` にあり、`amplify/functions/shared/` からは import しない（要件 18.6）。
 */

import {
  type CatalogResponse,
  type CreateOrderRequest,
  type CreateOrderResponse,
  type ErrorResponse,
  type ExecutionStatusResponse,
  type OrderListResponse,
  type OrderStatusResponse,
  type SeedInventoryRequest,
  type SeedInventoryResponse,
  type StartLoadTestRequest,
  type StartLoadTestResponse,
  type StartQueryImpactRequest,
  type StartQueryImpactResponse,
  type VerificationConfigResponse,
} from "./types";

// ─── 失敗の分類 ───────────────────────────────────────────────────

/**
 * 失敗の種別。画面はまずこれで分岐する。
 *
 * | 種別 | 意味 | 画面の対応 |
 * |------|------|-----------|
 * | `CONFIG` | ベース URL が未設定/不正 | セットアップ手順を案内する（design §11.3） |
 * | `REQUEST` | 呼び出し側の引数不備。送信前に弾いたもの | 入力欄のバリデーションとして扱う |
 * | `NETWORK` | fetch 自体が失敗（オフライン、CORS、中断） | 再試行を促す |
 * | `HTTP` | API がエラー応答を返した | `code` で分岐する（design §E-1） |
 */
export type OrderApiFailureKind = "CONFIG" | "REQUEST" | "NETWORK" | "HTTP";

/**
 * 注文 API 呼び出しの失敗。
 *
 * `Object.setPrototypeOf` を各サブクラスで呼んでいるのは、
 * `Error` を継承したクラスが ES5 へダウンレベルされた場合に
 * `instanceof` が壊れるのを防ぐためである（画面側が `instanceof` で分岐する）。
 */
export abstract class OrderApiFailure extends Error {
  abstract readonly kind: OrderApiFailureKind;
}

/** ベース URL が解決できない（要件 14.10 / design §11.3） */
export class OrderApiConfigError extends OrderApiFailure {
  readonly kind = "CONFIG";

  constructor(message: string) {
    super(message);
    this.name = "OrderApiConfigError";
    Object.setPrototypeOf(this, OrderApiConfigError.prototype);
  }
}

/** 呼び出し側の引数不備。リクエストを送る前に弾いたもの */
export class OrderApiRequestError extends OrderApiFailure {
  readonly kind = "REQUEST";

  constructor(message: string) {
    super(message);
    this.name = "OrderApiRequestError";
    Object.setPrototypeOf(this, OrderApiRequestError.prototype);
  }
}

/** 通信自体の失敗（オフライン、CORS、`AbortSignal` による中断） */
export class OrderApiNetworkError extends OrderApiFailure {
  readonly kind = "NETWORK";
  /** 元の例外。ログ出力用。画面には出さない */
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "OrderApiNetworkError";
    this.cause = cause;
    Object.setPrototypeOf(this, OrderApiNetworkError.prototype);
  }
}

/**
 * API がエラー応答を返した（design §E-1）。
 *
 * `code` を `ApiErrorCode` に狭めていないのは、応答が想定外のコードを
 * 返しても分類ごと失うことがないようにするためである。既知のコードかどうかは
 * `isApiErrorCode`（`./types`）で判定する。
 */
export class OrderApiError extends OrderApiFailure {
  readonly kind = "HTTP";
  readonly status: number;
  /** `{ error }` の値（例: `ORDER_NOT_FOUND`） */
  readonly code: string;
  /** `{ details }` の値。無ければ `undefined` */
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "OrderApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, OrderApiError.prototype);
  }
}

/**
 * エラー応答の本文が JSON として読めなかったときに使うコード。
 *
 * design §E-1 の表には無い値をあえて使う。`isApiErrorCode` が false を返すため、
 * 画面は「既知のコードごとの案内」ではなく汎用の失敗表示に落ちる。
 * サーバ側のコードを騙って `INTERNAL_ERROR` などに丸めると、
 * 「API がそう答えた」のか「応答が読めなかった」のかが区別できなくなる。
 */
export const INVALID_RESPONSE_CODE = "INVALID_RESPONSE";

// ─── ベース URL の解決 ─────────────────────────────────────────────

/** ベース URL を与える環境変数の名前（案内メッセージに使う） */
export const ORDER_API_BASE_URL_ENV = "NEXT_PUBLIC_ORDER_API_URL";

const MISSING_BASE_URL_MESSAGE =
  `注文 API のベース URL が設定されていません。` +
  `\`npx ampx sandbox\` の出力（または amplify_outputs.json の custom.orderApiUrl）に表示された` +
  ` API エンドポイントを \`.env.local\` の ${ORDER_API_BASE_URL_ENV} に設定して、開発サーバを再起動してください。`;

/**
 * 注文 API のベース URL を解決する（要件 14.10）。
 *
 * 出典は `NEXT_PUBLIC_ORDER_API_URL` のみ。相対 URL や `localhost` へ
 * 暗黙にフォールバックしない。フォールバックすると「デプロイ済み API を
 * 叩いているつもりで別の宛先を叩いていた」という取り違えが起き、
 * 計測結果の出典が分からなくなる（design §5.8 と同じ理由）。
 *
 * ベース URL は `amplify_outputs.json` の `custom.orderApiUrl` にも出力される
 * （design §11.3 / タスク 10）。フロントエンドは環境変数を出典にしているため、
 * `ampx sandbox` 実行後に URL を `.env.local` へ写す手順が必要になる。
 *
 * @throws {OrderApiConfigError} 未設定、または URL として解釈できない場合
 */
export function resolveOrderApiBaseUrl(): string {
  // Next.js は `process.env.NEXT_PUBLIC_*` へのリテラルなアクセスのみを
  // ビルド時に埋め込む。変数経由で読むとクライアント側で undefined になる。
  const raw = process.env.NEXT_PUBLIC_ORDER_API_URL;

  if (raw === undefined || raw.trim() === "") {
    throw new OrderApiConfigError(MISSING_BASE_URL_MESSAGE);
  }

  // 末尾のスラッシュを落とす。`https://host/` + `/orders` が `//orders` になるのを防ぐ
  const trimmed = raw.trim().replace(/\/+$/, "");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new OrderApiConfigError(
      `${ORDER_API_BASE_URL_ENV} が URL として解釈できません: ${raw}`
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new OrderApiConfigError(
      `${ORDER_API_BASE_URL_ENV} は http(s) の URL を指定してください: ${raw}`
    );
  }

  return trimmed;
}

// ─── リクエストの組み立て ──────────────────────────────────────────

/** 各クライアント関数に渡せる共通オプション */
export interface OrderApiOptions {
  /**
   * ベース URL の上書き。省略時は `resolveOrderApiBaseUrl()`。
   * 環境変数を触らずに宛先を差し替えたい場合（テスト、複数環境の比較）に使う。
   */
  baseUrl?: string;
  /** 中断シグナル。ポーリング中の画面遷移で使う */
  signal?: AbortSignal;
}

/** クエリパラメータ。`undefined` の項目は付けない */
type QueryParams = Record<string, string | number | boolean | undefined>;

/**
 * パスセグメントを percent-encode する。
 *
 * 注文 ID は `ORD#{ULID}`（要件 1.4）、実行 ID も `#` を含む形式のため、
 * そのまま URL に置くと `#` 以降がフラグメントとして落ちて
 * `GET /orders/ORD` を叩くことになる。
 */
function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

/** クエリ文字列を組み立てる（空なら空文字） */
function buildQueryString(params: QueryParams | undefined): string {
  if (params === undefined) {
    return "";
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query === "" ? "" : `?${query}`;
}

interface RequestSpec {
  method: "GET" | "POST";
  /** 先頭がスラッシュのパス。可変部分は呼び出し側で encode 済みにする */
  path: string;
  query?: QueryParams;
  /** JSON 本文。`undefined` なら本文を送らない */
  body?: unknown;
}

/**
 * リクエストを送り JSON を返す。全クライアント関数の唯一の入口。
 *
 * 成功と判定するのは `response.ok`（2xx）である。ステータスコードは
 * ルートごとに 200 / 201 / 202 と異なる（design §E-1 / 要件 11.9）ため、
 * 特定の値と一致するかは見ない。
 */
async function requestJson<T>(spec: RequestSpec, options: OrderApiOptions = {}): Promise<T> {
  const baseUrl = options.baseUrl ?? resolveOrderApiBaseUrl();
  const url = `${baseUrl}${spec.path}${buildQueryString(spec.query)}`;

  const init: RequestInit = { method: spec.method };
  if (options.signal !== undefined) {
    init.signal = options.signal;
  }
  if (spec.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(spec.body);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    // fetch が reject するのは通信レベルの失敗（オフライン、CORS、中断）に限る。
    // HTTP のエラーステータスはここに来ない
    throw new OrderApiNetworkError(
      `注文 API への通信に失敗しました: ${spec.method} ${spec.path}`,
      error
    );
  }

  const text = await response.text();

  if (!response.ok) {
    throw toOrderApiError(response, text);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new OrderApiError(
      response.status,
      INVALID_RESPONSE_CODE,
      `注文 API の応答が JSON として解釈できません: ${spec.method} ${spec.path}`
    );
  }
}

/**
 * エラー応答を `OrderApiError` に変換する。
 *
 * 本文が design §E-1 の形（`{ error, message, details? }`）なら
 * そのコードとメッセージを引き継ぐ。API Gateway 自身が返す応答
 * （認証・スロットル・ルート不一致）はこの形ではないため、
 * ステータスから読めるだけの情報で組み立てる。
 */
function toOrderApiError(response: Response, text: string): OrderApiError {
  const body = parseErrorBody(text);

  if (body !== null) {
    return new OrderApiError(response.status, body.error, body.message, body.details);
  }

  return new OrderApiError(
    response.status,
    INVALID_RESPONSE_CODE,
    `注文 API がエラーを返しました（HTTP ${response.status}${
      response.statusText === "" ? "" : ` ${response.statusText}`
    }）`,
    text === "" ? undefined : text
  );
}

/** 本文が `{ error, message }` を持つオブジェクトなら返す。そうでなければ null */
function parseErrorBody(text: string): ErrorResponse | null {
  if (text.trim() === "") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.error !== "string" || typeof candidate.message !== "string") {
    return null;
  }

  const body: ErrorResponse = { error: candidate.error, message: candidate.message };
  if (candidate.details !== undefined) {
    body.details = candidate.details;
  }
  return body;
}

/**
 * 必須の ID を検証する。空文字でリクエストを送ると別のルートに当たってしまう
 * （`GET /orders/` は `GET /orders` の一覧ルートに落ち、意味の違う 400 が返る）。
 *
 * 呼び出し側は `async` 関数であること。同期の `throw` と非同期の reject が
 * 混在すると、画面側が `try` と `.catch` の両方を書かないと拾えなくなる。
 */
function requireId(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    throw new OrderApiRequestError(`${label} を指定してください`);
  }
  return trimmed;
}

// ─── クライアント関数（design §5.8 の 9 ルート）──────────────────────

/**
 * 注文を投入する（`POST /orders`。要件 1）。
 *
 * `items` を省略すると商品マスタからランダム生成され、
 * `customerId` を省略するとテスト顧客が割り当てられる（要件 1.2 / 1.3）。
 */
export function createOrder(
  request: CreateOrderRequest = {},
  options?: OrderApiOptions
): Promise<CreateOrderResponse> {
  return requestJson<CreateOrderResponse>(
    { method: "POST", path: "/orders", body: request },
    options
  );
}

/** 注文のステータスと段階進捗を照会する（`GET /orders/{orderId}`。要件 2.1） */
export async function getOrder(
  orderId: string,
  options?: OrderApiOptions
): Promise<OrderStatusResponse> {
  const id = requireId(orderId, "注文 ID");
  return requestJson<OrderStatusResponse>(
    { method: "GET", path: `/orders/${encodePathSegment(id)}` },
    options
  );
}

/** 顧客別注文一覧のパラメータ（要件 2.3） */
export interface ListOrdersParams {
  customerId: string;
  /** 取得件数。省略時はサーバ側の既定値（20）。上限 100 */
  limit?: number;
  /** 継続トークン。前回応答の `nextToken` を渡す */
  nextToken?: string;
}

/** 顧客別の注文一覧を新しい順に取得する（`GET /orders?customerId=`。要件 2.3） */
export async function listOrders(
  params: ListOrdersParams,
  options?: OrderApiOptions
): Promise<OrderListResponse> {
  const customerId = requireId(params.customerId, "顧客 ID");
  return requestJson<OrderListResponse>(
    {
      method: "GET",
      path: "/orders",
      query: { customerId, limit: params.limit, nextToken: params.nextToken },
    },
    options
  );
}

/**
 * デプロイ済みの検証パラメータと消費能力の見積もりを取得する
 * （`GET /config`。要件 10.6 / 14.7）。
 */
export function getVerificationConfig(
  options?: OrderApiOptions
): Promise<VerificationConfigResponse> {
  return requestJson<VerificationConfigResponse>({ method: "GET", path: "/config" }, options);
}

/**
 * 商品マスタを取得する（`GET /catalog`。要件 3.5）。
 *
 * 手動投入の SKU 選択肢はこの応答から作る。フロントエンド側に
 * 商品マスタを複製しない（design §5.8）。
 */
export function getCatalog(options?: OrderApiOptions): Promise<CatalogResponse> {
  return requestJson<CatalogResponse>({ method: "GET", path: "/catalog" }, options);
}

/** 初期在庫を投入する（`POST /inventory/seed`。要件 5.7） */
export function seedInventory(
  request: SeedInventoryRequest = {},
  options?: OrderApiOptions
): Promise<SeedInventoryResponse> {
  return requestJson<SeedInventoryResponse>(
    { method: "POST", path: "/inventory/seed", body: request },
    options
  );
}

/**
 * 負荷生成を開始する（`POST /load-test/start`。要件 11.1）。
 *
 * 202 で実行 ID だけが返り、投入は非同期に続く。進捗は
 * `getExecution` で照会する（要件 11.6）。
 */
export function startLoadTest(
  request: StartLoadTestRequest = {},
  options?: OrderApiOptions
): Promise<StartLoadTestResponse> {
  return requestJson<StartLoadTestResponse>(
    { method: "POST", path: "/load-test/start", body: request },
    options
  );
}

/**
 * 並行計測を開始する（`POST /measure/start`。要件 12.1）。
 *
 * 202 で実行 ID だけが返り、計測は非同期に続く。結果は
 * `getExecution` で照会する（要件 12.5）。
 */
export function startQueryImpact(
  request: StartQueryImpactRequest = {},
  options?: OrderApiOptions
): Promise<StartQueryImpactResponse> {
  return requestJson<StartQueryImpactResponse>(
    { method: "POST", path: "/measure/start", body: request },
    options
  );
}

/**
 * 実行状態・計測結果を照会する（`GET /executions/{executionId}`。要件 11.6 / 12.5）。
 *
 * 負荷生成と並行計測の双方が返る。`executionType` で判別する
 * （`isLoadTestStatus` / `isQueryImpactStatus`）。
 */
export async function getExecution(
  executionId: string,
  options?: OrderApiOptions
): Promise<ExecutionStatusResponse> {
  const id = requireId(executionId, "実行 ID");
  return requestJson<ExecutionStatusResponse>(
    { method: "GET", path: `/executions/${encodePathSegment(id)}` },
    options
  );
}
