/**
 * EMF によるカスタムメトリクスの出力（design 論点 9 / §6.1、要件 16.4 / 20.1 / 20.2）。
 *
 * ## 何のために出すのか
 *
 * 滞留量を直接測るメトリクスは存在しない。CloudWatch が提供するのは
 * `IteratorAge`（時間）だけで、滞留**件数**は `IteratorAge × 投入レート` から導出する
 * （design §2.4 / 論点 9。当初は「× 消費能力」としていたが A2 の実測で訂正した）。
 * その導出が正しいことを裏付けるために、消費能力の実測値をここから出す
 * （導出の検算には投入レートと消費能力の両方が必要である）。
 *
 * | メトリクス | 単位 | 用途 |
 * |-----------|------|------|
 * | `OrdersProcessed` | Count | 消費能力の実測。導出した滞留件数の検算 |
 * | `StageDurationMs` | Milliseconds | 処理時間 D の実測（段階別）。擬似待機以外のオーバーヘッドの把握 |
 *
 * `StageDurationMs` は design §13 の未確定事項 #2（実処理時間 D）を
 * 実測で確定させるための唯一の出典である。
 *
 * ## `StageDurationMs` を単発メトリクスで出す理由
 *
 * `Stage` ディメンションを主インスタンスに付けると、
 * 同じ EMF ブロブに載る `OrdersProcessed` にも同じディメンションが付き、
 * 「段階別の処理件数」という意味の違うメトリクスになってしまう。
 * `singleMetric()` は独立した EMF ブロブを即時に出力するため、
 * ディメンションが混ざらない。
 */

import { MetricUnit, Metrics } from '@aws-lambda-powertools/metrics';
import type { OrderStage } from './types.js';

/** メトリクスの名前空間。ダッシュボード（design §6.1）が参照する */
export const METRICS_NAMESPACE = 'KiroRoasters/OrderPipeline';

/** 既定ディメンション `service` の値 */
export const METRICS_SERVICE_NAME = 'order-pipeline';

/** メトリクス名（design 論点 9 / §6.1 の表と 1 対 1） */
export const METRIC_NAMES = {
  ordersProcessed: 'OrdersProcessed',
  stageDurationMs: 'StageDurationMs',
} as const;

/** ディメンション名 */
export const METRIC_DIMENSIONS = {
  /** 段階名（`payment` / `allocation` / `notification` / `point`） */
  stage: 'Stage',
} as const;

let metrics: Metrics | undefined;

/**
 * メトリクスのシングルトン。
 *
 * 名前空間とサービス名を環境変数（`POWERTOOLS_METRICS_NAMESPACE` など）に委ねず
 * コードで明示するのは、ダッシュボードの定義（IaC）と出力側が
 * 同じ文字列を参照していることをレビューで確かめられるようにするため。
 */
export function getMetrics(): Metrics {
  metrics ??= new Metrics({
    namespace: METRICS_NAMESPACE,
    serviceName: METRICS_SERVICE_NAME,
  });
  return metrics;
}

/**
 * 処理した注文の件数を積む（既定 1 件）。
 *
 * 呼び出し時点では出力されない。`flushMetrics()` でまとめて出す。
 * 1 回の呼び出しで複数レコードを処理する構成（`BatchSize > 1`）でも
 * 件数が正しく積み上がるように加算式にしている。
 */
export function recordOrdersProcessed(count = 1): void {
  getMetrics().addMetric(METRIC_NAMES.ordersProcessed, MetricUnit.Count, count);
}

/**
 * 段階の所要時間を段階別に出力する（即時出力）。
 *
 * 成功・失敗を区別しない。失敗した段階も処理時間を消費してシャードを占有するため、
 * 消費能力の観測には両方が必要である（区別が必要になったら
 * `Result` ディメンションを足す前に design を更新すること）。
 */
export function recordStageDuration(stage: OrderStage, durationMs: number): void {
  getMetrics()
    .singleMetric()
    .addDimension(METRIC_DIMENSIONS.stage, stage)
    .addMetric(METRIC_NAMES.stageDurationMs, MetricUnit.Milliseconds, durationMs);
}

/**
 * 段階の処理を計測しながら実行する。
 *
 * 例外が出ても所要時間を記録してから再送出する。
 * 失敗した段階の所要時間が欠けると、`Invocations` と処理時間の
 * 突き合わせ（論点 10 の検算）が合わなくなる。
 */
export async function measureStageDuration<T>(
  stage: OrderStage,
  execute: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await execute();
  } finally {
    recordStageDuration(stage, Date.now() - startedAt);
  }
}

/**
 * 積んだメトリクスを EMF として出力する。ハンドラの最後に 1 回呼ぶ。
 *
 * 積まれていないときは何も出さない（既定で例外にはならない）。
 * `finally` から呼べるように、この関数自体は例外を投げない設計にしている。
 */
export function flushMetrics(): void {
  getMetrics().publishStoredMetrics();
}

/** テスト用。シングルトンを破棄する */
export function resetMetrics(): void {
  metrics = undefined;
}
