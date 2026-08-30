/**
 * 消費能力の見積もり（design §2.1: `消費能力 = S × P ÷ D`）。
 *
 * ## なぜ Lambda 側にも置くのか
 *
 * 同じ式が `amplify/custom/verification-config.ts`（合成時）にもある。
 * 重複だが、`shared/` は Lambda からのみ参照する規約（design §5.3）があり、
 * CDK 側のモジュールを Lambda のバンドルに引き込むことはしない。
 * `runtime-config.ts` が `verification-config.ts` と環境変数キーを重複させているのと
 * 同じ構図であり、同じ対処を取る（`capacity.test.ts` で両者の一致を突き合わせる）。
 *
 * 実行時にこの式が必要なのは 2 箇所ある。
 *
 * | 用途 | 対応要件 |
 * |------|---------|
 * | `GET /config` が返す消費能力の見積もり | 10.6 / 14.7 |
 * | 負荷生成の実行レコードに刻む `estimated_capacity_per_minute` | 19.3 |
 *
 * ## S（オープンシャード数）の扱い
 *
 * **S は実行時にしか分からない。** CloudWatch メトリクスとしても提供されない
 * （要件 19 の但し書き）。取得手段は `DescribeStream` であり、
 * それを持つのは `load-generator`（design §5.7 / §5.9）だけである。
 * `order-query` は注文テーブルへの `Query` 権限しか持たない（要件 2.8）ため、
 * `GET /config` は暫定値 S = 4 での見積もりを返し、
 * **その値が暫定であることを応答自身に明示する**（`shardCountSource`）。
 *
 * 実測値が判明した実行では、同じ関数に実測 S を渡して再計算する
 * （`load-generator` が実行レコードに記録する値がそれである）。
 */

import type { CapacityEstimate, StageDelaysMs } from './types.js';

/**
 * 擬似待機以外のオーバーヘッドの暫定値（ミリ秒）。
 *
 * SDK 呼び出し・冪等性チェック・注文レコードの 4 回更新にかかる時間。
 * 設計時に D = 3.6 秒（擬似待機 3.5 秒 + 0.1 秒）を前提にしたことに合わせた値である。
 *
 * **タスク 14 の実測は 152.57ms だった**（design §2.2 / §13 の #2 は確定済み）。
 * それでもこの暫定値を 100 のまま据え置いている。この定数は `GET /config` が返す
 * 見積もり（`shardCountSource` が `ASSUMED` の系統）と実行レコードに刻まれる値を
 * 決めるため、変更するとデプロイ済みの応答が変わる。シナリオ実行の条件に関わる
 * 判断であり、テストやコメントの整合とは切り離して扱う。
 *
 * 据え置きの帰結: `ASSUMED` の見積もりは実測より **約 1.4% 楽観的**になる
 * （D 3,600 対 3,652.57 → 式の値 667 対 657/分）。壁の位置の議論では無視できる差だが、
 * 見積もりと実測を突き合わせる場面ではこの差を承知しておくこと。
 * 実測 D を使いたい呼び出し側は `assumedOverheadMs` に明示的に渡せる。
 *
 * **100 は「固定成分」としては実測に裏づけられた値である**（design §2.2）。
 * 擬似待機を 3,500ms → 600ms に変えた実測で D は 697.7ms であり、
 * オーバーヘッドは固定 **約 98ms** + 擬似待機に比例する成分 **約 55ms** に分解できた。
 * つまり実測 152.57ms は固定費ではなく **固定 約 100ms + 擬似待機の約 1%** である。
 * **したがってこの定数を 152 に上げるのは誤りで、100 のままが正しい。**
 * 過小になるのは擬似待機が長い条件だけである（決済 3,000ms で 52.57ms ぶん、D の 1.4%）。
 *
 * **なお、この関数が返すのは式 `S × P ÷ D` の値であって実測の壁の位置ではない。**
 * P = 10 では実測が式の 0.84〜0.85 倍にとどまる（design §2.2 の 7'）。
 * 見積もりの用途上ここに係数は掛けない。掛けるかどうかは呼び出し側の判断である。
 */
export const ASSUMED_STAGE_OVERHEAD_MS = 100;

/**
 * オープンシャード数 S の暫定値（design §2.2 / §10.1）。
 *
 * 新規オンデマンドテーブルの即時容量 4,000 WCU から推定した値。
 *
 * **実測済み。ただし有効なのはウォーム前のテーブルに限る。**
 * 軸 A（warm throughput 未設定）ではこの 4 が実測と一致した（タスク 14 / A0）。
 * **軸 B では warm write 40,000 で S = 64 が実測されており、この暫定値は
 * 16 分の 1 の過小評価になる**（design §2.5）。**普遍的な値ではない。**
 *
 * 値は変更しない。変更すると `GET /config` の応答と、軸 A の実行レコードに
 * 記録済みの `estimated_capacity_per_minute` が互いに整合しなくなる（design §10.1）。
 * 暫定値が使われた見積もりは `shardCountSource = 'ASSUMED'` で識別できる。
 */
export const ASSUMED_OPEN_SHARD_COUNT = 4;

/** 1 分のミリ秒数 */
const MS_PER_MINUTE = 60_000;

/**
 * 消費能力（件/分）を返す（design §2.1）。
 *
 * `BatchSize` は式に現れない。バッチ内を直列処理する限り
 * `S × P × BatchSize ÷ (BatchSize × D)` は約分される（design §2.1）。
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
  return (concurrency * MS_PER_MINUTE) / input.recordProcessingMs;
}

/**
 * 擬似待機の合計から D を求める。
 *
 * 待機を持つ段階は決済と通知の 2 つだけ（design §10.1）。
 * 引当（`TransactWriteItems`）とポイント付与（属性更新）は待機を挟まないため、
 * その所要時間は `assumedOverheadMs` に含めて扱う。
 */
export function resolveRecordProcessingMs(
  stageDelaysMs: StageDelaysMs,
  assumedOverheadMs: number = ASSUMED_STAGE_OVERHEAD_MS
): number {
  return stageDelaysMs.payment + stageDelaysMs.notification + assumedOverheadMs;
}

/**
 * 消費能力の見積もりを組み立てる。
 *
 * `openShardCount` を省略すると暫定値（S = 4）を使い、
 * `shardCountSource = 'ASSUMED'` を立てる。実測値を渡した場合は `'MEASURED'`。
 *
 * @throws {RangeError} D が 0 以下になる場合（擬似待機とオーバーヘッドがすべて 0）
 */
export function buildCapacityEstimate(input: {
  parallelizationFactor: number;
  stageDelaysMs: StageDelaysMs;
  /** 実測したオープンシャード数。未指定なら暫定値を使う */
  openShardCount?: number;
  /** 擬似待機以外のオーバーヘッドの想定値。既定は `ASSUMED_STAGE_OVERHEAD_MS` */
  assumedOverheadMs?: number;
}): CapacityEstimate {
  const assumedOverheadMs = input.assumedOverheadMs ?? ASSUMED_STAGE_OVERHEAD_MS;
  const pseudoDelayMs = input.stageDelaysMs.payment + input.stageDelaysMs.notification;
  const recordProcessingMs = resolveRecordProcessingMs(input.stageDelaysMs, assumedOverheadMs);

  const measured = input.openShardCount !== undefined;
  const openShardCount = input.openShardCount ?? ASSUMED_OPEN_SHARD_COUNT;

  return {
    openShardCount,
    shardCountSource: measured ? 'MEASURED' : 'ASSUMED',
    parallelizationFactor: input.parallelizationFactor,
    maxConcurrency: openShardCount * input.parallelizationFactor,
    pseudoDelayMs,
    assumedOverheadMs,
    recordProcessingMs,
    estimatedCapacityPerMinute: estimateCapacityPerMinute({
      shardCount: openShardCount,
      parallelizationFactor: input.parallelizationFactor,
      recordProcessingMs,
    }),
  };
}
