/**
 * `execution-status` のパスパラメータの取り出しと検証（design §5.8）。
 *
 * ## ルートは 1 本しかない
 *
 * `order-query` は 4 ルートを 1 関数に相乗りさせているためルート判定を持つが、
 * この関数は `GET /executions/{executionId}` だけを担う（design §5.8）。
 * したがってここでの仕事は「実行 ID を確実に取り出すこと」に尽きる。
 *
 * ## 実行 ID は `#` を含む
 *
 * 実行 ID は `LOAD#{ULID}`（`load-generator/load-test-request.ts`）や
 * 並行計測側の接頭辞付き ID であり、注文 ID（`ORD#{ULID}`）と同じく
 * URL では `/executions/LOAD%2301J...` と percent-encode されて届く。
 *
 * **API Gateway の REST API は `pathParameters` をデコードしない。**
 * タスク 13 の実測で `order-query` 側が同じ前提の誤りにより
 * 個別照会が常に 404 になることが判明したため、出典に関係なく
 * 必ず 1 回デコードする（`order-query/routes.ts` の注記を参照）。
 * 実行 ID は接頭辞 + ULID で `%` を含まないため、二重デコードは起きない。
 *
 * ## 接頭辞は検証しない
 *
 * `LOAD#` 以外を弾くことはしない。実行管理テーブルは負荷生成と並行計測で
 * 共有され（design §4.3）、接頭辞の一覧はこの関数の関心ではない。
 * 未知の ID は `GetItem` が空を返し 404 になるので、
 * ここで接頭辞を列挙すると**タスク 18 の接頭辞を足し忘れたときに
 * 400 で弾いてしまう**（正しい実行 ID が照会できなくなる）。
 */

import type { APIGatewayProxyEvent } from 'aws-lambda';
import { API_ERROR_CODES, ApiError } from '../shared/http.js';
import { MAX_ID_LENGTH } from '../shared/order-keys.js';

/** design §5.8 の表のうちこの関数が担うルート（API Gateway 側の定義と対応させる） */
export const EXECUTION_STATUS_RESOURCE = '/executions/{executionId}';

/** パスの第 1 セグメント（`resource` が無い経路での判定に使う） */
const EXECUTIONS_SEGMENT = 'executions';

/**
 * 実行 ID を取り出す（要件 11.6 / 12.5）。
 *
 * @throws {ApiError} 400 `INVALID_REQUEST`（実行 ID が取り出せない、長すぎる）
 */
export function resolveExecutionId(event: APIGatewayProxyEvent): string {
  const raw = event.pathParameters?.executionId ?? readFromPath(event);
  const executionId = decodePathSegment(raw ?? '').trim();

  // `{executionId}` が素通りしてくるのは API Gateway 側のマッピング漏れ
  if (executionId === '' || executionId === '{executionId}') {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      '実行 ID が指定されていません（GET /executions/{executionId}）'
    );
  }
  if (executionId.length > MAX_ID_LENGTH) {
    throw new ApiError(
      API_ERROR_CODES.INVALID_REQUEST,
      `実行 ID が長すぎます（上限 ${MAX_ID_LENGTH} 文字）`
    );
  }

  return executionId;
}

/**
 * パスから実行 ID を読む（`pathParameters` が無い経路のための代替）。
 *
 * `/executions/{id}` の形でなければ `undefined` を返し、呼び出し側で 400 にする。
 * 配線の誤りであれば `resolveExecutionId` のメッセージに正しいパスが出るので、
 * 500 に落とさずとも原因は追える。
 *
 * デコードは呼び出し側（`resolveExecutionId`）で 1 回だけ行うため、
 * ここでは生のセグメントを返す。
 */
function readFromPath(event: APIGatewayProxyEvent): string | undefined {
  const segments = (event.path ?? '').split('/').filter((segment) => segment !== '');
  if (segments.length !== 2 || segments[0] !== EXECUTIONS_SEGMENT) {
    return undefined;
  }
  return segments[1];
}

/** percent-encode を解く。不正なエンコードは元の文字列のまま扱う（404 で返る） */
function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
