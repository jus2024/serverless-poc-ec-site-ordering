/**
 * 注文処理パイプライン全体で共有する型定義（design §4.2 / §4.3）。
 *
 * フロントエンド側の型は src/lib/orders/types.ts に別途定義する
 * （Lambda バンドルとフロントエンドのビルドを独立させるため、意図的に重複させている。要件 18.6）。
 * API のレスポンス形状を変える場合は両方を更新すること。
 *
 * 属性名は DynamoDB のアイテム属性をそのまま写した snake_case、
 * API のリクエスト/レスポンスは JSON の慣例に合わせた camelCase にしている。
 * 型を見れば「どちらの層のものか」が分かるようにするための区別。
 */

/**
 * 後続処理の段階。
 *
 * 本 Spec（`direct` 構成）では 1 つの Lambda がこの 4 段階を直列実行する（design §5.5）。
 */
export const ORDER_STAGES = ['payment', 'allocation', 'notification', 'point'] as const;
export type OrderStage = (typeof ORDER_STAGES)[number];

/** 段階ごとの処理結果 */
export type StageResult = 'DONE' | 'FAILED';

/**
 * 注文ステータス。
 *
 * 正常系は PENDING → PAID → ALLOCATED → NOTIFIED → COMPLETED の順に進む（要件 8.5）。
 * 直列実行なので `order_status` は素朴な上書きで前進させられる。
 * 並列書き込みに対する防御（単調増加ランクなど）は導入しない（design §5.4 / §9）。
 *
 * 進捗の真の出典は段階ごとの `{stage}_status` 属性であり、
 * `order_status` は「到達した状態」を表す導出値である。
 */
export type OrderStatus =
  | 'PENDING'
  | 'PAID'
  | 'ALLOCATED'
  | 'NOTIFIED'
  | 'COMPLETED'
  | 'PAYMENT_FAILED'
  | 'ALLOCATION_FAILED';

/**
 * パイプライン構成。
 *
 * - direct: Streams → order-processor 直結（本 Spec）
 * - fanout: Streams → ルーター → SQS × 4 → ワーカー × 4（将来の拡張。design §9）
 *
 * 本 Spec では常に `direct` を記録する。検証結果を後から見分けるために注文レコードに刻む。
 */
export type PipelineMode = 'direct' | 'fanout';

/** 注文明細 */
export interface OrderItem {
  /** 商品 SKU（例: ITEM#ETH-YIRG-G1-MEDIUM-200G） */
  sku: string;
  /** 数量 */
  qty: number;
  /** 単価（税込） */
  price: number;
}

/**
 * 注文レコード（`kiro-roasters-orders` テーブルのアイテム）。
 *
 * 段階ごとの `{stage}_status` / `{stage}_at` は該当段階が完了するまで存在しない（要件 8.1）。
 * 「存在しないこと」が二重実行の検知条件になっている（design §5.4）ため、
 * 未完了の段階に既定値を入れてはならない。
 */
export interface OrderRecord {
  /** PK: ORD#{ULID} */
  order_id: string;
  /** SK: CUST#{customer-id} */
  customer_id: string;
  order_status: OrderStatus;
  items: OrderItem[];
  total_amount: number;
  point_earned: number;
  created_at: string;
  updated_at: string;

  /** 完了した後続処理の数（0〜4）。4 に到達したら COMPLETED（要件 8.2 / 8.4） */
  stages_done?: number;

  payment_status?: StageResult;
  payment_at?: string;
  allocation_status?: StageResult;
  allocation_at?: string;
  notification_status?: StageResult;
  notification_at?: string;
  point_status?: StageResult;
  point_at?: string;

  /** 失敗理由（PAYMENT_FAILED / ALLOCATION_FAILED 時） */
  failure_reason?: string;

  /**
   * 負荷テストの実行 ID。同一実行で投入した注文をまとめて集計するために使う（要件 11.5）。
   * 手動投入した注文には付かない。
   */
  load_test_id?: string;

  /** この注文を処理したパイプライン構成。本 Spec では常に `direct` */
  pipeline_mode: PipelineMode;

  /** TTL（Unix timestamp、秒）。既定は投入から 7 日後（design 論点 5） */
  expires_at: number;
}

/** 注文受付リクエスト（POST /orders） */
export interface CreateOrderRequest {
  /** 顧客 ID。未指定時はランダムなテスト顧客を割り当てる */
  customerId?: string;
  /** 注文明細。未指定時は商品マスタからランダムに生成する */
  items?: OrderItem[];
  /** 負荷テスト実行 ID（負荷生成時のみ） */
  loadTestId?: string;
}

/** 注文受付レスポンス */
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

/** 段階ごとの進捗（GET /orders/{orderId} のレスポンス用） */
export interface StageProgress {
  stage: OrderStage;
  status: StageResult | 'WAITING';
  /** 完了時刻（ISO 8601）。未完了なら null */
  completedAt: string | null;
  /** 注文作成からこの段階の完了までの経過ミリ秒。未完了なら null（要件 2.5） */
  elapsedMs: number | null;
}

/** 注文ステータス照会レスポンス（GET /orders/{orderId}） */
export interface OrderStatusResponse {
  orderId: string;
  customerId: string;
  orderStatus: OrderStatus;
  totalAmount: number;
  pointEarned: number;
  items: OrderItem[];
  createdAt: string;
  updatedAt: string;
  stagesDone: number;
  stages: StageProgress[];
  failureReason: string | null;
  pipelineMode: PipelineMode | null;
  /** 全段階完了までの経過ミリ秒。未完了なら null（要件 2.6） */
  endToEndMs: number | null;
}

/** 顧客別注文一覧レスポンス（GET /orders?customerId=...） */
export interface OrderListResponse {
  orders: OrderStatusResponse[];
  nextToken: string | null;
}

/** 商品マスタ 1 件（GET /catalog。`shared/catalog.ts` の `CatalogProduct` と同形） */
export interface CatalogProductView {
  sku: string;
  name: string;
  /** 税込単価 */
  price: number;
  // 以下は表示用の属性。SKU の構成要素の表示名をそのまま返す。
  // 表示専用であり、SKU 形式・価格・注文処理には影響しない（要件 1.6）。
  /** 産地の表示名（例: "エチオピア イルガチェフェ G1"。要件 1.2） */
  origin: string;
  /** 焙煎度の表示名（例: "ミディアム"。要件 1.3） */
  roast: string;
  /** 容量の表示名（例: "200g"。要件 1.4） */
  size: string;
}

/**
 * 商品マスタ一覧レスポンス（GET /catalog。要件 3.5）。
 *
 * フロントエンドは商品マスタを複製せずこの API から取得する。
 * `shared/catalog.ts` を唯一の出典にするためのエンドポイントである（design §5.8）。
 */
export interface CatalogResponse {
  products: CatalogProductView[];
  count: number;
  /** ポイント付与率（購入金額に対する割合）。画面の付与ポイント表示に使う */
  pointRate: number;
}

/**
 * 引当在庫レコード（引当在庫テーブルのアイテム。design §4.4）。
 *
 * キーは PK `itemId`（商品 SKU）/ SK `warehouseId`。
 * `itemName` と `unitPrice` を持たせているのは、在庫テーブル単体を覗いたときに
 * どの商品の在庫か分かるようにするためで、引当の判定には使わない
 * （判定は `quantity` だけ。商品名と単価の出典は `shared/catalog.ts` である）。
 */
export interface InventoryRecord {
  /** PK: 商品 SKU（例: ITEM#ETH-YIRG-G1-MEDIUM-200G） */
  itemId: string;
  /** SK: 倉庫 ID。本 Spec では単一倉庫に固定（要件 5.9） */
  warehouseId: string;
  /** 商品名（商品マスタからの写し。可読性のためだけに持つ） */
  itemName: string;
  /** 在庫数。引当は `quantity >= :qty` の条件付き減算で行う（要件 5.5） */
  quantity: number;
  /** 税込単価（商品マスタからの写し） */
  unitPrice: number;
  /** 最終更新時刻（ISO 8601） */
  lastUpdated: string;
}

/** 初期在庫投入リクエスト（POST /inventory/seed。要件 5.7） */
export interface SeedInventoryRequest {
  /**
   * 投入する在庫数。未指定なら既定値（design 論点 6: 10,000,000）。
   *
   * 在庫不足（要件 5.3）を意図的に起こす検証のために小さい値も指定できる。
   * 倉庫 ID は指定できない（要件 5.9 により固定。`shared/inventory-keys.ts`）。
   */
  initialQuantity?: number;
}

/** 初期在庫投入レスポンス（要件 5.7） */
export interface SeedInventoryResponse {
  /** 投入先の倉庫 ID（固定値） */
  warehouseId: string;
  /** 実際に適用した在庫数 */
  initialQuantity: number;
  /** 投入した在庫レコード件数（商品マスタの SKU 数と一致する） */
  seededCount: number;
  /** `BatchWriteItem` の送信回数（25 件ずつに分割した数） */
  batchCount: number;
  /** `UnprocessedItems` を再送した回数。0 でなければテーブル側が詰まっていた */
  retryCount: number;
  /** 投入 API 内部の処理時間（ミリ秒） */
  seedLatencyMs: number;
}

/** S の出典。見積もりを解釈するために必要な区別（Property 10 / 11） */
export type ShardCountSource =
  /** design §2.2 の暫定値。実測ではない */
  | 'ASSUMED'
  /** `DescribeStream` で実測した値 */
  | 'MEASURED';

/**
 * 消費能力の見積もり（design §2.1 の `S × P ÷ D`）。
 *
 * 算出に使った変数をすべて添えて返す。見積もりだけを返すと
 * 「どの S / P / D に対する値なのか」が後から分からなくなる（Property 10）。
 */
export interface CapacityEstimate {
  /** S: オープンシャード数 */
  openShardCount: number;
  /** S が実測値か暫定値か */
  shardCountSource: ShardCountSource;
  /** P: 並列化係数 */
  parallelizationFactor: number;
  /** `S × P`。後続処理が到達し得る最大同時実行数 */
  maxConcurrency: number;
  /** 擬似待機の合計（決済 + 通知）。ミリ秒 */
  pseudoDelayMs: number;
  /** 擬似待機以外のオーバーヘッドの想定値。ミリ秒 */
  assumedOverheadMs: number;
  /** D: 1 レコードの処理時間の見積もり。ミリ秒 */
  recordProcessingMs: number;
  /** `S × P ÷ D` を毎分件数に換算した見積もり */
  estimatedCapacityPerMinute: number;
}

/**
 * 検証パラメータ照会レスポンス（GET /config。要件 10.6 / 14.7）。
 *
 * 出典は `.env.local` ではなく**デプロイ済みの Lambda 環境変数**である。
 * 計測条件の取り違えを防ぐため、値の出典を 1 つに固定する（design §5.8）。
 *
 * ここに現れない検証パラメータが 2 つある。
 *
 * | 項目 | 返さない理由 |
 * |------|------------|
 * | warm throughput | テーブル側の設定であり Lambda の環境変数に無い。`DescribeTable` を持つ `load-generator` が実行レコードに記録する（design §5.7） |
 * | `ORDER_STREAM_MAX_RECORD_AGE_SECONDS` | ESM の挙動にしか影響せず、実行時に参照しない（`runtime-config.ts` も読まない） |
 */
export interface VerificationConfigResponse {
  /** この構成が処理するパイプライン。本 Spec では常に `direct` */
  pipelineMode: PipelineMode;
  /** Streams イベントソースマッピングの設定（design §5.6） */
  stream: {
    /** 1 呼び出しで受け取るレコード数。処理レートの読み方に影響する（design 論点 10） */
    batchSize: number;
    /** 消費能力の変数 P */
    parallelizationFactor: number;
  };
  /** 擬似処理時間（D の構成要素。要件 4.3 / 6.6） */
  stageDelaysMs: StageDelaysMs;
  /** 決済の擬似失敗率（0〜1。要件 4.8） */
  paymentFailureRate: number;
  /** 検証データの TTL（日。要件 17.6） */
  dataTtlDays: number;
  /** 負荷生成・並行計測のパラメータ上限（design §8 の緩和策） */
  limits: {
    maxOrdersPerMinute: number;
    maxDurationSeconds: number;
    maxMeasureConcurrency: number;
  };
  /** 消費能力の見積もり。S は暫定値（`shardCountSource` を参照） */
  capacity: CapacityEstimate;
}

// ─── 実行管理テーブル（design §4.3）──────────────────────────────
//
// 負荷生成と並行計測が同じテーブルを共有し、`execution_type` で判別する。
// 実行条件（シャード数・PF・擬似処理時間・算出した消費能力）を
// レコード自身に埋め込むことで、後から結果を解釈できるようにする（要件 19.3 / Property 10）。

/** 実行の種別 */
export const EXECUTION_TYPES = ['LOAD_TEST', 'QUERY_IMPACT'] as const;
export type ExecutionType = (typeof EXECUTION_TYPES)[number];

/** 実行の状態 */
export type ExecutionStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

/**
 * 実行時の擬似処理時間（ミリ秒）。
 *
 * 擬似待機を持つのは決済と通知の 2 段階のみ（design §10.1）。
 * 引当は `TransactWriteItems`、ポイント付与は属性更新だけで待機を挟まない。
 */
export interface StageDelaysMs {
  payment: number;
  notification: number;
}

/** レイテンシの分位点（要件 12.3） */
export interface LatencyPercentiles {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** 負荷生成・並行計測に共通の実行レコード属性 */
interface ExecutionRecordBase {
  /** PK */
  execution_id: string;
  execution_type: ExecutionType;
  status: ExecutionStatus;
  /** 継続時間（秒） */
  duration_seconds: number;

  // ─── 観測条件（要件 19。実行を自己記述的にする）───────────────
  /** 実行開始時のオープンシャード数 S。取得に失敗した場合は未設定（要件 19.1） */
  open_shard_count?: number;
  /** シャード数の取得に失敗した理由。設定されている実行は消費能力の検証に使わない（要件 19.5） */
  shard_count_error?: string;
  /** 実行時の PF（消費能力の式の変数 P） */
  parallelization_factor: number;
  /** 実行時の擬似処理時間 */
  stage_delays_ms: StageDelaysMs;
  /** `S × P ÷ D` から算出した消費能力（件/分）。シャード数が取れない場合は未設定（要件 19.3） */
  estimated_capacity_per_minute?: number;
  /** 実行時の warm throughput 設定値（書き込み。軸 B の追跡用）。未設定なら既定のまま */
  warm_throughput_write?: number;

  /** ISO 8601 */
  started_at: string;
  /** ISO 8601。実行中は未設定 */
  finished_at?: string;
  /** 失敗時のメッセージ（design §E-6） */
  error_message?: string;
  /** TTL（Unix timestamp、秒） */
  expires_at: number;
}

/** 負荷生成の実行レコード（`execution_type = LOAD_TEST`） */
export interface LoadTestExecutionRecord extends ExecutionRecordBase {
  execution_type: 'LOAD_TEST';
  /** 目標投入レート（件/分） */
  target_orders_per_minute: number;
  /** 実測投入レート（件/分）。投入件数 ÷ 経過時間から算出する（要件 11.11） */
  actual_orders_per_minute?: number;
  /** 目標と実測の乖離が閾値を超えた（design 論点 10。この実行は §2.4 の算術に使わない） */
  rate_deviation_warning?: boolean;
  /** 負荷カーブ（漸増 → ピーク → 漸減）を使うか。false なら定常負荷 */
  use_ramp_curve: boolean;
  /** 投入件数 */
  submitted_count: number;
  /** 投入エラー件数 */
  submit_error_count: number;
}

/** 負荷生成開始リクエスト（POST /load-test/start。要件 11.1〜11.3） */
export interface StartLoadTestRequest {
  /** 目標投入レート（件/分）。上限は `maxOrdersPerMinute`（要件 11.7 / design §8） */
  ordersPerMinute?: number;
  /** 継続時間（秒）。上限は `maxDurationSeconds` */
  durationSeconds?: number;
  /**
   * 負荷カーブ（漸増 → ピーク → 漸減）を使うか（要件 11.2）。
   * 既定は false（定常負荷。要件 11.3。壁の位置の測定に適する。design 論点 2）
   */
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
  /** シャード数の取得に失敗した理由。成功時は null */
  shardCountError: string | null;
  /** `S × P ÷ D` から算出した消費能力（件/分）。シャード数が取れない場合は null（要件 19.3） */
  estimatedCapacityPerMinute: number | null;
}

/** 並行計測の実行レコード（`execution_type = QUERY_IMPACT`） */
export interface QueryImpactExecutionRecord extends ExecutionRecordBase {
  execution_type: 'QUERY_IMPACT';
  /** 並行数（要件 12.7） */
  concurrency: number;
  /** レイテンシの分位点。計測完了まで未設定 */
  latency_percentiles?: LatencyPercentiles;
  /** スロットルエラー件数（429 / TooManyRequestsException。要件 12.2） */
  throttle_count: number;
  /** スロットル以外のエラー件数 */
  other_error_count: number;
  /** 送信したリクエスト総数。分位点の標本数と一致する */
  request_count?: number;
  /**
   * 並行して走らせていた負荷生成の実行 ID（要件 12.5）。
   *
   * 投入レートをこのレコードに書き写さず ID で参照するのは、
   * レートの出典を 1 つに保つためである（`query-impact-measure/execution-record.ts`）。
   * 手動で並行計測だけを回した場合は未設定。
   */
  load_test_id?: string;
}

/** 並行計測開始リクエスト（POST /measure/start。要件 12.1 / 12.7） */
export interface StartQueryImpactRequest {
  /** 並行数（要件 12.7）。上限は `maxMeasureConcurrency`（design §8） */
  concurrency?: number;
  /**
   * 継続時間（秒）。上限は `maxDurationSeconds` と
   * `MAX_MEASURE_DURATION_SECONDS`（1 回の invoke で測り切る制約）の厳しい方
   */
  durationSeconds?: number;
  /**
   * 計測対象の注文 ID。指定すると `GET /orders/{orderId}` を叩く。
   * `customerId` との同時指定は不可
   */
  orderId?: string;
  /**
   * 計測対象の顧客 ID。指定すると `GET /orders?customerId=` を叩く。
   * 省略時は既定のテスト顧客（`DEFAULT_TARGET_CUSTOMER_ID`）
   */
  customerId?: string;
  /**
   * 並行して走らせている負荷生成の実行 ID（要件 12.5）。
   * 投入レートはその実行レコード側が出典になる
   */
  loadTestId?: string;
}

/**
 * 並行計測開始レスポンス（202 Accepted。要件 12.1）。
 *
 * 計測は非同期に継続するため、この応答にレイテンシやエラー件数は含まれない。
 * 結果は `GET /executions/{executionId}` で照会する（要件 12.5）。
 */
export interface StartQueryImpactResponse {
  executionId: string;
  status: ExecutionStatus;
  concurrency: number;
  durationSeconds: number;
  /** 計測対象を 1 行で表した文字列（例: `GET /orders?customerId=test-0001`） */
  target: string;
  /** 並行して走らせている負荷生成の実行 ID。指定が無ければ null */
  loadTestId: string | null;
  startedAt: string;
  /** 実行開始時のオープンシャード数。取得に失敗した場合は null（要件 19.1 / 19.5） */
  openShardCount: number | null;
  /** シャード数の取得に失敗した理由。成功時は null */
  shardCountError: string | null;
  /** `S × P ÷ D` から算出した消費能力（件/分）。シャード数が取れない場合は null（要件 19.3） */
  estimatedCapacityPerMinute: number | null;
}

/**
 * 実行レコード。`execution_type` で判別する（design §4.3）。
 */
export type ExecutionRecord = LoadTestExecutionRecord | QueryImpactExecutionRecord;

/**
 * 実行時の観測条件（`GET /executions/{executionId}` のレスポンス用）。
 *
 * 実行レコードに刻んだ条件（要件 19.3 / Property 10）をそのまま返す。
 * 見積もりだけを返すと「どの S / P / D に対する値なのか」が分からなくなるため、
 * 消費能力と算出に使った変数を必ず同じ塊で返す。
 *
 * `openShardCount` が非 null であることが**実測できた証拠**である
 * （実行レコードは実測時のみこの属性を書く。`load-generator/execution-record.ts`）。
 * したがって `CapacityEstimate` のような `shardCountSource` は持たない。
 */
export interface ExecutionConditionsView {
  /** 実行開始時のオープンシャード数 S。取得に失敗した場合は null（要件 19.1 / 19.5） */
  openShardCount: number | null;
  /** シャード数の取得に失敗した理由。成功時は null（この実行は消費能力の検証に使わない） */
  shardCountError: string | null;
  /** 実行時の PF（消費能力の式の変数 P） */
  parallelizationFactor: number;
  /** 実行時の擬似処理時間（D の構成要素） */
  stageDelaysMs: StageDelaysMs;
  /** `S × P ÷ D` から算出した消費能力（件/分）。シャード数が取れなかった実行は null */
  estimatedCapacityPerMinute: number | null;
  /** 実行時の warm throughput 設定値（書き込み）。既定のままなら null */
  warmThroughputWrite: number | null;
}

/**
 * 実行状態照会レスポンスの共通部分（GET /executions/{executionId}）。
 *
 * 種別ごとの応答はこれを拡張して `executionType` を具体値へ狭める。
 * 共通部分だけを組み立てる関数の戻り値型としても使うため公開している。
 */
export interface ExecutionStatusResponseBase {
  executionId: string;
  executionType: ExecutionType;
  status: ExecutionStatus;
  durationSeconds: number;
  startedAt: string;
  /** 完了時刻（ISO 8601）。実行中は null */
  finishedAt: string | null;
  /**
   * 経過ミリ秒（要件 11.6）。完了済みなら `finished_at − started_at`、
   * 実行中なら現在時刻までの経過。時刻が解釈できない場合のみ null。
   */
  elapsedMs: number | null;
  /** 失敗時のメッセージ（design §E-6）。それ以外は null */
  errorMessage: string | null;
  conditions: ExecutionConditionsView;
}

/** 負荷生成の実行状態（要件 11.6） */
export interface LoadTestStatusResponse extends ExecutionStatusResponseBase {
  executionType: 'LOAD_TEST';
  targetOrdersPerMinute: number;
  /** 実測投入レート（件/分）。完了まで null（要件 11.11 / Property 11） */
  actualOrdersPerMinute: number | null;
  /** 目標との乖離警告。未評価（実行中・失敗）は null */
  rateDeviationWarning: boolean | null;
  useRampCurve: boolean;
  submittedCount: number;
  submitErrorCount: number;
}

/** 並行計測の結果（要件 12.5） */
export interface QueryImpactStatusResponse extends ExecutionStatusResponseBase {
  executionType: 'QUERY_IMPACT';
  concurrency: number;
  /** レイテンシの分位点（要件 12.3）。計測完了まで null */
  latencyPercentiles: LatencyPercentiles | null;
  /** スロットルエラー件数（429 / TooManyRequestsException。要件 12.2） */
  throttleCount: number;
  /** スロットル以外のエラー件数 */
  otherErrorCount: number;
  /**
   * 送信したリクエスト総数（要件 12.1）。
   *
   * エラー率（スロットル件数 ÷ 総数）の分母である。これを返さないと
   * フロントエンド（design §11.2 の比較表）は件数だけを並べることになり、
   * 「並行数を上げたからエラーが増えた」のか「率が上がった」のかを
   * 区別できない。開始直後は 0。
   */
  requestCount: number;
  /**
   * 並行して走らせていた負荷生成の実行 ID（要件 12.5）。指定が無ければ null。
   *
   * 投入レートはこの ID で負荷生成の実行レコードを引いて得る
   * （実測値と乖離警告が付いている方を出典にする。Property 11）。
   */
  loadTestId: string | null;
}

/**
 * 実行状態照会レスポンス（GET /executions/{executionId}。要件 11.6 / 12.5）。
 *
 * `executionType` で判別する。フロントエンドは負荷テストと並行計測を
 * 別のパネル（design §11.1）で表示するため、共通部分だけを見て
 * 取り違えることがないように判別可能な形で返す。
 */
export type ExecutionStatusResponse = LoadTestStatusResponse | QueryImpactStatusResponse;

/** エラーレスポンス（design §E-1） */
export interface ErrorResponse {
  error: string;
  message: string;
  details?: unknown;
}
