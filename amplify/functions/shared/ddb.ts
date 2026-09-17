/**
 * DynamoDB クライアントの生成（design §5.3）。
 *
 * ## モジュールスコープで持つ理由
 *
 * Lambda の実行環境が再利用される間、クライアントを作り直さないことで
 * TLS ハンドシェイクと資格情報の取得を初回だけに抑える。
 * 本 Spec では毎分数千回の呼び出しを行うため、この差が処理時間 D に乗る。
 *
 * ## 再試行設定を既定のままにする理由
 *
 * SDK の再試行回数を増やすと、スロットルが**関数の中で吸収されて**
 * `WriteThrottleEvents` に現れる一方で処理は成功する、という状態になる。
 * 本 Spec は「どこが先に壁になるか」を観測することが目的なので（design §2.3）、
 * 壁を隠す方向の設定はしない。既定の standard モード（最大 3 回）のままにする。
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Document クライアントの変換設定。
 *
 * - `removeUndefinedValues`: 未完了の段階属性（`payment_status` など）を
 *   `undefined` のまま渡しても属性を作らせない。「存在しないこと」が
 *   二重実行の検知条件になっているため（design §5.4、要件 8.1）、
 *   `null` を書き込んでしまうと条件式が機能しなくなる
 * - `wrapNumbers`: `false`（既定）。金額とポイントは整数で桁溢れしないため
 *   `BigInt` へのラップは不要
 */
const TRANSLATE_CONFIG = {
  marshallOptions: {
    removeUndefinedValues: true,
    convertClassInstanceToMap: false,
  },
  unmarshallOptions: {
    wrapNumbers: false,
  },
} as const;

let client: DynamoDBClient | undefined;
let documentClient: DynamoDBDocumentClient | undefined;

/**
 * 低レベルの DynamoDB クライアント。
 *
 * `TransactWriteItems` の `CancellationReasons` を解釈する引当処理（design §E-3）と、
 * Powertools 冪等性の永続化層で共有する。
 */
export function getDynamoDBClient(): DynamoDBClient {
  client ??= new DynamoDBClient({});
  return client;
}

/**
 * Document クライアント。属性値のマーシャリングを省くために全ての読み書きで使う。
 * 低レベルクライアントを共有するため、接続は 1 本で済む。
 */
export function getDocumentClient(): DynamoDBDocumentClient {
  documentClient ??= DynamoDBDocumentClient.from(getDynamoDBClient(), TRANSLATE_CONFIG);
  return documentClient;
}

/**
 * テスト用。生成済みのクライアントを破棄する。
 *
 * 本番コードから呼ぶ用途はない（実行環境の再利用を無駄にするだけ）。
 */
export function resetDynamoDBClients(): void {
  documentClient = undefined;
  client = undefined;
}
