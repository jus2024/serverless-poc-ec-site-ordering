import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource.js';
import { OrderAlarms } from './custom/order-alarms.js';
import { OrderApi } from './custom/order-api.js';
import { OrderFunctions } from './custom/order-functions.js';
import { OrderMonitoring } from './custom/order-monitoring.js';
import { OrderStream } from './custom/order-stream.js';
import { OrderTables } from './custom/order-tables.js';
import { getVerificationConfig } from './custom/verification-config.js';
import { data } from './data/resource.js';

const backend = defineBackend({
  auth,
  data,
});

/**
 * 注文処理パイプライン PoC のリソース（design §5.1）。
 *
 * auth / data とは別のネストスタックに置く。検証終了後に
 * このスタックだけを削除できる状態を保つため（要件 17.1 / 17.5）であり、
 * テンプレートのリソース数を分けておくためでもある。
 *
 * 検証パラメータの解決はここで 1 度だけ行い、Construct 間で共有する。
 * 範囲外の値があればこの時点で例外になり、デプロイは始まらない（要件 10.5）。
 * warm throughput の引き下げ不可の警告も、この解決の中で 1 度だけ出る（要件 10.8）。
 */
const orderStack = backend.createStack('OrderPipelinePoc');
const config = getVerificationConfig();

const tables = new OrderTables(orderStack, 'OrderTables', { config });
const functions = new OrderFunctions(orderStack, 'OrderFunctions', { tables, config });
const api = new OrderApi(orderStack, 'OrderApi', { handlers: functions });

/**
 * 計測対象 API のベース URL を `query-impact-measure` へ渡す（design 論点 3）。
 *
 * API の後でしか呼べない（API が関数を統合先として参照するため、
 * 関数の方が先に作られる）。`api.url` を直接渡すと循環参照になるので、
 * URL の組み立ては `OrderApi.urlForLambdaEnvironment` に閉じている。
 */
functions.wireApiBaseUrl(api);

/**
 * 非同期パスの配線（design §5.6）。
 *
 * 注文テーブルの Streams と `order-processor` を直結する。
 * この 1 行が `direct` 構成そのものであり、Phase 2 で SQS ファンアウトへ
 * 差し替えるときに置き換わる箇所でもある（design §9）。
 *
 * API（同期パス）との依存は無い。`order-processor` は API Gateway から
 * 呼ばれず、Streams からしか起動しない（design §5.8 に対応するルートが無い）。
 *
 * 戻り値を受け取るのは DLQ を監視側に渡すためである（要件 13.6）。
 */
const stream = new OrderStream(orderStack, 'OrderStream', {
  tables,
  processor: functions.orderProcessor,
  config,
});

/**
 * 観測装置の配線（design §6.1 / §6.2）。
 *
 * ダッシュボードとアラームを分けているのは、前者が「読むための道具」、
 * 後者が「起こすための道具」だからである（各 Construct の冒頭を参照）。
 * 閾値の値は `order-monitoring.ts` から共有しているため、
 * グラフの注釈線とアラームの閾値がずれることはない。
 */
new OrderMonitoring(orderStack, 'OrderMonitoring', {
  functions,
  tables,
  api: api.api,
  deadLetterQueue: stream.deadLetterQueue,
});

const alarms = new OrderAlarms(orderStack, 'OrderAlarms', {
  functions,
  tables,
  deadLetterQueue: stream.deadLetterQueue,
});

/**
 * フロントエンドと検証者が読む出力。
 *
 * - `orderApiUrl`: API のベース URL（要件 14.10）。
 *   `ampx sandbox` の出力（`amplify_outputs.json` の `custom.orderApiUrl`）に載る。
 *   `next dev` から叩く場合は同じ値を `.env.local` の
 *   `NEXT_PUBLIC_ORDER_API_URL` に写す（design §11.3）
 * - `alarmTopicArn`: アラームの通知先（design §6.2）。
 *   サブスクリプションは作らないので、**検証者がこの ARN を購読しない限り
 *   アラームは誰にも届かない**（`IteratorAge` の危険域を含む。要件 20.3）
 */
backend.addOutput({
  custom: {
    orderApiUrl: api.url,
    alarmTopicArn: alarms.topicArn,
  },
});
