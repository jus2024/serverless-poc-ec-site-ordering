/**
 * 4 段階の直列実行（要件 9.2、design §5.5 / §E-2、論点 7）。
 *
 * ## 直列であることが整合性の保証になっている
 *
 * 決済 → 引当 → 通知 → ポイントの順に実行し、**失敗した段階で打ち切る**
 * （要件 4.6 / 8.6）。「`PAYMENT_FAILED` の注文が後から `PAID` に戻らない」
 * という性質（Property 3）は、この打ち切りだけで成り立っている。
 * 並列化すると打ち切りが効かなくなるため、別の保証手段が必要になる
 * （design §9 の拡張点に記録済み）。
 *
 * ## 業務的な失敗は例外にしない
 *
 * 決済拒否と在庫不足は `StageResult = 'FAILED'` として**返す**。
 * 例外にすると `catch` の分岐次第で `batchItemFailures` に混ざり、
 * 「業務的な失敗は再試行しない」（要件 16.7）が守られているかどうかが
 * 呼び出し側の実装に依存してしまう。返り値にすれば、
 * **例外として上がるものは技術的な失敗だけ**になる（`failure-policy.ts`）。
 *
 * 冪等性の観点でも返り値の方が正しい。Powertools は例外時に冪等レコードを
 * 削除するため、例外で表すと「前回の結果を返す」（要件 4.7 / 5.4）が
 * 成立しない。返り値なら終端の結果が冪等レコードに保存され、
 * 同じ `INSERT` が再配信されても擬似決済をやり直さずに同じ結果が返る。
 *
 * ## 通知・ポイント段階の技術的な失敗では段階属性を書かない（design §E-2 の解釈）
 *
 * design §E-2 は通知の失敗を「`notification_status = FAILED` を記録し、
 * レコードを再試行対象にする」と書いている。しかしこの 2 つは両立しない。
 * `{stage}_status` を書くと、次の再試行で `advanceOrderStage` の条件式
 * `attribute_not_exists(#stageStatus)`（design §5.4）が落ちて
 * 「すでに処理済み」と判定され、**通知が二度と実行されないまま
 * `point` 段階へ進んでしまう**（design §5.4 の「条件失敗は冪等に成功として扱う」）。
 *
 * そこで次のように決めた。
 *
 * | 失敗の種別 | 段階属性 | レコードの扱い |
 * |-----------|---------|--------------|
 * | 業務的な失敗（決済拒否・在庫不足） | `{stage}_status = FAILED` を書く | 終端。再試行しない |
 * | 技術的な失敗（SDK エラー等） | **何も書かない** | 再試行する |
 *
 * `{stage}_status = FAILED` は「もう実行しない」という宣言であり、
 * 再試行させたい失敗と併用してはならない。通知とポイント付与には
 * 業務的な失敗の条件が存在しない（擬似待機とログ出力、属性更新のみ）ため、
 * 本 Spec の実装では `notification_status = FAILED` と `point_status = FAILED`
 * は書かれない。`order-status.ts` は書ける形を保っているので、
 * 通知に業務的な失敗（宛先不正など）を持ち込む拡張の余地は残っている。
 */

import type { Logger } from '@aws-lambda-powertools/logger';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { calculatePoints } from '../shared/catalog.js';
import { getDocumentClient } from '../shared/ddb.js';
import { makeStageIdempotent, type StageIdempotencyPayload } from '../shared/idempotency.js';
import { measureStageDuration } from '../shared/metrics.js';
import { advanceOrderStage } from '../shared/order-status.js';
import type { RuntimeTableNames, RuntimeVerificationParams } from '../shared/runtime-config.js';
import {
  ORDER_STAGES,
  type OrderStage,
  type OrderStatus,
  type StageResult,
} from '../shared/types.js';
import {
  buildAllocationTransactItems,
  interpretCancellationReasons,
  toAllocationTargets,
} from './allocation.js';
import { buildNotificationContent } from './notification.js';
import { PAYMENT_DECLINED_REASON, shouldDeclinePayment } from './payment.js';
import type { StreamOrder } from './stream-record.js';

/** 段階の実行に必要な外部依存（テーブル名・検証パラメータ・ロガー） */
export interface StageContext {
  tables: RuntimeTableNames;
  params: RuntimeVerificationParams;
  logger: Logger;
}

/** 4 段階を通した結果 */
export type ProcessOrderOutcome =
  /** 全段階が成功し `COMPLETED` に到達した */
  | { status: 'COMPLETED'; pointEarned: number }
  /** 業務的な失敗で打ち切った（再試行しない。要件 16.7） */
  | { status: 'TERMINATED'; stage: OrderStage; reason: string };

/**
 * 段階関数の入力。
 *
 * `orderId` を最上位に持つのは冪等キーの決定に使われるためである
 * （`shared/idempotency.ts` の `eventKeyJmesPath = 'orderId'`）。
 * `order` の中身が変わっても冪等キーは変わらない。
 */
interface StageInput extends StageIdempotencyPayload {
  order: StreamOrder;
  context: StageContext;
}

/**
 * 段階関数の出力。
 *
 * **JSON で往復できる形に保つこと。** 冪等レコードの `data` 属性に
 * そのまま保存され、二重実行時はここから復元した値が返る
 * （`undefined` を含めると再実行時に欠落する。`shared/idempotency.ts`）。
 */
interface StageOutput {
  result: StageResult;
  orderStatus: OrderStatus;
  /** 付与ポイント（`point` 段階の成功時のみ。他は `null`） */
  pointEarned: number | null;
  /** 業務的な失敗の理由（`result = 'FAILED'` のときのみ。他は `null`） */
  failureReason: string | null;
}

type StageExecutor = (input: StageInput) => Promise<StageOutput>;

/**
 * 4 段階を直列に実行する（design §5.5 の手順 3）。
 *
 * 実行順は `ORDER_STAGES` の並び（決済 → 引当 → 通知 → ポイント）に従う。
 * 順序の出典を `shared/types.ts` に 1 つ持たせているのは、
 * `order_status` の遷移（要件 8.5）と `stages_done` の意味づけが
 * 同じ並びを前提にしているためである。
 */
export async function processOrder(
  order: StreamOrder,
  context: StageContext
): Promise<ProcessOrderOutcome> {
  const input: StageInput = { orderId: order.orderId, order, context };
  let pointEarned = 0;

  for (const stage of ORDER_STAGES) {
    // 所要時間は成功・失敗どちらでも記録する（消費能力の実測に必要。design 論点 9）
    const output = await measureStageDuration(stage, () => getStageRunner(stage)(input));

    if (output.result === 'FAILED') {
      return {
        status: 'TERMINATED',
        stage,
        reason: output.failureReason ?? '理由の記録がありません',
      };
    }
    if (output.pointEarned !== null) {
      pointEarned = output.pointEarned;
    }
  }

  return { status: 'COMPLETED', pointEarned };
}

/**
 * 段階ごとの冪等ラッパー（design 論点 7）。
 *
 * 初回利用時に作る。`makeStageIdempotent` が冪等性テーブル名を要求するため、
 * モジュール読み込み時に作ると環境変数が未設定な文脈（単体テストなど）で
 * import そのものが失敗する。作成後は実行環境が再利用される間キャッシュされる。
 */
const stageRunners = new Map<OrderStage, StageExecutor>();

function getStageRunner(stage: OrderStage): StageExecutor {
  const cached = stageRunners.get(stage);
  if (cached !== undefined) return cached;

  const runner = makeStageIdempotent<StageInput, StageOutput>(stage, STAGE_EXECUTORS[stage]);
  stageRunners.set(stage, runner);
  return runner;
}

/** テスト用。冪等ラッパーのキャッシュを破棄する */
export function resetStageRunners(): void {
  stageRunners.clear();
}

/**
 * 決済（要件 4.1〜4.5 / 4.8）。
 *
 * 擬似待機が処理時間 D の主成分である（既定 3,000ms。design §10.1）。
 * 待機を挟んでから失敗判定するのは、実際の外部決済 API が
 * 「待たされた末に拒否される」形で失敗するからである。
 * 先に判定すると失敗した注文だけ処理時間が短くなり、
 * 段階所要時間（EMF）の解釈が失敗率に依存してしまう。
 */
async function executePayment({ order, context }: StageInput): Promise<StageOutput> {
  await sleep(context.params.paymentDelayMs);

  if (shouldDeclinePayment(context.params.paymentFailureRate, Math.random())) {
    context.logger.warn('擬似決済が拒否されました。後続段階を実行しません', {
      orderId: order.orderId,
      paymentFailureRate: context.params.paymentFailureRate,
    });
    return recordStage(order, context, 'payment', {
      result: 'FAILED',
      failureReason: PAYMENT_DECLINED_REASON,
    });
  }

  return recordStage(order, context, 'payment', { result: 'DONE' });
}

/**
 * 引当（要件 5.1〜5.6 / 5.8、design 論点 1 / §E-3）。
 *
 * 全明細を 1 つの `TransactWriteItems` で処理する。
 * `CancellationReasons` の解釈は `allocation.ts` に委ね、ここは
 * 「業務的な失敗なら終端、技術的な失敗なら再送出」の分岐だけを持つ。
 */
async function executeAllocation({ order, context }: StageInput): Promise<StageOutput> {
  const targets = toAllocationTargets(order.items);
  const commandInput = buildAllocationTransactItems({
    tableName: context.tables.inventory,
    targets,
    now: new Date().toISOString(),
  });

  try {
    await getDocumentClient().send(new TransactWriteCommand(commandInput));
  } catch (error) {
    if (!(error instanceof TransactionCanceledException)) throw error;

    const failure = interpretCancellationReasons(targets, error.CancellationReasons);
    if (failure.kind === 'TECHNICAL') {
      context.logger.warn('引当トランザクションが技術的な理由で取り消されました', {
        orderId: order.orderId,
        technicalCodes: failure.technicalCodes,
      });
      // 再試行対象にする（要件 9.8）。段階属性は書かない（冒頭の表）
      throw error;
    }

    context.logger.warn('在庫が不足しています。後続段階を実行しません', {
      orderId: order.orderId,
      insufficientSkus: failure.insufficientSkus,
    });
    return recordStage(order, context, 'allocation', {
      result: 'FAILED',
      failureReason: failure.reason,
    });
  }

  return recordStage(order, context, 'allocation', { result: 'DONE' });
}

/**
 * 通知（要件 6.1〜6.3 / 6.6 / 6.7）。
 *
 * メール送信は構造化ログで代替する。ログを 1 行の文字列に組み立てず
 * 構造化フィールドに載せるのは、CloudWatch Logs Insights で
 * 注文 ID から通知内容を引けるようにするためである。
 */
async function executeNotification({ order, context }: StageInput): Promise<StageOutput> {
  await sleep(context.params.notificationDelayMs);

  const content = buildNotificationContent(order);
  if (content.unresolvedSkus.length > 0) {
    // 通知は止めない（`notification.ts` の注記）。事実だけ残す
    context.logger.warn('商品マスタから商品名を解決できない SKU があります', {
      orderId: order.orderId,
      unresolvedSkus: content.unresolvedSkus,
    });
  }

  context.logger.info('注文確認メールを送信しました（構造化ログで代替）', {
    notification: content,
  });

  return recordStage(order, context, 'notification', { result: 'DONE' });
}

/**
 * ポイント付与（要件 7.1 / 7.2 / 7.3 / 7.5）。
 *
 * 擬似待機を持たない。`point_earned` を書きながら `order_status` を
 * `COMPLETED` にする 1 回の `UpdateItem` で終わる。
 * `COMPLETED` の条件式に他 3 段階の完了が含まれるため（Property 4）、
 * この更新が通ったことが「全 4 段階が成功した」ことの証明になる。
 */
async function executePoint({ order, context }: StageInput): Promise<StageOutput> {
  const pointEarned = calculatePoints(order.totalAmount);
  return recordStage(order, context, 'point', { result: 'DONE', pointEarned });
}

const STAGE_EXECUTORS: Record<OrderStage, StageExecutor> = {
  payment: executePayment,
  allocation: executeAllocation,
  notification: executeNotification,
  point: executePoint,
};

interface StageRecordInput {
  result: StageResult;
  failureReason?: string;
  pointEarned?: number;
}

/**
 * 段階の結果を注文レコードに記録する（design §5.4）。
 *
 * `applied = false` は「すでに同じ段階が記録済み」であり冪等に成功として扱う。
 * 通常は Powertools 冪等性がここへ到達する前に前回の結果を返すため、
 * これが起きるのは冪等キーが失効した後の再実行（design 論点 7 の二次防御が
 * 効いた場面）である。**滞留が冪等レコードの有効期間を超えて伸びた**ことを
 * 示す手掛かりになるので INFO で残す。
 */
async function recordStage(
  order: StreamOrder,
  context: StageContext,
  stage: OrderStage,
  outcome: StageRecordInput
): Promise<StageOutput> {
  const applied = await advanceOrderStage({
    docClient: getDocumentClient(),
    tableName: context.tables.orders,
    orderId: order.orderId,
    customerId: order.customerId,
    stage,
    result: outcome.result,
    failureReason: outcome.failureReason,
    pointEarned: outcome.pointEarned,
  });

  if (!applied.applied) {
    context.logger.info('段階はすでに記録済みでした（冪等に成功として扱います）', {
      orderId: order.orderId,
      stage,
      orderStatus: applied.orderStatus,
    });
  }

  return {
    result: outcome.result,
    orderStatus: applied.orderStatus,
    pointEarned: outcome.pointEarned ?? null,
    failureReason: outcome.failureReason ?? null,
  };
}

/**
 * 擬似待機（要件 4.2 / 6.3）。
 *
 * 0ms でも `setTimeout` を通す。分岐を入れて 0 のときだけ同期に返すと、
 * 擬似待機を 0 にした検証（design §10.2 の A6 系）でイベントループの
 * 譲り方が変わり、比較したい 2 条件の間に待機時間以外の差が生まれる。
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
