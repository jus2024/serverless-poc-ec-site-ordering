# Implementation Plan

実装は「同期パスを先に完成させて動く状態を作り、次に非同期パスを繋ぎ、
最後に計測装置を載せる」順で進める。

design §13 の未確定事項のうち、設計の前提を崩し得るもの
（実処理時間 D、負荷生成の到達レート、シャード数）は、
装置が動いた直後（タスク 13〜14）で早めに確認する。

既に書きかけの `amplify/functions/shared/`（`types.ts` / `order-status.ts` / `catalog.ts`）は
Spec 確定前に書いたものであり、タスク 3 と 7 で design に整合させる。

---

- [x] 1. 依存関係とテスト基盤の準備
  - `package.json` に Lambda 用の依存を追加する（`devDependencies`。esbuild がバンドルするため）
    - `@aws-lambda-powertools/idempotency`、`@aws-lambda-powertools/logger`、`@aws-lambda-powertools/metrics`、`@aws-lambda-powertools/tracer`
    - `@aws-sdk/client-dynamodb`、`@aws-sdk/lib-dynamodb`、`@aws-sdk/client-dynamodb-streams`、`@aws-sdk/client-lambda`
    - `ulid`、`@types/aws-lambda`
  - Vitest を導入する（純粋関数の単体テストに限定した最小構成）
    - `vitest` を追加し、`vitest.config.ts` で `amplify/functions/shared/` と `src/lib/orders/` を対象にする
    - `package.json` に `"test": "vitest --run"` を追加する
  - `.env.example` に `NEXT_PUBLIC_ORDER_API_URL` と検証パラメータのプレースホルダを追記する
  - _Requirements: 18.1, 18.2, 18.5, 14.10_

- [x] 2. 検証パラメータの解決と検証（`verification-config.ts`）
  - `amplify/custom/verification-config.ts` を作成し、design §10.1 の全環境変数を読み取る
  - 各値を design §10.1 の「範囲」列に従って検証し、範囲外なら例外を投げて合成を止める
  - `ORDER_WARM_THROUGHPUT_*` が設定されている場合、**引き下げ不可である**ことを合成時に警告出力する
  - 解決済みの設定値と、消費能力の見積もり計算に必要な値を型付きで公開する
  - 単体テスト: 範囲外の値で例外を投げること、既定値が正しく解決されること
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.8_

- [x] 3. 共有型と商品マスタの整合（純粋関数）
- [x] 3.1 `shared/types.ts` を design に整合させる
  - 書きかけの版から `status_rank` を削除する（直列実行では不要。design §5.4）
  - `expires_at`、`pipeline_mode`、`load_test_id` を注文レコードに含める
  - 実行レコードの型を design §4.3 の属性表どおりに定義する（シャード数、実測レート、消費能力を含む）
  - _Requirements: 8.1, 8.2, 19.3, 19.4, 11.11_

- [x] 3.2 `shared/catalog.ts` を確認し単体テストを書く
  - SKU 形式が `ITEM#{産地略}-{品種略}-{グレード}-{焙煎度}-{容量}` であること
  - EC 向け商品のみを含み、業務用 5kg を含まないこと
  - `calculateTotal` が明細の `qty × price` の総和を返すこと
  - `calculatePoints` が `floor(total × 0.01)` を返すこと
  - `randomOrderItems` の明細数と数量が想定範囲に収まること
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 1.9, 7.2_

- [x] 3.3 `shared/load-curve.ts` を実装し単体テストを書く
  - 漸増 30% / ピーク 40% / 漸減 30% の係数を返す（design 論点 2）
  - 定常負荷モード（係数は常に 1）を持つ
  - 境界（開始時、終了時、区間の境目）で期待値どおりであること
  - _Requirements: 11.2, 11.3_

- [x] 3.4 `shared/percentiles.ts` を実装し単体テストを書く
  - p50 / p95 / p99 / 最大を算出する
  - 要素数が 0 件・1 件・少数の場合の境界を定義しテストする
  - _Requirements: 12.3_

- [x] 4. DynamoDB テーブル Construct（`order-tables.ts`）
  - 注文テーブルを `TableV2` で定義する（`warmThroughput` を設定するため）
    - PK `order_id` / SK `customer_id`、オンデマンド、`NEW_AND_OLD_IMAGES`、TTL `expires_at`
    - GSI `customer-orders-index`（PK `customer_id` / SK `created_at`、射影 ALL）
    - `verification-config` の warm throughput 設定を反映する
  - 引当在庫テーブル（PK `itemId` / SK `warehouseId`）
  - 冪等性テーブル（PK `id`、TTL `expiration`）
  - 実行管理テーブル（PK `execution_id`、TTL `expires_at`）
  - 全テーブル `RemovalPolicy.DESTROY`
  - _Requirements: 17.2, 17.3, 17.5, 10.3, 2.3, 16.6, 17.6_

- [x] 5. Lambda 共通モジュール
  - `shared/runtime-config.ts`: Lambda 側での環境変数の読み取りと既定値
  - `shared/ddb.ts`: DynamoDB Document クライアントの生成
  - `shared/http.ts`: CORS ヘッダー付きレスポンス生成と、design §E-1 のエラー整形
  - `shared/idempotency.ts`: Powertools 冪等性の共通設定。冪等キーは `{stage}#{order_id}`
  - `shared/metrics.ts`: EMF によるカスタムメトリクス出力（`OrdersProcessed`、`StageDurationMs`）
  - _Requirements: 16.4, 16.5, 16.6_

- [x] 6. 注文受付 Lambda（`order-accept`）
  - `POST /orders` を処理する
  - 注文 ID を `ORD#{ULID}` 形式で生成する
  - 商品リスト未指定時は商品マスタからランダム生成、顧客 ID 未指定時はテスト顧客を割り当てる
  - 商品マスタに無い SKU が含まれる場合は 400 を返し注文を作成しない
  - `order_status = PENDING`、`stages_done = 0`、`pipeline_mode = direct`、`expires_at` を設定する
  - 自身の処理時間を応答に含める
  - X-Ray セグメントに `order_id` をアノテーションとして付与する
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 13.4_

- [x] 7. 段階完了の記録（`shared/order-status.ts` の書き直し）
  - 書きかけの単調増加ランク機構を削除する（直列実行では不要。design §9 の拡張点として記録済み）
  - design §5.4 の `UpdateItem` を実装する
    - 段階属性・完了時刻・`updated_at`・`order_status`・`stages_done` の加算を 1 回で更新
    - `ConditionExpression: attribute_not_exists(#stageStatus)` で二重加算を防ぐ
    - 条件失敗時は処理済みとみなし冪等に成功として扱う
  - 最終段階（`point`）の条件式に他 3 段階の完了を含める（`COMPLETED` の条件）
  - 段階進捗と経過時間の算出（照会 API 用）
  - 単体テスト: 更新式と条件式の組み立て、段階進捗の算出
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 2.5, 2.6_

- [x] 8. 注文照会 Lambda（`order-query`）
  - `GET /orders/{orderId}`: PK 条件のみの `Query` で 1 件取得（design §4.2）
  - `GET /orders?customerId=`: GSI で顧客別一覧を新しい順に返す
  - `GET /config`: デプロイ済みの検証パラメータと消費能力の見積もりを返す
  - `GET /catalog`: 商品マスタの一覧を返す（フロントエンドが同じ出典を参照するため）
  - 段階ごとの進捗・経過時間・全段階完了までの経過時間を含める
  - 存在しない注文 ID は 404 を返す
  - 読み取り権限のみを持つこと（IAM）
  - _Requirements: 2.1, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.5, 10.6, 14.7_

- [x] 9. 初期在庫投入 Lambda（`inventory-seed`）
  - `POST /inventory/seed` を処理する
  - 商品マスタ全 SKU × 単一倉庫 `WH-TOKYO` の在庫レコードを投入する
  - `initialQuantity` を指定可能にする（既定 10,000,000。在庫不足の検証用に小さい値も指定可）
  - `BatchWriteItem` で投入し、投入件数を応答に含める
  - _Requirements: 5.7, 5.9, 5.3_

- [x] 10. API Gateway とバックエンド配線（同期パスのみ）
  - `amplify/custom/order-api.ts` を作成し、design §5.8 のうち同期パスのルートを定義する
    - `POST /orders`、`GET /orders/{orderId}`、`GET /orders`、`GET /config`、`POST /inventory/seed`
    - CORS 全オリジン許可、X-Ray トレーシング有効
  - `amplify/custom/order-functions.ts` に Lambda 定義と IAM 権限（design §5.9）
  - `amplify/backend.ts` で `createStack` し、テーブル・関数・API を配線する
  - `backend.addOutput({ custom: { orderApiUrl } })` で API URL を出力する
  - _Requirements: 18.3, 18.4, 14.10_

- [x] 11. 後続処理 Lambda（`order-processor`）
  - Streams レコードの `NewImage` から注文情報を取り出す（テーブルを読み直さない）
  - X-Ray セグメントに `order_id` をアノテーションとして付与する
  - 4 段階を直列実行する
    - 決済: 擬似待機。失敗率の設定に従って意図的に失敗させられる。失敗時は `PAYMENT_FAILED` で打ち切り
    - 引当: `TransactWriteItems` で全明細を 1 トランザクション。`CancellationReasons` を design §E-3 に従って解釈
    - 通知: 擬似待機 + 構造化ログ（注文番号・商品名・合計金額・到着予定）。商品名は商品マスタから解決
    - ポイント: `point_earned` を記録し `COMPLETED` へ
  - 各段階を `makeIdempotent` でラップする（冪等キーは段階ごと）
  - 業務的な失敗は再試行せず、技術的な失敗のみ `batchItemFailures` に積む
  - EMF で処理件数と段階ごとの所要時間を出力する
  - _Requirements: 4.1-4.8, 5.1-5.6, 5.8, 6.1-6.7, 7.1-7.5, 8.6, 9.2, 9.8, 16.1, 16.3, 16.7, 13.4_

- [x] 12. Streams イベントソースマッピング（`order-stream.ts`）
  - design §5.6 の設定でイベントソースマッピングを定義する
    - `startingPosition: LATEST`、`batchSize`（既定 1、可変）、`parallelizationFactor`（既定 1、可変）
    - **イベントフィルタ `eventName = INSERT`**（無限ループ防止）
    - `reportBatchItemFailures: true`、`retryAttempts: 3`、`bisectBatchOnError: true`
    - `maxRecordAge` は既定 -1（滞留の自然な成長を観測するため）
  - SQS DLQ を作成し `onFailure` に指定する
  - `backend.ts` に配線する
  - _Requirements: 9.1, 9.3, 9.7, 9.8, 9.9, 16.2_

- [x] 13. 最小の end-to-end 動作確認（デプロイを伴う。要確認）
  - `npx ampx sandbox` でデプロイする
  - 出力された API URL を `.env.local` に設定する
  - `POST /inventory/seed` で初期在庫を投入する
  - 注文 1 件を投入し、`COMPLETED` まで到達することを確認する
  - 全段階が 10 秒以内に完了することを確認する
  - **イベントフィルタが効いていること**（無限ループが起きていないこと）を `Invocations` で確認する
  - _Requirements: 15.1, 9.7, 18.3_

- [x] 14. 実処理時間 D の実測と design の更新
  - EMF の `StageDurationMs` から段階ごとの実処理時間を取得する
  - 擬似待機以外のオーバーヘッド（SDK 呼び出し、冪等性チェック、DynamoDB 更新 4 回）を把握する
  - 実測した D で design §2.2 の壁の候補表と §10.2 のシナリオ設定を更新する
  - _Requirements: 20.8_

- [x] 15. 負荷生成 Lambda（`load-generator`）
- [x] 15.1 シャード数の取得
  - `DescribeStream` でオープンシャード（終端シーケンス番号を持たないもの）を数える
  - `LastEvaluatedShardId` を追って全ページを取得する（軸 B では複数ページになる）
  - `DescribeTable` で warm throughput の現在値も取得する
  - 取得失敗時は負荷生成を継続し、理由を `shard_count_error` に記録する
  - _Requirements: 19.1, 19.2, 19.5, 19.6_

- [x] 15.2 負荷生成ワーカー
  - `POST /load-test/start` は実行 ID を即座に返し、投入は非同期に継続する
  - 注文は `BatchWriteItem` で注文テーブルへ直接書き込む（`order-accept` を経由しない）
  - 投入レートは負荷カーブまたは定常負荷に従う
  - 残り実行時間が閾値を切ったら自身を非同期 invoke して継続する
  - 実行レコードに design §4.3 の全属性を記録する
    - シャード数、PF、擬似処理時間、算出した消費能力
    - 投入件数、実測投入レート、目標との乖離警告
  - パラメータの上限（投入レート、継続時間）を検証し、超過時は 400 を返す
  - invoke 失敗・例外時は実行レコードを `FAILED` にする
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.9, 11.10, 11.11, 19.3, 19.4_

- [x] 16. 実行状態照会 Lambda（`execution-status`）
  - `GET /executions/{executionId}` で実行レコードを返す
  - 負荷生成と並行計測の双方に対応する（`execution_type` で判別）
  - _Requirements: 11.6, 12.5_

- [x] 17. 負荷生成の到達レートの確認（デプロイを伴う。要確認）
  - 単一 Lambda で達成できる最大投入レートを実測する
  - 16,000 件/分に届かない場合はワーカーを複数に分ける設計へ変更する
  - **軸 B の前提であるため、軸 A の実行前に確認する**
  - _Requirements: 11.7_

- [x] 18. 並行計測 Lambda（`query-impact-measure`）
  - `POST /measure/start` は実行 ID を即座に返し、計測は非同期に継続する
  - API Gateway 経由で `order-query` を指定並行数で連続呼び出しする
  - HTTP エージェントの接続数上限を明示的に引き上げる
  - レイテンシを全件記録し p50 / p95 / p99 / 最大を算出する
  - エラーを分類し、`429` と `TooManyRequestsException` をスロットルとして区別する
  - 実行条件（投入レート、擬似処理時間、PF、シャード数、並行数）とともに実行レコードに記録する
  - パラメータの上限（並行数、継続時間）を検証する
  - _Requirements: 9.4, 11.8, 12.1, 12.2, 12.3, 12.4, 12.5, 12.7_

- [x] 19. CloudWatch 監視（`order-monitoring.ts`）
- [x] 19.1 ダッシュボード
  - design §6.1 の全ウィジェットを定義する
  - **照会系と後続処理系のスロットルを別ウィジェットに分ける**
  - 「壁にならない要素」（DynamoDB スロットル、API Gateway エラー、アカウント全体の同時実行数）も配置する
  - EMF のカスタムメトリクス（処理件数、段階所要時間）を表示する
  - _Requirements: 9.5, 13.1, 13.5, 13.6, 13.7, 13.8, 20.5_

- [x] 19.2 アラーム
  - design §6.2 の全アラームを定義する
  - **`IteratorAge` > 12 時間の Critical アラーム**（保持期限の半分。データロス検知）
  - SNS トピックを作成しアラームのアクションに設定する（サブスクリプションは作らない）
  - トピック ARN を出力する
  - _Requirements: 13.2, 13.3, 13.6, 13.8, 20.3_

- [x] 20. API とバックエンドの配線を完成させる
  - `POST /load-test/start`、`POST /measure/start`、`GET /executions/{executionId}` を追加する
  - 全 Lambda の IAM 権限を design §5.9 のとおりに設定する
    - `load-generator` に `dynamodb:DescribeStream` と `DescribeTable` を付与する
    - 自己 invoke 権限を `load-generator` と `query-impact-measure` に付与する
  - 監視 Construct を配線する
  - _Requirements: 18.4, 19.1_

- [x] 21. フロントエンド: API クライアントと算術
- [x] 21.1 `src/lib/orders/types.ts` と `api.ts`
  - API のリクエスト/レスポンス型を定義する（Lambda 側とは独立させる）
  - `NEXT_PUBLIC_ORDER_API_URL` からベース URL を解決し、未設定時は明示的なエラーを出す
  - 全エンドポイントのクライアント関数を実装する
  - _Requirements: 14.10, 18.6_

- [x] 21.2 `src/lib/orders/capacity.ts` と単体テスト
  - design §2.4 の式を実装する
    - 消費能力 `S × P ÷ D`
    - 滞留の増加率 `投入 − 消費能力`
    - `IteratorAge` の増加速度 `1 − 消費能力 ÷ 投入`
    - 滞留件数 `IteratorAge × 投入レート`
    - データロス猶予時間 `86,400 ÷ (1 − 能力 ÷ 投入)`
    - 回復時間（停止時点の `IteratorAge` × 投入 ÷ 能力）
  - 投入が消費能力を下回る場合（滞留しない）の扱いを定義する
  - 増加速度が必ず `[0, 1)` に入ることを不変条件として単体テストに置く
  - 単体テスト: design §2.4 の数値例（投入 2,000 / 能力 667 → 猶予 36 時間。`86,400 ÷ 0.6665` = 129,632 秒）で検算する
  - **訂正の記録。** 当初の受入基準は訂正前の式（`投入 ÷ 能力 − 1`、猶予 12 時間、回復時間は
    停止時点の `IteratorAge` そのもの）を載せていた。A2 の実測で `IteratorAge = B ÷ A`
    （`B ÷ C` ではない）と判明し、design §2.4 と `capacity.ts` を訂正済み。
    出典は design §2.4 の「訂正の記録」と `docs/poc/verification-results.md` §2.4。
    上記の `[0, 1)` の不変条件が、当初の誤りを実測を待たずに検出できたはずのものである。
  - _Requirements: 20.2, 20.3, 20.4_

- [x] 22. フロントエンド: コンポーネント
- [x] 22.1 `OrderDashboard` とタブ構成
  - ヘッダーに `BrandIcon` とタイトルを配置する（参照リポジトリのパターンを踏襲）
  - タブ: 注文 / 負荷テスト / 計測結果 / 設定
  - 引き継いだカラートークンとコンポーネントトークンを使う
  - _Requirements: 14.8, 14.9_

- [x] 22.2 `OrderSubmitPanel` と `OrderStatusPanel`
  - 注文の手動投入（`GET /catalog` で取得した商品マスタから SKU を選ぶ）、初期在庫の投入
  - 注文照会と段階ごとの進捗・経過時間の表示
  - _Requirements: 3.5, 14.1, 14.2, 14.4_

- [x] 22.3 `LoadTestPanel` と `QueryImpactPanel`
  - 負荷生成と並行計測の開始、実行状態のポーリング表示
  - _Requirements: 14.3, 14.5_

- [x] 22.4 `MeasurementComparison` と `ConfigPanel`
  - design §11.2 の列を持つ比較表を表示する
  - **実測投入レートが目標から乖離している行に警告を表示する**
  - `localStorage` に結果を永続化する（容量超過時は軽量版で再試行）
  - 有効な検証パラメータと実測シャード数・算出した消費能力を表示する
  - _Requirements: 14.6, 14.7, 11.11_

- [x] 22.5 トップページの差し替え
  - `src/app/page.tsx` を `OrderDashboard` に差し替える
  - サンプルページへのナビゲーションを外す（`src/app/sample/` 自体は残す）
  - _Requirements: 14.9_

- [x] 23. 全体の検証（コストなし）
  - `npx tsc --noEmit` を通す
  - `npm run lint` を通す
  - `npm test` で全単体テストを通す
  - _Requirements: 18.5_

- [x] 24. 軸 A のシナリオ実行（デプロイとコストを伴う。要確認）
  - シナリオ A0〜A8 を design §10.2 の設定で実行する
  - PF と擬似処理時間を変えるシナリオでは環境変数を変更して再デプロイする
  - 各実行で記録する: シャード数、実測投入レート、`IteratorAge` の推移、処理レート、同時実行数、スロットル
  - 検証する項目
    - 消費能力の式が実測と一致するか（乖離があれば要因を記録）
    - 壁の位置を絶対レートで特定する
    - Streams の発行・DynamoDB・API Gateway・Lambda 同時実行枠が**壁にならない**こと
    - 滞留の増加率、データロス猶予時間、回復時間
    - A8 で同期パスへの波及が**発生しない**こと（成功応答が 500ms 以内に収まり続けること）
  - 想定コスト: 約 $2.7
  - _Requirements: 2.2, 9.4, 11.8, 12.6, 15.1, 15.2, 15.3, 20.1, 20.2, 20.3, 20.4, 20.5, 20.8_

- [x] 25. 軸 B の事前確認（承認が必要）
  - AWS Pricing で warm throughput 引き上げの課金体系を確認する
  - 目標値（40,000 / 100,000 write units/s）での想定コストを算出する
  - 残予算に収まることを確認する
  - **warm throughput は引き上げ後に下げられない**ことを踏まえ、検証者の明示的な承認を得る
  - _Requirements: 17.8, 17.7_

- [x] 26. 軸 B のシナリオ実行（コストを伴う。承認後）
  - B0 でウォーム前のシャード数を記録する
  - warm throughput を引き上げ、B1 で**シャード数が増えるかの仮説を検証する**
  - 仮説が否定された場合は design §2.5 のフォールバック（プロビジョンドで高 WCU → オンデマンドに戻す）を手動で実行する
  - B2〜B4 を実行し、壁が `S × P` から Lambda 同時実行枠へ移るかを確認する
  - B4 で同期パスへの波及が**発生する**ことを確認し、A8 と対比する
  - Lambda の同時実行スケーリングレートが壁になるかを観測する
  - 実行後に Cost Explorer で実際の課金額を確認し記録する
  - 想定コスト: 約 $18.3 + ウォーム課金
  - **実行結果の記録。** 上記の受入基準は計画時のまま残す。実際に承認されたスコープは
    **B0 / B1 / B2 のみ**（`ORDER_WARM_THROUGHPUT_WRITE = 40,000`、一時課金 $23.40）で、
    基準の文面が示すより狭い。**達成: B0（S = 4）、B1（warm write 40,000 で S = 4 → 64。
    導出下限 40 の 1.60 倍。design §13 #3 は閉じた）、B2（比 0.226 で滞留ゼロ、全 29,934 件 `COMPLETED`。
    A5 の同一投入での滞留 42,814 件・回復約 76 分 が 0 件・約 1.7 秒 になり、壁が約 15.6 倍動いた）。**
    要件 20.6 と成功基準 5 の前半はこれで満たす。
  - **未実施と非該当の記録。** **B3 / B4 は実行不可**（warm write 100,000 が us-west-2 の 3 つの
    クォータ — テーブル 40,000 / アカウント 80,000 / Streams 40,000 — を超える。
    **検証者の判断でクォータ引き上げ申請を行わない**方針であり、同じクォータが design §2.5 の
    フォールバックも塞ぐため代替経路がない）。よって **要件 20.7 と成功基準 6 の「波及が発生する」側、
    および同時実行スケーリングレートの観測は未実測**（`S × P` = 640 + 照会 81 = 721 / 1,000 = 72.1% で
    未予約プールに届かない）。結果自体は design §2.6 の式で**導出済み・実測未実施**であり、
    実測のみが与えられたのは同時実行の壁での実挙動（スロットルの形、レートの立ち上がり、自然発生の波及）である。
    **フォールバックの基準は条件付きであり発動せず**（仮説が成立したため不要。全区間 `PAY_PER_REQUEST` で要件 17.3 からの逸脱なし）。
    **B2 は比 0.226 で飽和させていないため S = 64 の能力は未計測**（A3 / A6 と同じ制約）で、design §13 #9 は開いたまま。
    A5 の方法（滞留を作り投入停止、到着なしの排出レートを測る）で安価に閉じられる。
    **Cost Explorer の実績額は反映待ち（24〜48 時間）で未記録**（`docs/poc/verification-results.md` §5 と成功基準 8 の実績欄）。
    全記録は `docs/poc/verification-results.md` §3 と `design.md` §13。
  - _Requirements: 20.6, 20.7, 10.3, 17.4, 17.8_

- [x] 27. ドキュメント
  - README に PoC の概要、セットアップ手順、シナリオの実行方法を追記する
  - `docs/poc/` に検証手順書を作成する
    - シナリオ別の環境変数設定と実行手順（再デプロイが必要な設定と不要な設定の区別を含む）
    - シャード数の確認方法（自動記録される旨と、手動確認のコマンド）
    - warm throughput 引き上げの事前確認手順（下げられない旨の警告を含む）
    - **この構成を公開環境に置いてはならないこと**（API に認証がない）
    - 検証終了後のリソース削除手順
  - `docs/poc/` に実測結果と、出典の要件定義から変更した点（シナリオ D / E の差し替え理由）を記録する
  - _Requirements: 9.6, 10.7, 17.1, 20.5_
