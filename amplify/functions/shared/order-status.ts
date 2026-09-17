/**
 * 段階完了の記録とステータス遷移（design §5.4 / §E-2）。
 *
 * ## 1 段階 = 1 回の UpdateItem
 *
 * 段階属性（`{stage}_status` / `{stage}_at`）・`updated_at`・`order_status`・
 * `stages_done` の加算を **1 回の `UpdateItem` にまとめる**。
 * 4 段階を直列実行する `direct` 構成では注文レコードへの書き込みが
 * 実処理時間 D に直接乗る（design §13 の未確定事項 #2）ため、
 * 1 段階につき 2 回書いていた旧版では書き込み回数が倍になり、
 * 消費能力 `S × P ÷ D` の測定を歪める。
 *
 * ## 単調増加ランクを持たない
 *
 * 旧版は `order_status` の後退を防ぐためにステータスの順位表を持っていたが、
 * 直列実行では巻き戻りが起きないため素朴な上書きで要件 8.5 を満たせる。
 * 並列書き込みへの防御は Phase 2（SQS ファンアウト）の拡張点として
 * design §9 に記録済みであり、本 Spec では**作らない**。
 *
 * ## 進捗の出典
 *
 * 真の出典は段階ごとの `{stage}_status` 属性であり、`order_status` は
 * 「到達した状態」を表す導出値である。照会 API の段階進捗（要件 2.5 / 2.6）は
 * 段階属性から算出する（`buildStageProgress` / `resolveEndToEndMs`）。
 *
 * ## `stages_done` が数えるもの
 *
 * design §5.4 の更新式は結果に関わらずカウンタを加算するため、`stages_done` は
 * **結果が確定した段階の数**（`DONE` と `FAILED` の合計）である。
 * 「4 段階すべてが成功した」の判定にはカウンタを使わず、段階属性を見る
 * （`areAllStagesDone`。`COMPLETED` の条件式も同じ理由で他段階の `= DONE` を要求する）。
 * 失敗した段階は後続を打ち切る（要件 4.6 / 8.6）ので、
 * 直列実行では失敗を含む注文のカウンタが 4 に達することはない。
 *
 * ## テスト可能性
 *
 * `UpdateItem` の入力は純粋関数 `buildStageUpdateCommandInput` が組み立てる。
 * 更新式と条件式は AWS クライアント抜きで検証できる（design §12）。
 */

import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  ORDER_STAGES,
  type OrderRecord,
  type OrderStage,
  type OrderStatus,
  type StageProgress,
  type StageResult,
} from './types.js';

/** 段階が成功したときに到達するステータス（要件 8.5） */
const STAGE_SUCCESS_STATUS: Record<OrderStage, OrderStatus> = {
  payment: 'PAID',
  allocation: 'ALLOCATED',
  notification: 'NOTIFIED',
  point: 'COMPLETED',
};

/**
 * 段階が失敗したときに到達するステータス（design §E-2）。
 *
 * `null` は専用の失敗ステータスを持たない段階。通知とポイント付与の失敗では
 * `order_status` を変えず、`{stage}_status = FAILED` と `failure_reason` に残す。
 * 決済と引当の失敗は終端であり、後続段階を実行しない（要件 4.6 / 8.6 / Property 3）。
 */
const STAGE_FAILURE_STATUS: Record<OrderStage, OrderStatus | null> = {
  payment: 'PAYMENT_FAILED',
  allocation: 'ALLOCATION_FAILED',
  notification: null,
  point: null,
};

/** 段階の結果として記録する値 */
const STAGE_DONE: StageResult = 'DONE';

/**
 * 段階の結果から書き込む `order_status` を決める。
 *
 * `null` を返す場合は `order_status` を更新しない（design §E-2 の通知 / ポイント失敗）。
 */
export function resolveOrderStatus(
  stage: OrderStage,
  result: StageResult
): OrderStatus | null {
  return result === STAGE_DONE ? STAGE_SUCCESS_STATUS[stage] : STAGE_FAILURE_STATUS[stage];
}

/** 全段階が `DONE` かどうか（`FAILED` が 1 つでもあれば false） */
export function areAllStagesDone(order: Partial<OrderRecord>): boolean {
  return ORDER_STAGES.every((stage) => order[`${stage}_status`] === STAGE_DONE);
}

export interface StageUpdateInput {
  tableName: string;
  /** PK */
  orderId: string;
  /** SK */
  customerId: string;
  stage: OrderStage;
  /** 段階の処理結果 */
  result: StageResult;
  /** 記録時刻（ISO 8601）。段階完了時刻と `updated_at` の双方に使う */
  now: string;
  /** 失敗理由（`result = FAILED` のとき。design §E-2） */
  failureReason?: string;
  /** 付与ポイント（`point` 段階の成功時。要件 7.5） */
  pointEarned?: number;
}

/**
 * 段階完了を記録する `UpdateItem` の入力を組み立てる（design §5.4）。
 *
 * ```
 * SET #stageStatus = :stageResult,
 *     #stageAt     = :now,
 *     updated_at   = :now,
 *     order_status = :orderStatus,
 *     stages_done  = if_not_exists(stages_done, :zero) + :one
 * ```
 *
 * `#stageStatus` / `#stageAt` に `ExpressionAttributeNames` を使うのは、
 * 対象の段階が実行時に決まるためである。それ以外の属性は予約語ではないので
 * design の記述どおり直接書く。
 *
 * ## 条件式
 *
 * 基本は `attribute_not_exists(#stageStatus)` の 1 つだけ。
 * 同一段階の二重実行を弾き、`stages_done` の二重加算を防ぐ（Property 1）。
 * 冪等性の一次防御は Powertools Idempotency（design 論点 7）が担い、
 * この条件式は冪等キーが失効した後の再実行に対する二次防御である（Property 7）。
 *
 * `point` 段階の成功時のみ、他 3 段階の完了を条件に加える（Property 4）。
 * `order_status = COMPLETED` が書けたなら 4 段階すべてが `DONE` である、
 * という含意を**追加の書き込みなしで**成立させるための条件である。
 *
 * 失敗時（`order_status` が `COMPLETED` にならないケース）に他段階の条件を付けないのは、
 * Property 4 が要求していないうえ、条件を足すと失敗の記録自体が
 * 書けなくなる場合があるためである（例: 通知が失敗した後にポイント段階の失敗を記録する）。
 */
export function buildStageUpdateCommandInput(input: StageUpdateInput): UpdateCommandInput {
  const { stage, result, now } = input;
  const stageStatusAttribute = `${stage}_status`;

  const setExpressions = [
    '#stageStatus = :stageResult',
    '#stageAt = :now',
    'updated_at = :now',
  ];
  const names: Record<string, string> = {
    '#stageStatus': stageStatusAttribute,
    '#stageAt': `${stage}_at`,
  };
  const values: Record<string, unknown> = {
    ':stageResult': result,
    ':now': now,
    ':zero': 0,
    ':one': 1,
  };

  const orderStatus = resolveOrderStatus(stage, result);
  if (orderStatus !== null) {
    setExpressions.push('order_status = :orderStatus');
    values[':orderStatus'] = orderStatus;
  }

  if (input.failureReason !== undefined) {
    setExpressions.push('failure_reason = :failureReason');
    values[':failureReason'] = input.failureReason;
  }

  if (input.pointEarned !== undefined) {
    setExpressions.push('point_earned = :pointEarned');
    values[':pointEarned'] = input.pointEarned;
  }

  // カウンタの加算は最後に置く（design §5.4 の記述順）
  setExpressions.push('stages_done = if_not_exists(stages_done, :zero) + :one');

  const conditions = ['attribute_not_exists(#stageStatus)'];
  if (orderStatus === 'COMPLETED') {
    // Property 4: COMPLETED は全 4 段階の完了を条件にする
    for (const other of ORDER_STAGES) {
      if (other === stage) continue;
      conditions.push(`${other}_status = :done`);
    }
    values[':done'] = STAGE_DONE;
  }

  return {
    TableName: input.tableName,
    Key: { order_id: input.orderId, customer_id: input.customerId },
    UpdateExpression: `SET ${setExpressions.join(', ')}`,
    ConditionExpression: conditions.join(' AND '),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  };
}

/**
 * 段階の前提条件が満たされていない（design §5.4 の `COMPLETED` の条件）。
 *
 * `point` 段階の更新が条件で弾かれ、かつ `point_status` が未設定だった場合に投げる。
 * 「すでに処理済み」ではなく「他の段階が `DONE` に達していない」状態であり、
 * 冪等に成功として扱ってはならない（記録の取りこぼしになる）。
 *
 * 技術的な失敗として扱い、レコードを再試行対象にする（design §E-2 / 要件 9.8）。
 */
export class StagePreconditionError extends Error {
  readonly stage: OrderStage;

  constructor(stage: OrderStage, orderId: string) {
    super(
      `段階 ${stage} の前提条件が満たされていません（他の段階が DONE に達していない）: ${orderId}`
    );
    this.name = 'StagePreconditionError';
    this.stage = stage;
  }
}

export interface AdvanceStageInput extends Omit<StageUpdateInput, 'now'> {
  docClient: DynamoDBDocumentClient;
  /** 記録時刻（ISO 8601）。既定は現在時刻。テストで固定するために外から渡せる */
  now?: string;
}

export interface AdvanceStageOutput {
  /** 更新後（適用しなかった場合は現在）の注文レコード */
  order: OrderRecord;
  /** 反映後の注文ステータス */
  orderStatus: OrderStatus;
  /**
   * この呼び出しで更新を適用したか。
   *
   * `false` は「すでに同じ段階が記録済み」であり、冪等に成功として扱う（design §5.4）。
   */
  applied: boolean;
}

/**
 * 1 段階の結果を注文レコードに反映する。
 *
 * 成功時の書き込みは `UpdateItem` 1 回のみ。条件で弾かれたときだけ
 * 現在のレコードを読み直し、「すでに記録済み」か「前提条件を満たしていない」かを
 * 判別する。読み直しは再実行時にしか起きないため、通常経路の RCU は増えない。
 */
export async function advanceOrderStage(
  input: AdvanceStageInput
): Promise<AdvanceStageOutput> {
  const { docClient, tableName, orderId, customerId, stage } = input;
  const commandInput = buildStageUpdateCommandInput({
    tableName,
    orderId,
    customerId,
    stage,
    result: input.result,
    now: input.now ?? new Date().toISOString(),
    failureReason: input.failureReason,
    pointEarned: input.pointEarned,
  });

  try {
    const output = await docClient.send(new UpdateCommand(commandInput));
    const order = output.Attributes as OrderRecord;
    return { order, orderStatus: order.order_status, applied: true };
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) {
      throw error;
    }
    const current = await readOrder(docClient, tableName, orderId, customerId);
    if (current[`${stage}_status`] === undefined) {
      // 条件が落ちた理由が二重実行ではない = COMPLETED の前提条件が未達
      throw new StagePreconditionError(stage, orderId);
    }
    return { order: current, orderStatus: current.order_status, applied: false };
  }
}

/** 注文レコードを読む（条件付き更新が弾かれたときの現状確認用） */
async function readOrder(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  orderId: string,
  customerId: string
): Promise<OrderRecord> {
  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { order_id: orderId, customer_id: customerId },
      ConsistentRead: true,
    })
  );
  if (!result.Item) {
    throw new Error(`Order not found: ${orderId} / ${customerId}`);
  }
  return result.Item as OrderRecord;
}

/**
 * 段階ごとの進捗を組み立てる（照会 API 用。要件 2.5）。
 *
 * 未完了の段階は `status = 'WAITING'`（段階属性が存在しないことがそのまま未完了を意味する）。
 * `elapsedMs` は注文作成からその段階の完了までの経過ミリ秒であり、
 * `{stage}_at` は初回完了時にしか書かれない（Property 2）ため
 * 「初回完了までの時間」を表す。
 */
export function buildStageProgress(order: OrderRecord): StageProgress[] {
  const createdAtMs = Date.parse(order.created_at);
  return ORDER_STAGES.map((stage) => {
    const completedAt = order[`${stage}_at`] ?? null;
    const completedAtMs = completedAt === null ? Number.NaN : Date.parse(completedAt);
    const elapsedMs =
      Number.isFinite(createdAtMs) && Number.isFinite(completedAtMs)
        ? completedAtMs - createdAtMs
        : null;
    return {
      stage,
      status: order[`${stage}_status`] ?? 'WAITING',
      completedAt,
      elapsedMs,
    };
  });
}

/**
 * 全段階完了までの経過ミリ秒（要件 2.6）。未完了なら `null`。
 *
 * 最後に完了した段階の時刻を使う。`direct` は直列実行なので通常は `point_at` が最後だが、
 * 「ポイント付与が最後」という実行順への依存を避けて最大値から求める
 * （要件 8.4 が `COMPLETED` を「全段階完了」と定義しているのと同じ理由）。
 */
export function resolveEndToEndMs(order: OrderRecord): number | null {
  if (!areAllStagesDone(order)) return null;

  const createdAtMs = Date.parse(order.created_at);
  if (!Number.isFinite(createdAtMs)) return null;

  const stageAtMs = ORDER_STAGES.map((stage) => order[`${stage}_at`])
    .filter((at): at is string => typeof at === 'string')
    .map((at) => Date.parse(at))
    .filter((ms) => Number.isFinite(ms));

  if (stageAtMs.length !== ORDER_STAGES.length) return null;

  return Math.max(...stageAtMs) - createdAtMs;
}
