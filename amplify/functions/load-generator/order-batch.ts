/**
 * 負荷生成の注文書き込み（要件 11.4 / 11.10、design 論点 2 / §5.9）。
 *
 * ## `order-accept` を経由しない
 *
 * 注文は `BatchWriteItem` で注文テーブルへ**直接**書き込む。
 * API 経由にすると `order-accept` 自身が未予約の同時実行プールを消費し、
 * 「後続処理の高負荷が同期パスに波及するか」という問いの観測対象を
 * 計測装置自身が歪めてしまう（要件 11.10、Property 9）。
 * Streams は書き込み経路に関係なく発火するので、直接書き込みでも
 * `order-processor` の起動は同じである。
 *
 * レコードの組み立ては `shared/order-record.ts` に委ねる。
 * `order-accept` と形が食い違うと `order-processor` が受け取る `NewImage` が
 * 経路によって変わってしまうため、ここで独自に組み立てることはしない。
 *
 * ## `inventory-seed/seed-plan.ts` と分けている理由
 *
 * 25 件ずつに分割する形は初期在庫投入と同じだが、`UnprocessedItems` への
 * 対処方針が正反対である。
 *
 * | | 初期在庫投入 | 負荷生成 |
 * |---|------------|---------|
 * | 書き残し | 1 件も許さない（在庫が欠けると引当が失敗する） | 件数を数えて次へ進む |
 * | 再送の待ち | 指数バックオフで最大 1 秒待つ | ほぼ待たない（投入レートが崩れる） |
 * | 打ち切り後 | 500 で失敗させる | エラー件数に加算して継続する |
 *
 * 初期在庫投入の方針をそのまま持ち込むと、書き残しの再送で 1 秒待つ間に
 * 投入が止まり、実測レートが目標から乖離する（要件 11.11 の警告が立つ）。
 * 逆に負荷生成の方針を在庫投入へ持ち込むと在庫が欠ける。
 * 共通化すると必ずどちらかの要求が壊れるため、意図的に別々に置いている。
 */

import type { BatchWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { buildOrderRecord } from '../shared/order-record.js';
import type { OrderRecord } from '../shared/types.js';

/** `BatchWriteItem` の 1 リクエストあたりの上限件数（DynamoDB の仕様） */
export const BATCH_WRITE_MAX_ITEMS = 25;

/**
 * `UnprocessedItems` の再送回数の上限。
 *
 * 2 回に留める。書き残しはテーブル側が詰まっている（= 壁に当たっている）
 * 兆候であり、それ自体が本 Spec の観測対象である。粘って書き切ると
 * 「投入できた」ことになってしまい、詰まりが実行レコードに現れない。
 * 上限を超えた分は `submit_error_count` に積み、投入は次の刻みへ進む。
 */
export const MAX_UNPROCESSED_RETRIES = 2;

/**
 * 再送前の待ち時間（ミリ秒）。
 *
 * 固定値。指数バックオフにしないのは、待つほど投入レートが目標から
 * 離れていくためである（要件 11.11）。1 刻み（1 秒）の中で
 * 2 回の再送を終えられる長さに収めている。
 */
export const UNPROCESSED_RETRY_DELAY_MS = 50;

export interface BuildLoadTestOrdersInput {
  /** 生成する件数（`planTick` が返した `orders`） */
  count: number;
  /** 負荷テスト実行 ID。全レコードの `load_test_id` に入る（要件 11.5） */
  loadTestId: string;
  /** TTL の保持日数（design 論点 5） */
  dataTtlDays: number;
  /**
   * 生成時刻（ミリ秒）。**通常は省略する。**
   *
   * 省略すると 1 件ごとに現在時刻を読む。`created_at` は段階ごとの経過時間
   * （要件 2.5 / 2.6）の起点であり、刻みの先頭時刻で固定すると
   * 最大 1 秒（刻みの長さ）の誤差が全レコードに乗る。
   * 実処理時間 D が数秒の世界では無視できない誤差なので、
   * テストで固定したいときだけ渡す。
   */
  nowMs?: number;
}

/**
 * 投入する注文レコードを組み立てる（要件 11.4）。
 *
 * 明細と顧客 ID は指定しない。`buildOrderRecord` が商品マスタから
 * ランダムに生成する（要件 11.4「生成される注文データは商品マスタに基づく」）。
 */
export function buildLoadTestOrders(input: BuildLoadTestOrdersInput): OrderRecord[] {
  const orders: OrderRecord[] = [];
  for (let index = 0; index < input.count; index += 1) {
    orders.push(
      buildOrderRecord({
        request: { loadTestId: input.loadTestId },
        dataTtlDays: input.dataTtlDays,
        nowMs: input.nowMs,
      })
    );
  }
  return orders;
}

/**
 * 注文レコードを `BatchWriteItem` の入力へ 25 件ずつ分割する。
 *
 * 26 件を積んだリクエストは `ValidationException` で**リクエストごと**失敗する。
 * 分割漏れは「一部が入らない」ではなく「そのバッチが全滅する」形で現れるため、
 * 分割の責務はこの関数だけに閉じる。
 */
export function chunkOrderWriteInputs(
  tableName: string,
  records: readonly OrderRecord[]
): BatchWriteCommandInput[] {
  const inputs: BatchWriteCommandInput[] = [];

  for (let offset = 0; offset < records.length; offset += BATCH_WRITE_MAX_ITEMS) {
    const chunk = records.slice(offset, offset + BATCH_WRITE_MAX_ITEMS);
    inputs.push({
      RequestItems: {
        [tableName]: chunk.map((record) => ({ PutRequest: { Item: { ...record } } })),
      },
    });
  }

  return inputs;
}

/** `BatchWriteItem` の入力に含まれる書き込み要求の件数を数える */
export function countBatchWriteItems(input: BatchWriteCommandInput): number {
  return Object.values(input.RequestItems ?? {}).reduce(
    (total, requests) => total + requests.length,
    0
  );
}

/**
 * `UnprocessedItems` を次の再送入力に変換する。書き残しが無ければ `undefined`。
 *
 * `BatchWriteItem` は**部分的に成功する**（書けなかった分を返してリクエスト自体は
 * 200 で返る）。これを無視すると実行レコードの `submitted_count` が
 * 実際の投入件数より多くなり、実測投入レートが過大に記録される。
 * 投入レートは design §2.4 の算術の分子なので、この誤差は
 * 壁の位置の結論そのものを狂わせる（要件 11.11 / Property 11）。
 *
 * DynamoDB は空の `RequestItems` を許さないため、
 * 「再送すべきものが無い」ことを `undefined` で表す。
 */
export function toRetryBatch(
  unprocessedItems: BatchWriteCommandInput['RequestItems'] | undefined
): BatchWriteCommandInput | undefined {
  if (unprocessedItems === undefined) {
    return undefined;
  }

  const remaining = Object.entries(unprocessedItems).filter(
    ([, requests]) => requests.length > 0
  );
  if (remaining.length === 0) {
    return undefined;
  }

  return { RequestItems: Object.fromEntries(remaining) };
}
