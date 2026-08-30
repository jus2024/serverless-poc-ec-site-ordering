/**
 * 注文 API のリクエスト/レスポンス型（フロントエンド側。design §11.1）。
 *
 * ## Lambda 側の型と意図的に重複させている
 *
 * `amplify/functions/shared/types.ts` に同じ形の型があるが、**そこから import しない**
 * （要件 18.6 / design §5.3）。Lambda のバンドル（esbuild / Node.js 22）と
 * フロントエンドのビルド（Next.js / ブラウザ）を独立させるための意図的な重複である。
 * `amplify/` は `tsconfig.json` の `exclude` に入っており、
 * フロントエンドの型検査の対象外でもある。
 *
 * したがってこのファイルは **API の応答 JSON の形** を写したものであり、
 * DynamoDB のアイテム属性（snake_case）は含まない。API 境界を越えて
 * フロントエンドに届くものだけを camelCase で定義する。
 *
 * **API のレスポンス形状を変えるときは両方を更新すること。**
 * 出典は `amplify/functions/shared/types.ts` である。
 */

// ─── 注文 ────────────────────────────────────────────────────────

/** 後続処理の段階（design §5.5。`direct` 構成では 1 つの Lambda が直列実行する） */
export const ORDER_STAGES = ["payment", "allocation", "notification", "point"] as const;
export type OrderStage = (typeof ORDER_STAGES)[number];

/** 段階ごとの処理結果 */
export type StageResult = "DONE" | "FAILED";

/**
 * 注文ステータス。
 *
 * 正常系は PENDING → PAID → ALLOCATED → NOTIFIED → COMPLETED の順に進む。
 * 終端の失敗は `PAYMENT_FAILED` / `ALLOCATION_FAILED`（design §E-2）。
 */
export type OrderStatus =
  | "PENDING"
  | "PAID"
  | "ALLOCATED"
  | "NOTIFIED"
  | "COMPLETED"
  | "PAYMENT_FAILED"
  | "ALLOCATION_FAILED";

/** パイプライン構成。本 Spec では常に `direct`（design §9 で `fanout` に拡張しうる） */
export type PipelineMode = "direct" | "fanout";

/** 注文明細 */
export interface OrderItem {
  /** 商品 SKU（例: ITEM#ETH-YIRG-G1-MEDIUM-200G） */
  sku: string;
  qty: number;
  /** 税込単価 */
  price: number;
}

/** 注文受付リクエスト（POST /orders） */
export interface CreateOrderRequest {
  /** 未指定ならランダムなテスト顧客が割り当てられる */
  customerId?: string;
  /** 未指定なら商品マスタからランダム生成される（要件 1.2） */
  items?: OrderItem[];
  /** 負荷テスト実行 ID（手動投入では使わない） */
  loadTestId?: string;
}

/** 注文受付レスポンス（201 Created） */
export interface CreateOrderResponse {
  orderId: string;
  customerId: string;
  orderStatus: OrderStatus;
  totalAmount: number;
  items: OrderItem[];
  createdAt: string;
  /** 注文受付 API 内部の処理時間（ミリ秒。要件 1.10） */
  acceptLatencyMs: number;
}

/** 段階ごとの進捗（要件 2.5） */
export interface StageProgress {
  stage: OrderStage;
  status: StageResult | "WAITING";
  /** 完了時刻（ISO 8601）。未完了なら null */
  completedAt: string | null;
  /** 注文作成からこの段階の完了までの経過ミリ秒。未完了なら null */
  elapsedMs: number | null;
}

/** 注文ステータス照会レスポンス（GET /orders/{orderId}。要件 2.1） */
export interface OrderStatusResponse {
  orderId: string;
  customerId: string;
  orderStatus: OrderStatus;
  totalAmount: number;
  pointEarned: number;
  items: OrderItem[];
  createdAt: string;
  updatedAt: string;
  /** 完了した後続処理の数（0〜4）。4 で COMPLETED */
  stagesDone: number;
  stages: StageProgress[];
  failureReason: string | null;
  pipelineMode: PipelineMode | null;
  /** 全段階完了までの経過ミリ秒。未完了なら null（要件 2.6） */
  endToEndMs: number | null;
}

/** 顧客別注文一覧レスポンス（GET /orders?customerId=...。要件 2.3） */
export interface OrderListResponse {
  orders: OrderStatusResponse[];
  /** 継続トークン。次ページが無ければ null */
  nextToken: string | null;
}

// ─── 商品マスタ ───────────────────────────────────────────────────

/** 商品マスタ 1 件 */
export interface CatalogProductView {
  sku: string;
  name: string;
  /** 税込単価 */
  price: number;
}

/**
 * 商品マスタ一覧レスポンス（GET /catalog。要件 3.5）。
 *
 * フロントエンドは商品マスタを複製せずこの API から取得する。
 * 出典は `amplify/functions/shared/catalog.ts` の 1 箇所に固定されている（design §5.8）。
 */
export interface CatalogResponse {
  products: CatalogProductView[];
  count: number;
  /** ポイント付与率（購入金額に対する割合） */
  pointRate: number;
}

// ─── 初期在庫投入 ─────────────────────────────────────────────────

/** 初期在庫投入リクエスト（POST /inventory/seed。要件 5.7） */
export interface SeedInventoryRequest {
  /**
   * 投入する在庫数。未指定なら Lambda 側の既定値。
   * 在庫不足（要件 5.3）を意図的に起こす検証のために小さい値も指定できる。
   */
  initialQuantity?: number;
}

/** 初期在庫投入レスポンス */
export interface SeedInventoryResponse {
  warehouseId: string;
  initialQuantity: number;
  /** 投入した在庫レコード件数（商品マスタの SKU 数と一致する） */
  seededCount: number;
  /** `BatchWriteItem` の送信回数 */
  batchCount: number;
  /** `UnprocessedItems` を再送した回数。0 でなければテーブル側が詰まっていた */
  retryCount: number;
  seedLatencyMs: number;
}

// ─── 検証パラメータ ───────────────────────────────────────────────

/** 擬似処理時間（ミリ秒）。擬似待機を持つのは決済と通知の 2 段階のみ（design §10.1） */
export interface StageDelaysMs {
  payment: number;
  notification: number;
}

/** S の出典。見積もりを解釈するために必要な区別（design Property 10） */
export type ShardCountSource = "ASSUMED" | "MEASURED";

/**
 * 消費能力の見積もり（design §2.1 の `S × P ÷ D`）。
 *
 * 算出に使った変数をすべて添えて返る。見積もりだけでは
 * 「どの S / P / D に対する値なのか」が分からない（design Property 10）。
 */
export interface CapacityEstimate {
  /** S: オープンシャード数 */
  openShardCount: number;
  shardCountSource: ShardCountSource;
  /** P: 並列化係数 */
  parallelizationFactor: number;
  /** `S × P`。後続処理が到達し得る最大同時実行数 */
  maxConcurrency: number;
  /** 擬似待機の合計（決済 + 通知）。ミリ秒 */
  pseudoDelayMs: number;
  assumedOverheadMs: number;
  /** D: 1 レコードの処理時間の見積もり。ミリ秒 */
  recordProcessingMs: number;
  /** `S × P ÷ D` を毎分件数に換算した見積もり */
  estimatedCapacityPerMinute: number;
}

/**
 * 検証パラメータ照会レスポンス（GET /config。要件 10.6 / 14.7）。
 *
 * 出典は `.env.local` ではなく**デプロイ済みの Lambda 環境変数**である（design §5.8）。
 */
export interface VerificationConfigResponse {
  pipelineMode: PipelineMode;
  stream: {
    batchSize: number;
    /** 消費能力の変数 P */
    parallelizationFactor: number;
  };
  stageDelaysMs: StageDelaysMs;
  /** 決済の擬似失敗率（0〜1。要件 4.8） */
  paymentFailureRate: number;
  dataTtlDays: number;
  /** 負荷生成・並行計測のパラメータ上限（design §8 の緩和策） */
  limits: {
    maxOrdersPerMinute: number;
    maxDurationSeconds: number;
    maxMeasureConcurrency: number;
  };
  capacity: CapacityEstimate;
}

// ─── 実行（負荷生成 / 並行計測）─────────────────────────────────────

/** 実行の種別 */
export const EXECUTION_TYPES = ["LOAD_TEST", "QUERY_IMPACT"] as const;
export type ExecutionType = (typeof EXECUTION_TYPES)[number];

/** 実行の状態 */
export type ExecutionStatus = "RUNNING" | "COMPLETED" | "FAILED";

/** レイテンシの分位点（要件 12.3） */
export interface LatencyPercentiles {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** 負荷生成開始リクエスト（POST /load-test/start。要件 11.1〜11.3） */
export interface StartLoadTestRequest {
  /** 目標投入レート（件/分）。上限は `limits.maxOrdersPerMinute` */
  ordersPerMinute?: number;
  /** 継続時間（秒）。上限は `limits.maxDurationSeconds` */
  durationSeconds?: number;
  /** 負荷カーブ（漸増 → ピーク → 漸減）を使うか。既定は false（定常負荷。要件 11.3） */
  useRampCurve?: boolean;
}

/**
 * 負荷生成開始レスポンス（202 Accepted。要件 11.9）。
 *
 * 投入は非同期に継続するため、この応答が返った時点の投入件数は 0 である。
 * 進捗は `GET /executions/{executionId}` で照会する（要件 11.6）。
 */
export interface StartLoadTestResponse {
  executionId: string;
  status: ExecutionStatus;
  targetOrdersPerMinute: number;
  durationSeconds: number;
  useRampCurve: boolean;
  startedAt: string;
  /** 実行開始時のオープンシャード数。取得に失敗した場合は null（要件 19.1 / 19.5） */
  openShardCount: number | null;
  shardCountError: string | null;
  estimatedCapacityPerMinute: number | null;
}

/** 並行計測開始リクエスト（POST /measure/start。要件 12.1 / 12.7） */
export interface StartQueryImpactRequest {
  /** 並行数。上限は `limits.maxMeasureConcurrency` */
  concurrency?: number;
  durationSeconds?: number;
  /** 計測対象の注文 ID。`customerId` との同時指定は不可 */
  orderId?: string;
  /** 計測対象の顧客 ID。省略時は既定のテスト顧客 */
  customerId?: string;
  /** 並行して走らせている負荷生成の実行 ID（要件 12.5） */
  loadTestId?: string;
}

/** 並行計測開始レスポンス（202 Accepted。要件 12.1） */
export interface StartQueryImpactResponse {
  executionId: string;
  status: ExecutionStatus;
  concurrency: number;
  durationSeconds: number;
  /** 計測対象を 1 行で表した文字列（例: `GET /orders?customerId=test-0001`） */
  target: string;
  loadTestId: string | null;
  startedAt: string;
  openShardCount: number | null;
  shardCountError: string | null;
  estimatedCapacityPerMinute: number | null;
}

/**
 * 実行時の観測条件（design §11.2 の比較表の出典）。
 *
 * `openShardCount` が非 null であることが**実測できた証拠**である。
 * そのため `CapacityEstimate` のような `shardCountSource` は持たない。
 */
export interface ExecutionConditionsView {
  /** 実行開始時のオープンシャード数 S。取得に失敗した実行は null（要件 19.5） */
  openShardCount: number | null;
  shardCountError: string | null;
  /** 実行時の PF（消費能力の式の変数 P） */
  parallelizationFactor: number;
  stageDelaysMs: StageDelaysMs;
  /** `S × P ÷ D` から算出した消費能力（件/分）。シャード数が取れなかった実行は null */
  estimatedCapacityPerMinute: number | null;
  /** 実行時の warm throughput 設定値（書き込み）。既定のままなら null */
  warmThroughputWrite: number | null;
}

/** 実行状態照会レスポンスの共通部分（GET /executions/{executionId}） */
export interface ExecutionStatusResponseBase {
  executionId: string;
  executionType: ExecutionType;
  status: ExecutionStatus;
  durationSeconds: number;
  startedAt: string;
  finishedAt: string | null;
  /** 経過ミリ秒（要件 11.6）。時刻が解釈できない場合のみ null */
  elapsedMs: number | null;
  errorMessage: string | null;
  conditions: ExecutionConditionsView;
}

/** 負荷生成の実行状態（要件 11.6） */
export interface LoadTestStatusResponse extends ExecutionStatusResponseBase {
  executionType: "LOAD_TEST";
  targetOrdersPerMinute: number;
  /** 実測投入レート（件/分）。完了まで null（要件 11.11） */
  actualOrdersPerMinute: number | null;
  /** 目標との乖離警告。未評価（実行中・失敗）は null。true の行は算術に使わない */
  rateDeviationWarning: boolean | null;
  useRampCurve: boolean;
  submittedCount: number;
  submitErrorCount: number;
}

/** 並行計測の結果（要件 12.5） */
export interface QueryImpactStatusResponse extends ExecutionStatusResponseBase {
  executionType: "QUERY_IMPACT";
  concurrency: number;
  /** 計測完了まで null */
  latencyPercentiles: LatencyPercentiles | null;
  /** スロットルエラー件数（429 / TooManyRequestsException。要件 12.2） */
  throttleCount: number;
  otherErrorCount: number;
  /** 送信したリクエスト総数。エラー率の分母（開始直後は 0） */
  requestCount: number;
  loadTestId: string | null;
}

/**
 * 実行状態照会レスポンス（要件 11.6 / 12.5）。
 *
 * `executionType` で判別する。負荷テストと並行計測は別のパネル（design §11.1）で
 * 表示するため、取り違えないように判別可能な形にしている。
 */
export type ExecutionStatusResponse = LoadTestStatusResponse | QueryImpactStatusResponse;

/** 負荷生成の実行かを判定する（`executionType` による絞り込み） */
export function isLoadTestStatus(
  execution: ExecutionStatusResponse
): execution is LoadTestStatusResponse {
  return execution.executionType === "LOAD_TEST";
}

/** 並行計測の実行かを判定する */
export function isQueryImpactStatus(
  execution: ExecutionStatusResponse
): execution is QueryImpactStatusResponse {
  return execution.executionType === "QUERY_IMPACT";
}

// ─── エラー ──────────────────────────────────────────────────────

/**
 * API のエラーコード（design §E-1 の表と 1 対 1）。
 *
 * | コード | 状況 | ステータス |
 * |-------|------|----------|
 * | `INVALID_REQUEST` | 不正な JSON、必須項目の欠落 | 400 |
 * | `UNKNOWN_SKU` | 商品マスタに存在しない SKU（要件 1.8） | 400 |
 * | `ORDER_NOT_FOUND` | 注文が存在しない（要件 2.4） | 404 |
 * | `EXECUTION_NOT_FOUND` | 実行が存在しない、または TTL で消えた（要件 11.6 / 12.5） | 404 |
 * | `PARAMETER_OUT_OF_RANGE` | 検証パラメータが上限超過（design §8） | 400 |
 * | `INTERNAL_ERROR` | 想定外の例外（詳細はログのみ） | 500 |
 *
 * `EXECUTION_NOT_FOUND` が `ORDER_NOT_FOUND` と別なのは、実行状態のポーリングで
 * 「注文が無い」という誤った案内を出さないためである（design §E-1）。
 */
export const API_ERROR_CODES = {
  INVALID_REQUEST: "INVALID_REQUEST",
  UNKNOWN_SKU: "UNKNOWN_SKU",
  ORDER_NOT_FOUND: "ORDER_NOT_FOUND",
  EXECUTION_NOT_FOUND: "EXECUTION_NOT_FOUND",
  PARAMETER_OUT_OF_RANGE: "PARAMETER_OUT_OF_RANGE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

/**
 * エラー応答の本文（design §E-1）。
 *
 * `error` を `ApiErrorCode` に狭めていないのは、フロントエンドが
 * 想定より古い/新しい API を相手にしうるためである。既知のコードは
 * `isApiErrorCode` で判定し、未知の値は素の文字列として扱う。
 */
export interface ErrorResponse {
  error: string;
  message: string;
  details?: unknown;
}

/** 既知のエラーコードかを判定する（画面の分岐に使う） */
export function isApiErrorCode(value: string): value is ApiErrorCode {
  return Object.prototype.hasOwnProperty.call(API_ERROR_CODES, value);
}
