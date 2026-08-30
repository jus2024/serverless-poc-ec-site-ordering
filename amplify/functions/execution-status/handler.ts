/**
 * 実行状態照会 Lambda（`GET /executions/{executionId}`。要件 11.6 / 12.5、design §5.8）。
 *
 * 負荷生成（`LOAD_TEST`）と並行計測（`QUERY_IMPACT`）の実行レコードを
 * 同じルートで返す。判別は `execution_type`（design §4.3）。
 *
 * | 種別 | 主に返すもの | 対応要件 |
 * |------|------------|---------|
 * | `LOAD_TEST` | 投入件数・エラー件数・経過時間・実測レート・実行条件 | 11.6 / 11.11 |
 * | `QUERY_IMPACT` | レイテンシ分位点・スロットル件数・実行条件 | 12.2 / 12.3 / 12.5 |
 *
 * ## この関数がポーリング先である
 *
 * 負荷生成と並行計測は開始要求に 202 を返して非同期に継続する（要件 11.9）。
 * 検証者が進捗と失敗（design §E-6 の `FAILED`）を知る経路はここだけなので、
 * **実行中のレコードでも必ず 200 を返す**（未完了の値は null で返す。`views.ts`）。
 *
 * ## 書き込まない（design §5.9）
 *
 * IAM は `executions: GetItem` のみ。実行レコードを書けるのは
 * 負荷生成と並行計測の当事者だけであり、照会が触ると投入件数や
 * 実測レートの出典が曖昧になる。`views.ts` も書き込み系のコマンドを
 * import していない。
 *
 * ## X-Ray のアノテーションを付けない（design §6.3）
 *
 * 注文 ID による突き合わせ（要件 13.4）はこの関数の関心ではない。
 * 実行 ID は注文レコードの `load_test_id` に刻まれており（要件 11.5）、
 * 突き合わせはそちらで足りる。1 件の `GetItem` にサブセグメントを開く価値もない。
 */

import { Logger } from '@aws-lambda-powertools/logger';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { getDocumentClient } from '../shared/ddb.js';
import { API_ERROR_CODES, ApiError, ok, toErrorResponse } from '../shared/http.js';
import { requireTableName } from '../shared/runtime-config.js';
import type { ExecutionRecord, ExecutionStatusResponse } from '../shared/types.js';
import { resolveExecutionId } from './routes.js';
import {
  UnknownExecutionTypeError,
  buildExecutionGetInput,
  toExecutionStatusResponse,
} from './views.js';

const SERVICE_NAME = 'execution-status';

const logger = new Logger({ serviceName: SERVICE_NAME });

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    return ok(await getExecution(resolveExecutionId(event)));
  } catch (error) {
    if (error instanceof ApiError) {
      // 呼び出し側の入力ミス（400 / 404）は warn に留める。負荷生成中の
      // ERROR ログ件数を「システム側の異常」の指標として使えるようにするため
      // （order-query / order-accept と同じ方針）
      logger.warn('実行状態の照会を拒否しました', {
        errorCode: error.code,
        message: error.message,
        details: error.details,
      });
    } else if (error instanceof UnknownExecutionTypeError) {
      // 実行レコードの書き手側の不整合。呼び出し側では直せないので 500 に落とす
      logger.error('未知の execution_type の実行レコードを読み込みました', {
        executionId: error.executionId,
        executionType: error.executionType,
      });
    } else {
      logger.error('実行状態の照会に失敗しました', { error });
    }
    return toErrorResponse(error);
  }
};

/**
 * 実行レコードを 1 件返す。存在しなければ 404（design §E-1）。
 *
 * TTL（既定 7 日。design 論点 5）で消えた実行の照会もここに来る。
 * 応答の `details` に実行 ID を載せているのは、
 * 検証者が「打ち間違い」と「保持期限切れ」を切り分けられるようにするため。
 */
async function getExecution(executionId: string): Promise<ExecutionStatusResponse> {
  const output = await getDocumentClient().send(
    new GetCommand(
      buildExecutionGetInput({
        tableName: requireTableName('executionsTableName'),
        executionId,
      })
    )
  );

  const record = output.Item as ExecutionRecord | undefined;
  if (record === undefined) {
    throw new ApiError(
      API_ERROR_CODES.EXECUTION_NOT_FOUND,
      '指定された実行は存在しません（TTL で削除された可能性があります）',
      { executionId }
    );
  }

  return toExecutionStatusResponse(record);
}
