/**
 * 検証パラメータの解決と検証（design §10.1 / §10.3、要件 10）。
 *
 * ## この層で検証する理由
 *
 * 検証パラメータは「どの条件で計測したか」を決める値であり、
 * 不正値を既定値に黙って読み替えると**計測結果の解釈を誤る**（要件 10.5）。
 * そのため範囲外の値は合成時に例外として扱い、デプロイ自体を止める。
 * Lambda 実行時ではなく合成時に落とすのは、壊れた設定でリソースが
 * 作られてから気づく事態を避けるため。
 *
 * ## 消費能力の見積もり
 *
 * 消費能力 `S × P ÷ D`（design §2.1）のうち、合成時に分かるのは
 * P（並列化係数）と D の擬似待機部分だけである。
 * S（オープンシャード数）は実行時にしか分からないため、
 * ここでは design §2.2 の暫定値 4 を使った見積もりを提供し、
 * 実測値での再計算は呼び出し側（`GET /config` や実行レコード）に委ねる。
 */

/** 未設定時に用いる既定値の一覧（design §10.1 の「既定」列） */
export const VERIFICATION_DEFAULTS = {
  streamBatchSize: 1,
  streamParallelizationFactor: 1,
  streamMaxRecordAgeSeconds: -1,
  paymentDelayMs: 3000,
  notificationDelayMs: 500,
  paymentFailureRate: 0,
  dataTtlDays: 7,
  maxOrdersPerMinute: 20000,
  maxDurationSeconds: 3600,
  maxMeasureConcurrency: 200,
} as const;

/**
 * 擬似待機以外のオーバーヘッドの暫定値（ミリ秒）。
 *
 * SDK 呼び出し・冪等性チェック・DynamoDB の 4 回更新にかかる時間で、
 * 設計時に D = 3.6 秒（擬似待機 3.5 秒 + 0.1 秒）を前提にしたことに合わせた値である。
 *
 * **タスク 14 の実測は 152.57ms だった**（design §2.2 / §13 の #2 は確定済み）。
 * 据え置きの理由と帰結は `amplify/functions/shared/capacity.ts` の同名定数の
 * コメントに書いてある（要旨: `ASSUMED` 系統の見積もりが約 1.4% 楽観的になる）。
 * **両者は `capacity.test.ts` で一致を突き合わせているため、片方だけ変えられない。**
 */
export const ASSUMED_STAGE_OVERHEAD_MS = 100;

/**
 * オープンシャード数 S の暫定値（design §2.2 / §10.1）。
 *
 * 新規オンデマンドテーブルの即時容量 4,000 WCU から推定した値。
 *
 * **実測済み。ただし有効なのはウォーム前のテーブルに限る。**
 * 軸 A（warm throughput 未設定）ではこの 4 が実測と一致した（タスク 14 / A0）。
 * **軸 B では warm write 40,000 で S = 64 が実測されている**（design §2.5）。
 * **普遍的な値ではない。**値は変更しない（理由は
 * `amplify/functions/shared/capacity.ts` の同名定数と design §10.1）。
 */
export const ASSUMED_OPEN_SHARD_COUNT = 4;

/** 消費能力の見積もりに必要な値（design §2.1） */
export interface CapacityEstimateInputs {
  /** P: シャードあたりの並列バッチ数 */
  parallelizationFactor: number;
  /** 擬似待機の合計（決済 + 通知）。ミリ秒 */
  pseudoDelayMs: number;
  /** 擬似待機以外のオーバーヘッドの想定値。ミリ秒 */
  assumedOverheadMs: number;
  /** D: 1 レコードの処理時間の見積もり。ミリ秒 */
  recordProcessingMs: number;
  /** S の暫定値。実測できるまでの仮置き */
  assumedShardCount: number;
  /** `S × P ÷ D` を毎分件数に換算した見積もり */
  estimatedCapacityPerMinute: number;
}

/** 解決済みの検証パラメータ */
export interface VerificationConfig {
  /** ESM の batchSize（design §5.6） */
  streamBatchSize: number;
  /** ESM の parallelizationFactor。消費能力の変数 P */
  streamParallelizationFactor: number;
  /** ESM の maxRecordAge。-1 は無期限 */
  streamMaxRecordAgeSeconds: number;
  /** 決済の擬似処理時間 */
  paymentDelayMs: number;
  /** 通知の擬似処理時間 */
  notificationDelayMs: number;
  /** 決済の擬似失敗率（0〜1） */
  paymentFailureRate: number;
  /** 注文テーブルの warm throughput（書き込み）。未設定なら undefined */
  warmThroughputWriteUnitsPerSecond?: number;
  /** 注文テーブルの warm throughput（読み取り）。未設定なら undefined */
  warmThroughputReadUnitsPerSecond?: number;
  /** 検証データの TTL（日） */
  dataTtlDays: number;
  /** 負荷生成の投入レート上限 */
  maxOrdersPerMinute: number;
  /** 負荷生成・並行計測の継続時間上限（秒） */
  maxDurationSeconds: number;
  /** 並行計測の並行数上限 */
  maxMeasureConcurrency: number;
  /** 消費能力の見積もりに必要な値 */
  capacity: CapacityEstimateInputs;
  /** 合成時に検証者へ伝える警告（取り返しのつかない設定など） */
  warnings: readonly string[];
}

/** 範囲外・解釈不能な検証パラメータを検出したときの例外 */
export class VerificationConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      [
        '検証パラメータが不正です（design §10.1 / 要件 10.5）。',
        '既定値へ読み替えず合成を中止します。以下を修正してください。',
        ...issues.map((issue) => `  - ${issue}`),
      ].join('\n')
    );
    this.name = 'VerificationConfigError';
    this.issues = issues;
  }
}

interface NumericParamSpec {
  /** 環境変数名 */
  readonly env: string;
  /** 未設定時の値。null は「未設定のまま扱う」（warm throughput） */
  readonly fallback: number | null;
  readonly min: number;
  readonly max: number;
  readonly integer: boolean;
  /** 範囲の外にあるが許容する特例値（ESM の -1 = 無期限） */
  readonly extraAllowed?: readonly number[];
  /** エラーメッセージに出す範囲の表記（design §10.1 の「範囲」列） */
  readonly range: string;
}

/**
 * design §10.1 の表をそのまま写したもの。
 * ここが唯一の出典になるよう、範囲の判定もこの表から行う。
 */
const NUMERIC_SPECS = {
  streamBatchSize: {
    env: 'ORDER_STREAM_BATCH_SIZE',
    fallback: VERIFICATION_DEFAULTS.streamBatchSize,
    min: 1,
    max: 10_000,
    integer: true,
    range: '1〜10000',
  },
  streamParallelizationFactor: {
    env: 'ORDER_STREAM_PARALLELIZATION_FACTOR',
    fallback: VERIFICATION_DEFAULTS.streamParallelizationFactor,
    min: 1,
    max: 10,
    integer: true,
    range: '1〜10',
  },
  streamMaxRecordAgeSeconds: {
    env: 'ORDER_STREAM_MAX_RECORD_AGE_SECONDS',
    fallback: VERIFICATION_DEFAULTS.streamMaxRecordAgeSeconds,
    min: 60,
    max: 604_800,
    integer: true,
    // -1 は「無期限」を表す ESM の特例値。60 未満の有限値は指定できない
    extraAllowed: [-1],
    range: '-1 または 60〜604800',
  },
  paymentDelayMs: {
    env: 'ORDER_PAYMENT_DELAY_MS',
    fallback: VERIFICATION_DEFAULTS.paymentDelayMs,
    min: 0,
    max: 60_000,
    integer: true,
    range: '0〜60000',
  },
  notificationDelayMs: {
    env: 'ORDER_NOTIFICATION_DELAY_MS',
    fallback: VERIFICATION_DEFAULTS.notificationDelayMs,
    min: 0,
    max: 60_000,
    integer: true,
    range: '0〜60000',
  },
  paymentFailureRate: {
    env: 'ORDER_PAYMENT_FAILURE_RATE',
    fallback: VERIFICATION_DEFAULTS.paymentFailureRate,
    min: 0,
    max: 1,
    integer: false,
    range: '0〜1',
  },
  warmThroughputWriteUnitsPerSecond: {
    env: 'ORDER_WARM_THROUGHPUT_WRITE',
    fallback: null,
    min: 4_000,
    max: 1_000_000,
    integer: true,
    range: '4000〜1000000',
  },
  warmThroughputReadUnitsPerSecond: {
    env: 'ORDER_WARM_THROUGHPUT_READ',
    fallback: null,
    min: 4_000,
    max: 1_000_000,
    integer: true,
    range: '4000〜1000000',
  },
  dataTtlDays: {
    env: 'ORDER_DATA_TTL_DAYS',
    fallback: VERIFICATION_DEFAULTS.dataTtlDays,
    min: 1,
    max: 30,
    integer: true,
    range: '1〜30',
  },
  maxOrdersPerMinute: {
    env: 'ORDER_MAX_ORDERS_PER_MINUTE',
    fallback: VERIFICATION_DEFAULTS.maxOrdersPerMinute,
    min: 1,
    max: 100_000,
    integer: true,
    range: '1〜100000',
  },
  maxDurationSeconds: {
    env: 'ORDER_MAX_DURATION_SECONDS',
    fallback: VERIFICATION_DEFAULTS.maxDurationSeconds,
    min: 1,
    max: 7_200,
    integer: true,
    range: '1〜7200',
  },
  maxMeasureConcurrency: {
    env: 'ORDER_MAX_MEASURE_CONCURRENCY',
    fallback: VERIFICATION_DEFAULTS.maxMeasureConcurrency,
    min: 1,
    max: 1_000,
    integer: true,
    range: '1〜1000',
  },
} as const satisfies Record<string, NumericParamSpec>;

type NumericParamKey = keyof typeof NUMERIC_SPECS;

/** 検証パラメータの環境変数名（ドキュメントとの突き合わせ用） */
export const VERIFICATION_ENV_VARS: readonly string[] = Object.values(NUMERIC_SPECS).map(
  (spec) => spec.env
);

export interface ResolveOptions {
  /** 環境変数の出典。既定は `process.env` */
  env?: Record<string, string | undefined>;
  /** 警告の出力先。既定は `console.warn`。null を渡すと出力しない */
  onWarning?: ((message: string) => void) | null;
}

/**
 * 環境変数から検証パラメータを解決する。
 *
 * @throws {VerificationConfigError} 範囲外・解釈不能な値が 1 つでもある場合。
 *   複数ある場合はまとめて報告する（1 回のデプロイで全ての誤りに気づけるように）。
 */
export function resolveVerificationConfig(options: ResolveOptions = {}): VerificationConfig {
  const env = options.env ?? process.env;
  const onWarning = options.onWarning === undefined ? defaultWarn : options.onWarning;

  const issues: string[] = [];
  const values = {} as Record<NumericParamKey, number | null>;

  for (const key of Object.keys(NUMERIC_SPECS) as NumericParamKey[]) {
    values[key] = parseNumeric(NUMERIC_SPECS[key], env[NUMERIC_SPECS[key].env], issues);
  }

  if (issues.length > 0) {
    throw new VerificationConfigError(issues);
  }

  const streamParallelizationFactor = required(values, 'streamParallelizationFactor');
  const paymentDelayMs = required(values, 'paymentDelayMs');
  const notificationDelayMs = required(values, 'notificationDelayMs');

  const warmThroughputWriteUnitsPerSecond =
    values.warmThroughputWriteUnitsPerSecond ?? undefined;
  const warmThroughputReadUnitsPerSecond =
    values.warmThroughputReadUnitsPerSecond ?? undefined;

  const warnings = buildWarnings({
    warmThroughputWriteUnitsPerSecond,
    warmThroughputReadUnitsPerSecond,
  });

  if (onWarning) {
    for (const warning of warnings) onWarning(warning);
  }

  return {
    streamBatchSize: required(values, 'streamBatchSize'),
    streamParallelizationFactor,
    streamMaxRecordAgeSeconds: required(values, 'streamMaxRecordAgeSeconds'),
    paymentDelayMs,
    notificationDelayMs,
    paymentFailureRate: required(values, 'paymentFailureRate'),
    warmThroughputWriteUnitsPerSecond,
    warmThroughputReadUnitsPerSecond,
    dataTtlDays: required(values, 'dataTtlDays'),
    maxOrdersPerMinute: required(values, 'maxOrdersPerMinute'),
    maxDurationSeconds: required(values, 'maxDurationSeconds'),
    maxMeasureConcurrency: required(values, 'maxMeasureConcurrency'),
    capacity: buildCapacityInputs({
      parallelizationFactor: streamParallelizationFactor,
      paymentDelayMs,
      notificationDelayMs,
    }),
    warnings,
  };
}

let cached: VerificationConfig | undefined;

/**
 * 合成中に何度参照しても同じ値を返す（警告の出力も 1 回だけ）。
 * CDK Construct 側はこちらを使う。
 */
export function getVerificationConfig(): VerificationConfig {
  cached ??= resolveVerificationConfig();
  return cached;
}

/** テスト用。キャッシュを破棄する */
export function resetVerificationConfigCache(): void {
  cached = undefined;
}

/**
 * 消費能力の見積もり（design §2.1: `S × P ÷ D`）を毎分件数で返す。
 *
 * @throws {RangeError} 処理時間が 0 以下の場合（消費能力が定義できない）
 */
export function estimateCapacityPerMinute(input: {
  /** S: オープンシャード数 */
  shardCount: number;
  /** P: 並列化係数 */
  parallelizationFactor: number;
  /** D: 1 レコードの処理時間（ミリ秒） */
  recordProcessingMs: number;
}): number {
  if (input.recordProcessingMs <= 0) {
    throw new RangeError('recordProcessingMs は正の値でなければなりません');
  }
  const concurrency = input.shardCount * input.parallelizationFactor;
  return (concurrency * 60_000) / input.recordProcessingMs;
}

function buildCapacityInputs(input: {
  parallelizationFactor: number;
  paymentDelayMs: number;
  notificationDelayMs: number;
}): CapacityEstimateInputs {
  const pseudoDelayMs = input.paymentDelayMs + input.notificationDelayMs;
  const recordProcessingMs = pseudoDelayMs + ASSUMED_STAGE_OVERHEAD_MS;

  return {
    parallelizationFactor: input.parallelizationFactor,
    pseudoDelayMs,
    assumedOverheadMs: ASSUMED_STAGE_OVERHEAD_MS,
    recordProcessingMs,
    assumedShardCount: ASSUMED_OPEN_SHARD_COUNT,
    estimatedCapacityPerMinute: estimateCapacityPerMinute({
      shardCount: ASSUMED_OPEN_SHARD_COUNT,
      parallelizationFactor: input.parallelizationFactor,
      recordProcessingMs,
    }),
  };
}

/**
 * 取り返しのつかない設定について警告文を組み立てる（要件 10.8）。
 *
 * warm throughput は AWS の仕様で**引き上げ後に下げられない**。
 * 合成のたびに目に入る場所で伝える。
 */
export function buildWarnings(input: {
  warmThroughputWriteUnitsPerSecond?: number;
  warmThroughputReadUnitsPerSecond?: number;
}): readonly string[] {
  const configured: string[] = [];
  if (input.warmThroughputWriteUnitsPerSecond !== undefined) {
    configured.push(
      `ORDER_WARM_THROUGHPUT_WRITE=${input.warmThroughputWriteUnitsPerSecond}`
    );
  }
  if (input.warmThroughputReadUnitsPerSecond !== undefined) {
    configured.push(
      `ORDER_WARM_THROUGHPUT_READ=${input.warmThroughputReadUnitsPerSecond}`
    );
  }
  if (configured.length === 0) return [];

  return [
    [
      `[verification-config] warm throughput が設定されています（${configured.join(', ')}）。`,
      'warm throughput は引き上げ後に下げられません（AWS の仕様。要件 10.8 / 17.8）。',
      '引き上げた値に応じた課金が継続します。デプロイ前に design §7.2 の事前確認と承認を済ませてください。',
    ].join(' '),
  ];
}

function defaultWarn(message: string): void {
  // CDK 合成のログにそのまま出す。Construct を受け取らないため Annotations は使わない
  console.warn(message);
}

function parseNumeric(
  spec: NumericParamSpec,
  raw: string | undefined,
  issues: string[]
): number | null {
  // 未設定と空文字（`.env.example` の `ORDER_WARM_THROUGHPUT_WRITE=` 形式）は同じ扱い
  if (raw === undefined || raw.trim() === '') {
    return spec.fallback;
  }

  const text = raw.trim();
  const value = Number(text);

  if (!Number.isFinite(value)) {
    issues.push(
      `${spec.env}: 数値として解釈できません（受け取った値: "${raw}"、範囲: ${spec.range}）`
    );
    return null;
  }
  if (spec.integer && !Number.isInteger(value)) {
    issues.push(
      `${spec.env}: 整数で指定してください（受け取った値: ${text}、範囲: ${spec.range}）`
    );
    return null;
  }

  const inRange = value >= spec.min && value <= spec.max;
  const isExtraAllowed = spec.extraAllowed?.includes(value) ?? false;
  if (!inRange && !isExtraAllowed) {
    issues.push(`${spec.env}: 範囲外です（受け取った値: ${text}、範囲: ${spec.range}）`);
    return null;
  }

  return value;
}

/** 既定値を持つ項目は例外を投げずに解決できているはず。取りこぼしを型で潰すための補助 */
function required(
  values: Record<NumericParamKey, number | null>,
  key: NumericParamKey
): number {
  const value = values[key];
  if (value === null) {
    throw new VerificationConfigError([
      `${NUMERIC_SPECS[key].env}: 既定値が解決できませんでした（実装の不整合）`,
    ]);
  }
  return value;
}
