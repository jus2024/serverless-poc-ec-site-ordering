/**
 * Lambda 実行時の環境変数の読み取りと既定値（design §5.3 / §10.1、要件 16.4）。
 *
 * ## `amplify/custom/verification-config.ts` との違い
 *
 * | | 読む場所 | 失敗のタイミング | 対象 |
 * |---|---------|---------------|------|
 * | `verification-config.ts` | CDK 合成時 | デプロイを止める | design §10.1 の全変数 |
 * | 本ファイル | Lambda 実行時 | 呼び出しを失敗させる | テーブル名 + 実行時に必要な検証パラメータ |
 *
 * 両者を分けているのは、Lambda のバンドルに CDK を持ち込まないためである
 * （`shared/` は Lambda からのみ参照する。design §5.3）。
 * その代償として**環境変数のキー名がこの 2 箇所に重複する**。
 * キー名が食い違うと合成は通るのに実行時だけ壊れる（既定値に落ちて静かに誤動作する）ため、
 * `runtime-config.test.ts` で `ORDER_TABLE_ENV_KEYS`（`order-tables.ts`）と
 * `VERIFICATION_ENV_VARS`（`verification-config.ts`）に対する突き合わせを行っている。
 * キーを増減させるときは 3 箇所（合成側・本ファイル・テスト）が揃っていることを確認すること。
 *
 * ## 不正値を既定値へ読み替えない（要件 10.5）
 *
 * 検証パラメータは「どの条件で計測したか」を決める値である。
 * 範囲外の値を黙って既定値にすると計測結果の解釈を誤るため、
 * 合成時と同じく実行時も例外にする。合成時に検証済みなので通常はここを通らないが、
 * Lambda コンソールから環境変数を直接書き換えた場合に効く最後の防波堤である。
 */

/** 未設定時に用いる既定値（design §10.1 の「既定」列。`VERIFICATION_DEFAULTS` と同じ値） */
export const RUNTIME_DEFAULTS = {
  paymentDelayMs: 3000,
  notificationDelayMs: 500,
  paymentFailureRate: 0,
  dataTtlDays: 7,
  maxOrdersPerMinute: 20000,
  maxDurationSeconds: 3600,
  maxMeasureConcurrency: 200,
  streamBatchSize: 1,
  streamParallelizationFactor: 1,
} as const;

/**
 * テーブル名・インデックス名の環境変数キー。
 * `order-tables.ts` の `ORDER_TABLE_ENV_KEYS` が公開する値と一致していなければならない。
 */
export const RUNTIME_TABLE_ENV_KEYS = {
  ordersTableName: 'ORDERS_TABLE_NAME',
  inventoryTableName: 'ORDER_INVENTORY_TABLE_NAME',
  idempotencyTableName: 'ORDER_IDEMPOTENCY_TABLE_NAME',
  executionsTableName: 'ORDER_EXECUTIONS_TABLE_NAME',
  ordersCustomerIndexName: 'ORDERS_CUSTOMER_INDEX_NAME',
} as const;

export type RuntimeTableEnvKey = keyof typeof RUNTIME_TABLE_ENV_KEYS;

/** 解決済みのテーブル名（物理名は合成時に決まるため、値そのものは検証しない） */
export interface RuntimeTableNames {
  /** 注文テーブル（design §4.2） */
  orders: string;
  /** 引当在庫テーブル（design §4.4） */
  inventory: string;
  /** 冪等性管理テーブル（要件 16.6） */
  idempotency: string;
  /** 実行管理テーブル（design §4.3） */
  executions: string;
  /** 注文テーブルの GSI 名（顧客別一覧。要件 2.3） */
  ordersCustomerIndex: string;
}

/**
 * 実行時に必要な検証パラメータ（design §10.1）。
 *
 * ESM の設定値（`streamBatchSize` / `streamParallelizationFactor`）も読むのは、
 * `GET /config` が「実際にデプロイされている条件」を返すため（要件 10.6 / 14.7）と、
 * 消費能力 `S × P ÷ D` の変数 P を実行レコードに刻むため（要件 19.3）である。
 * `ORDER_STREAM_MAX_RECORD_AGE_SECONDS` は ESM の挙動にしか影響せず、
 * 実行時に参照する場面がないため読まない。
 */
export interface RuntimeVerificationParams {
  /** 決済の擬似処理時間（ミリ秒。要件 4.3） */
  paymentDelayMs: number;
  /** 通知の擬似処理時間（ミリ秒。要件 6.6） */
  notificationDelayMs: number;
  /** 決済の擬似失敗率（0〜1。要件 4.8） */
  paymentFailureRate: number;
  /** 検証データの TTL（日。要件 17.6 / design 論点 5） */
  dataTtlDays: number;
  /** 負荷生成の投入レート上限（design §8 の緩和策） */
  maxOrdersPerMinute: number;
  /** 負荷生成・並行計測の継続時間上限（秒） */
  maxDurationSeconds: number;
  /** 並行計測の並行数上限 */
  maxMeasureConcurrency: number;
  /** ESM の batchSize（design §5.6。処理レートの読み方に影響する。論点 10） */
  streamBatchSize: number;
  /** ESM の parallelizationFactor。消費能力の変数 P */
  streamParallelizationFactor: number;
}

/** 解決済みの実行時設定 */
export interface RuntimeConfig {
  tables: RuntimeTableNames;
  params: RuntimeVerificationParams;
}

/** 環境変数が未設定、または範囲外の値だったときの例外 */
export class RuntimeConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      [
        'Lambda の環境変数が不正です（design §10.1 / 要件 10.5）。',
        '既定値へ読み替えず処理を中止します。',
        ...issues.map((issue) => `  - ${issue}`),
      ].join('\n')
    );
    this.name = 'RuntimeConfigError';
    this.issues = issues;
  }
}

interface NumericParamSpec {
  readonly env: string;
  readonly fallback: number;
  readonly min: number;
  readonly max: number;
  readonly integer: boolean;
  /** エラーメッセージに出す範囲の表記（design §10.1 の「範囲」列） */
  readonly range: string;
}

/** design §10.1 の表のうち、実行時に参照する行 */
const NUMERIC_SPECS = {
  paymentDelayMs: {
    env: 'ORDER_PAYMENT_DELAY_MS',
    fallback: RUNTIME_DEFAULTS.paymentDelayMs,
    min: 0,
    max: 60_000,
    integer: true,
    range: '0〜60000',
  },
  notificationDelayMs: {
    env: 'ORDER_NOTIFICATION_DELAY_MS',
    fallback: RUNTIME_DEFAULTS.notificationDelayMs,
    min: 0,
    max: 60_000,
    integer: true,
    range: '0〜60000',
  },
  paymentFailureRate: {
    env: 'ORDER_PAYMENT_FAILURE_RATE',
    fallback: RUNTIME_DEFAULTS.paymentFailureRate,
    min: 0,
    max: 1,
    integer: false,
    range: '0〜1',
  },
  dataTtlDays: {
    env: 'ORDER_DATA_TTL_DAYS',
    fallback: RUNTIME_DEFAULTS.dataTtlDays,
    min: 1,
    max: 30,
    integer: true,
    range: '1〜30',
  },
  maxOrdersPerMinute: {
    env: 'ORDER_MAX_ORDERS_PER_MINUTE',
    fallback: RUNTIME_DEFAULTS.maxOrdersPerMinute,
    min: 1,
    max: 100_000,
    integer: true,
    range: '1〜100000',
  },
  maxDurationSeconds: {
    env: 'ORDER_MAX_DURATION_SECONDS',
    fallback: RUNTIME_DEFAULTS.maxDurationSeconds,
    min: 1,
    max: 7_200,
    integer: true,
    range: '1〜7200',
  },
  maxMeasureConcurrency: {
    env: 'ORDER_MAX_MEASURE_CONCURRENCY',
    fallback: RUNTIME_DEFAULTS.maxMeasureConcurrency,
    min: 1,
    max: 1_000,
    integer: true,
    range: '1〜1000',
  },
  streamBatchSize: {
    env: 'ORDER_STREAM_BATCH_SIZE',
    fallback: RUNTIME_DEFAULTS.streamBatchSize,
    min: 1,
    max: 10_000,
    integer: true,
    range: '1〜10000',
  },
  streamParallelizationFactor: {
    env: 'ORDER_STREAM_PARALLELIZATION_FACTOR',
    fallback: RUNTIME_DEFAULTS.streamParallelizationFactor,
    min: 1,
    max: 10,
    integer: true,
    range: '1〜10',
  },
} as const satisfies Record<keyof RuntimeVerificationParams, NumericParamSpec>;

type NumericParamKey = keyof typeof NUMERIC_SPECS;

/** 実行時に読む環境変数名の一覧（ドキュメント・突き合わせ用） */
export const RUNTIME_ENV_VARS: readonly string[] = [
  ...Object.values(RUNTIME_TABLE_ENV_KEYS),
  ...Object.values(NUMERIC_SPECS).map((spec) => spec.env),
];

export interface ResolveRuntimeOptions {
  /** 環境変数の出典。既定は `process.env` */
  env?: Record<string, string | undefined>;
}

/**
 * テーブル名を 1 つ解決する。
 *
 * 未設定なら例外にする。既定のテーブル名を持たせない理由は、
 * 名前を推測して存在しないテーブルを叩くと `ResourceNotFoundException` になり、
 * 「環境変数の配線漏れ」という本当の原因が分かりにくくなるからである。
 *
 * @throws {RuntimeConfigError} 環境変数が未設定または空文字の場合
 */
export function requireTableName(
  key: RuntimeTableEnvKey,
  options: ResolveRuntimeOptions = {}
): string {
  const env = options.env ?? process.env;
  const envKey = RUNTIME_TABLE_ENV_KEYS[key];
  const value = env[envKey]?.trim();
  if (!value) {
    throw new RuntimeConfigError([
      `${envKey}: 未設定です（Lambda の environment に設定してください。design §5.2）`,
    ]);
  }
  return value;
}

/**
 * 実行時の検証パラメータを解決する。
 *
 * 全項目に既定値があるため未設定では失敗しないが、
 * **解釈できない値・範囲外の値は例外**にする（要件 10.5）。
 * 複数の誤りはまとめて報告する。
 *
 * @throws {RuntimeConfigError} 範囲外・解釈不能な値が 1 つでもある場合
 */
export function resolveVerificationParams(
  options: ResolveRuntimeOptions = {}
): RuntimeVerificationParams {
  const env = options.env ?? process.env;
  const issues: string[] = [];
  const values = {} as Record<NumericParamKey, number>;

  for (const key of Object.keys(NUMERIC_SPECS) as NumericParamKey[]) {
    const spec = NUMERIC_SPECS[key];
    values[key] = parseNumeric(spec, env[spec.env], issues);
  }

  if (issues.length > 0) {
    throw new RuntimeConfigError(issues);
  }

  return { ...values };
}

/**
 * テーブル名 5 つをまとめて解決する。
 * 4 テーブルすべてを触る `order-processor` などが使う。
 *
 * @throws {RuntimeConfigError} 未設定のキーがある場合（全件まとめて報告する）
 */
export function resolveTableNames(options: ResolveRuntimeOptions = {}): RuntimeTableNames {
  const env = options.env ?? process.env;
  const issues: string[] = [];
  const read = (key: RuntimeTableEnvKey): string => {
    const envKey = RUNTIME_TABLE_ENV_KEYS[key];
    const value = env[envKey]?.trim();
    if (!value) {
      issues.push(`${envKey}: 未設定です（Lambda の environment に設定してください）`);
      return '';
    }
    return value;
  };

  const tables: RuntimeTableNames = {
    orders: read('ordersTableName'),
    inventory: read('inventoryTableName'),
    idempotency: read('idempotencyTableName'),
    executions: read('executionsTableName'),
    ordersCustomerIndex: read('ordersCustomerIndexName'),
  };

  if (issues.length > 0) {
    throw new RuntimeConfigError(issues);
  }
  return tables;
}

/**
 * テーブル名と検証パラメータをまとめて解決する。
 *
 * @throws {RuntimeConfigError} 未設定のテーブル名、または不正な検証パラメータがある場合
 */
export function resolveRuntimeConfig(options: ResolveRuntimeOptions = {}): RuntimeConfig {
  return {
    tables: resolveTableNames(options),
    params: resolveVerificationParams(options),
  };
}

let cachedParams: RuntimeVerificationParams | undefined;

/**
 * 検証パラメータのキャッシュ付き取得。
 * Lambda の実行環境が再利用される間は同じ値を返す（環境変数は実行中に変わらない）。
 */
export function getVerificationParams(): RuntimeVerificationParams {
  cachedParams ??= resolveVerificationParams();
  return cachedParams;
}

/** テスト用。キャッシュを破棄する */
export function resetRuntimeConfigCache(): void {
  cachedParams = undefined;
}

/** 1 日の秒数 */
const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * TTL 属性（`expires_at`）の値を返す（Unix timestamp、秒）。
 *
 * 注文レコードと実行レコードの双方で使う（design 論点 5、要件 17.6）。
 * DynamoDB の TTL は秒精度なので切り捨てる。
 *
 * @param dataTtlDays 保持日数
 * @param nowMs 起点時刻（ミリ秒）。既定は現在時刻
 */
export function expiresAtFromNow(dataTtlDays: number, nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000) + dataTtlDays * SECONDS_PER_DAY;
}

function parseNumeric(
  spec: NumericParamSpec,
  raw: string | undefined,
  issues: string[]
): number {
  // 未設定と空文字は同じ扱い（`.env.example` の `KEY=` 形式に合わせる）
  if (raw === undefined || raw.trim() === '') {
    return spec.fallback;
  }

  const text = raw.trim();
  const value = Number(text);

  if (!Number.isFinite(value)) {
    issues.push(
      `${spec.env}: 数値として解釈できません（受け取った値: "${raw}"、範囲: ${spec.range}）`
    );
    return spec.fallback;
  }
  if (spec.integer && !Number.isInteger(value)) {
    issues.push(
      `${spec.env}: 整数で指定してください（受け取った値: ${text}、範囲: ${spec.range}）`
    );
    return spec.fallback;
  }
  if (value < spec.min || value > spec.max) {
    issues.push(`${spec.env}: 範囲外です（受け取った値: ${text}、範囲: ${spec.range}）`);
    return spec.fallback;
  }

  return value;
}
