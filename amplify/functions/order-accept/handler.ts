/**
 * 注文受付 Lambda（`POST /orders`。要件 1、design §5.2 / §5.8）。
 *
 * ## 何をして、何をしないのか
 *
 * この関数は注文レコードを 1 件 `PutItem` するだけで終わる（IAM 権限も
 * `PutItem` のみ。design §5.9）。決済・引当・通知・ポイント付与は
 * Streams 経由で `order-processor` が実行するため、**後続処理の完了を待たない**
 * （要件 1.7）。応答が返った時点で `order_status` は必ず `PENDING` である。
 *
 * ## 自身の処理時間を応答に含める理由（要件 1.10）
 *
 * 本 PoC の問いは「後続処理の高負荷が同期パスに波及するか」である（design §2.6）。
 * 波及は Lambda のスロットル、すなわち**エラー**として現れる想定だが（design §2.7）、
 * 遅延として現れる可能性も否定できない。受付側の内部処理時間を毎回応答に載せておくと、
 * 呼び出し側で観測した往復時間との差から
 * 「遅いのは受付処理か、その手前（同時実行の獲得・API Gateway）か」を切り分けられる。
 *
 * `Date.now()` はハンドラの入口で取る。JSON の組み立てまで含めたいので
 * 計測の終点は `PutItem` の直後ではなく応答の生成直前に置いている。
 *
 * ## X-Ray アノテーション（要件 13.4、design §6.3）
 *
 * API 側と Streams 側のトレースは自動では連結されない
 * （DynamoDB Streams がトレースコンテキストを伝播しないため）。
 * `order-accept` と `order-processor` の双方で `order_id` をアノテーションに付け、
 * 注文 ID で突き合わせられるようにするのが design §6.3 の対応方針である。
 *
 * 注釈は `shared/tracing.ts` の `withOrderSubsegment` で付ける。Lambda 実行環境の
 * 主セグメント（ファサードセグメント）に直接付けても Powertools が黙って捨てるため、
 * 自分でサブセグメントを開く必要がある（理由は同モジュールの注記）。
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDocumentClient } from '../shared/ddb.js';
import { ApiError, created, parseJsonBody, toErrorResponse } from '../shared/http.js';
import { getVerificationParams, requireTableName } from '../shared/runtime-config.js';
import { withOrderSubsegment } from '../shared/tracing.js';
import {
  buildOrderRecord,
  parseCreateOrderRequest,
  toCreateOrderResponse,
} from './order-request.js';

const SERVICE_NAME = 'order-accept';

const logger = new Logger({ serviceName: SERVICE_NAME });
const tracer = new Tracer({ serviceName: SERVICE_NAME });

/** 注文の書き込みを表すサブセグメントの名前（design §6.3） */
export const ORDER_SUBSEGMENT_NAME = '## acceptOrder';

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const startedAt = Date.now();

  try {
    const request = parseCreateOrderRequest(parseJsonBody(event.body));
    const { dataTtlDays } = getVerificationParams();
    const record = buildOrderRecord({ request, dataTtlDays });

    // 注釈は書き込みを囲むサブセグメントに付ける。
    // PutItem が失敗したトレースも注文 ID で引けるようにするため
    await withOrderSubsegment(
      { tracer, name: ORDER_SUBSEGMENT_NAME, orderId: record.order_id },
      () =>
        getDocumentClient().send(
          new PutCommand({
            TableName: requireTableName('ordersTableName'),
            Item: record,
          })
        )
    );

    return created(toCreateOrderResponse(record, Date.now() - startedAt));
  } catch (error) {
    // toErrorResponse はログを出さない（shared/http.ts の注記）。ここで出す。
    // 呼び出し側の入力ミス（400）は warn に留める。負荷生成中に大量の
    // 検証エラーが出たとき、ERROR ログの件数を「システム側の異常」の指標として
    // 使えるようにしておくため。
    if (error instanceof ApiError) {
      logger.warn('注文の受付を拒否しました', {
        errorCode: error.code,
        message: error.message,
        details: error.details,
      });
    } else {
      logger.error('注文の受付に失敗しました', { error });
    }
    return toErrorResponse(error);
  }
};
