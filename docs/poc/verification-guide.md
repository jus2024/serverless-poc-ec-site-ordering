# 検証手順書 — EC 注文処理パイプライン PoC（Streams 直結構成）

`.kiro/specs/order-pipeline-poc/` の requirements / design に基づく実行手順。
**この構成をデプロイする前に、まず次の警告を読むこと。**

---

## ⚠️ 公開環境に置いてはならない

**この PoC の API Gateway には認証が一切掛かっていない。**
要件のスコープ外定義（認証・認可を扱わない）に従った結果であり、意図的な状態である
（design §8）。

| リスク | 内容 |
|-------|------|
| 第三者による注文投入 | URL を知れば誰でも `POST /orders` を叩ける |
| 第三者による負荷生成の起動 | `POST /load-test/start` も無認証。Lambda 同時実行枠と DynamoDB 書き込みを消費させられる |
| コストの発生 | 予算枠を $100 に緩和したため、悪用時の潜在的な損害も大きい |

**守るべき運用:**

- 検証者自身の sandbox 環境（`npx ampx sandbox`）でのみ動かす
- API URL を共有しない。スクリーンショットや記事に貼る際はホスト名を伏せる
- **Amplify Hosting や共有ブランチにデプロイしない**（`amplify/backend.ts` が
  `OrderPipelinePoc` を配線しているため、Amplify Hosting に接続したブランチへ
  マージすると、このスタックがそのブランチのバックエンドとして作られる。
  マージする場合は事前に配線を外すか、検証専用のアカウントを使う）
- 検証していない期間はスタックを削除しておく（[お片付け](#お片付けリソース削除)）

緩和策としてコード側に入っているのはパラメータ上限のみである
（投入レート・継続時間・並行数。`ORDER_MAX_*`）。API キー、IAM 認証、WAF は含まない。

---

## 前提

| 項目 | 内容 |
|------|------|
| AWS アカウント | 検証者自身のアカウント。`aws configure` 済み |
| Lambda 同時実行枠 | 既定 1,000。**引き上げ申請はしない**（枠が壁になるかを見るため） |
| Node.js | 22.x / npm |
| 予算 | 全体で $100 以内（要件 17.4）。軸 A 約 $2.7 + 軸 B 約 $18.3 + ウォーム課金 |
| リージョン | 1 リージョンで完結。sandbox の既定リージョンをそのまま使う |

---

## リソースの物理名は出力から取る

**design §4.1 / §5.2 / §6.1 のテーブル名・関数名・キュー名・ダッシュボード名を
そのまま探しても見つからない。** 実装では、同一アカウントに複数の sandbox や
ブランチが並んだときに物理名が衝突しないよう、
末尾に**スタック名から算出した 8 文字のサフィックス**を付けている。

```
design §4.1     : kiro-roasters-orders
実際にできる名前 : kiro-roasters-orders-1a2b3c4d
```

サフィックスは同じスタックを再デプロイする限り変わらない（テーブルの作り直しは起きない）が、
sandbox / ブランチが違えば別の値になる。したがって**手順書に物理名を書かない**。
名前が必要になったら次のいずれかから取る。

| 知りたいもの | 取得元 |
|------------|-------|
| API のベース URL | `amplify_outputs.json` の `custom.orderApiUrl` |
| アラーム通知先の SNS トピック ARN | `amplify_outputs.json` の `custom.alarmTopicArn` |
| 有効な検証パラメータ・消費能力の見積もり | `GET /config` |
| 注文テーブル名 / 関数名 / DLQ 名 / ダッシュボード名 | CloudFormation の `OrderPipelinePoc` ネストスタックのリソース一覧、または AWS コンソール（接頭辞 `kiro-roasters-` / `kiro-` で絞り込む） |

シャード数を手で確認する場合だけテーブル名が必要になる（[シャード数の確認](#シャード数の確認)）。

---

## セットアップ

```bash
npm ci
```

### 1. デプロイ

```bash
npx ampx sandbox
```

初回は数分かかる。範囲外の検証パラメータが `.env` に入っていると
**合成時に例外になりデプロイが始まらない**（要件 10.5）。エラーメッセージに
変数名と許容範囲が出るので、それに従って直す。

`ORDER_WARM_THROUGHPUT_*` を設定している場合は、合成時に
「引き下げ不可」の警告が 1 度だけ出力される（要件 10.8）。

### 2. API URL をフロントエンドに渡す

`ampx sandbox` の出力（`amplify_outputs.json` の `custom.orderApiUrl`）を
`.env.local` に写す。

```bash
cp .env.example .env.local
# NEXT_PUBLIC_ORDER_API_URL=https://xxxxxxxxxx.execute-api.<region>.amazonaws.com/poc
```

末尾の `/poc` はステージ名である（CDK の既定 `prod` ではなく、
検証専用であることを示すために `poc` にしている）。`custom.orderApiUrl` の値を
そのまま写せばよい。

```bash
npm run dev
```

`http://localhost:3000` が検証操作 UI（`OrderDashboard`）になる。
タブは 注文 / 負荷テスト / 計測結果 / 設定。

以降の手順は UI からでも curl からでも実行できる。
**シナリオ実行時は UI を使うほうがよい**（実行 ID と結果が `localStorage` に
蓄積され、`計測結果` タブで横並びに比較できる。要件 14.6）。

### 3. 初期在庫を投入する

在庫がゼロだと引当が常に失敗し、検証にならない。

```bash
export API=https://xxxxxxxxxx.execute-api.<region>.amazonaws.com/poc

curl -X POST "$API/inventory/seed" -H 'Content-Type: application/json' -d '{}'
```

既定で商品マスタ全 SKU × `WH-TOKYO` に 10,000,000 個を投入する。
全シナリオを通して枯渇しない量である（design 論点 6）。
在庫不足（要件 5.3）を意図的に起こす場合は `{"initialQuantity": 1}` のように指定する。

### 4. 有効な設定を確認する

```bash
curl -s "$API/config" | jq
```

**出典は `.env.local` ではなくデプロイ済みの Lambda 環境変数である。**
計測条件の取り違えを防ぐため、シナリオ実行の直前に必ずこれを見る。
`capacity.estimatedCapacityPerMinute` に `S × P ÷ D` の見積もりが入る
（S は暫定値。`shardCountSource` で出典が分かる）。

warm throughput はこのレスポンスに含まれない（テーブル側の設定であり
Lambda の環境変数に無い）。実行レコード側に記録される。

### 5. アラームを購読する（任意だが推奨）

SNS トピックはスタックが作るが、**サブスクリプションは作らない**
（メールアドレスをリポジトリに含めないため）。
購読しない限り `IteratorAge` の危険域アラームは誰にも届かない。

```bash
aws sns subscribe \
  --topic-arn <custom.alarmTopicArn> \
  --protocol email \
  --notification-endpoint you@example.com
```

---

## 設定の変え方: 再デプロイが必要なものと不要なもの

**ここを取り違えると「変えたつもりで変わっていない条件」で計測することになる。**

### 再デプロイが必要（環境変数。design §10.1）

消費能力の式の変数（P、D）とテーブルの成熟度（warm throughput）は
すべて合成時に決まるため、`.env` を書き換えて `npx ampx sandbox` を再実行する。

| 変数 | 既定 | 範囲 | 何を動かすか |
|------|------|------|------------|
| `ORDER_STREAM_BATCH_SIZE` | 1 | 1〜10,000 | 1 呼び出しの長さ。**スループットは変えない**（design §2.1） |
| `ORDER_STREAM_PARALLELIZATION_FACTOR` | 1 | 1〜10 | 消費能力の変数 **P** |
| `ORDER_STREAM_MAX_RECORD_AGE_SECONDS` | -1 | -1 または 60〜604,800 | 滞留の打ち切り。**-1 のまま使う**（有限にすると要件 20.3 の観測ができない） |
| `ORDER_PAYMENT_DELAY_MS` | 3000 | 0〜60,000 | 消費能力の変数 **D** の主成分 |
| `ORDER_NOTIFICATION_DELAY_MS` | 500 | 0〜60,000 | **D** の副成分 |
| `ORDER_PAYMENT_FAILURE_RATE` | 0 | 0〜1 | 決済の擬似失敗率（DLQ の動作確認用） |
| `ORDER_WARM_THROUGHPUT_WRITE` | 未設定 | 4,000〜1,000,000 | テーブルの成熟度 → **S**（軸 B）。⚠️ 下げられない |
| `ORDER_WARM_THROUGHPUT_READ` | 未設定 | 4,000〜1,000,000 | 同上。⚠️ 下げられない |
| `ORDER_DATA_TTL_DAYS` | 7 | 1〜30 | 検証データの後始末 |
| `ORDER_MAX_ORDERS_PER_MINUTE` | 20000 | 1〜100,000 | 投入レートの上限（ガードレール） |
| `ORDER_MAX_DURATION_SECONDS` | 3600 | 1〜7,200 | 継続時間の上限（ガードレール） |
| `ORDER_MAX_MEASURE_CONCURRENCY` | 200 | 1〜1,000 | 並行数の上限（ガードレール） |

再デプロイ後は `GET /config` で反映を確認する。
`ORDER_WARM_THROUGHPUT_*` の反映は `DescribeTable` で確認する
（`GET /config` には出ない）。

### 再デプロイが不要（API のリクエストパラメータ）

| 項目 | 渡し方 |
|------|-------|
| 投入レート | `POST /load-test/start` の `ordersPerMinute` |
| 投入の継続時間 | 同 `durationSeconds` |
| 負荷カーブの有無 | 同 `useRampCurve`（既定 false = 定常負荷） |
| 並行計測の並行数 | `POST /measure/start` の `concurrency` |
| 並行計測の継続時間 | 同 `durationSeconds`（上限は 840 秒。1 回の invoke で測り切る制約） |
| 並行計測の対象 | 同 `orderId` または `customerId` |
| 並行計測と負荷生成の紐づけ | 同 `loadTestId` |
| 初期在庫量 | `POST /inventory/seed` の `initialQuantity` |

**シナリオ表の PF 列と決済遅延列が前のシナリオと同じなら再デプロイは不要**、
という読み方をする。軸 A では A2 → A3（PF 1 → 10）と
A5 → A6（決済遅延 3000 → 100ms）の 2 箇所だけ再デプロイが挟まる。

---

## シナリオの実行

### 共通の流れ

1. 必要なら `.env` を変えて `npx ampx sandbox` を再実行する
2. `GET /config` で条件を確認する
3. `POST /load-test/start` を叩き、**実行 ID を記録する**
4. CloudWatch ダッシュボードでグラフを見る（`IteratorAge`、`Invocations`、
   `ConcurrentExecutions`、`Throttles`（照会系 / 後続処理系は別ウィジェット））
5. `GET /executions/{executionId}` で結果を取る
6. `docs/poc/verification-results.md` の該当行に記録する

```bash
# 負荷生成の開始（202 が返り、投入は非同期に継続する）
curl -X POST "$API/load-test/start" -H 'Content-Type: application/json' \
  -d '{"ordersPerMinute": 200, "durationSeconds": 900, "useRampCurve": false}'

# 実行状態・結果の照会
curl -s "$API/executions/<executionId>" | jq
```

**全シナリオで定常負荷（`useRampCurve: false`）を使う。**
負荷カーブは投入レートが時間変化して消費能力との交点が動くため、
壁の位置の測定には適さない（design 論点 2）。
カーブは別途 1 回、業務シナリオの再現として実行する（要件 11.2 の充足確認）。

### 実行レコードに自動で入るもの

手でメモする必要はない（要件 19.6 / Property 10）。

- オープンシャード数 S（取得失敗時は `shard_count_error`）
- PF、擬似処理時間、warm throughput の現在値
- `S × P ÷ D` から算出した消費能力
- 投入件数、**実測投入レート**、目標との乖離警告

**`rate_deviation_warning` が立っている実行の結果は §2.4 の算術に使わない**
（Property 11）。実測レートが目標から外れていると、滞留増加率・
データロス猶予時間・回復時間のすべてが狂う。
UI の `計測結果` タブは該当行に警告を表示する。

### 軸 A: 既定のオンデマンドテーブル

想定コスト合計 約 $2.7。`warm write` はすべて未設定。

| ID | PF | 決済遅延 | 投入 | 継続 | 並行計測 | 再デプロイ | 狙い |
|----|----|---------|------|------|---------|-----------|------|
| A0 | 1 | 3000ms | 2/分 | 10 分 | なし | 初回 | 基準。S の実測、要件 15.1（10 秒以内）の確認 |
| A1 | 1 | 3000ms | 60/分 | 10 分 | なし | 不要 | 壁の直前。まだ耐えることを確認 |
| A2 | 1 | 3000ms | 200/分 | 15 分 | なし | 不要 | **1 つ目の壁を超える。** 滞留の増加率 |
| A3 | 10 | 3000ms | 200/分 | 15 分 | なし | **必要**（PF） | PF を上げれば解消するか |
| A4 | 10 | 3000ms | 1,000/分 | 15 分 | なし | 不要 | **2 つ目の壁。** PF は上限 10 |
| A5 | 10 | 3000ms | 2,000/分 | 30 分 | なし | 不要 | データロス猶予時間の算出 |
| A6 | 10 | **100ms** | 1,000/分 | 15 分 | なし | **必要**（D） | D だけを動かして式を検証 |
| A7 | 10 | 3000ms | A4 停止後 | — | なし | **必要**（D を戻す） | **回復時間の実測** |
| A8 | 10 | 3000ms | 1,000/分 | 15 分 | 60 並行 × 2 分 | 不要 | 同期パスへの波及（**発生しない見込み。ゼロの実証**） |

A7 は投入を止めてから `IteratorAge` が 0 に戻るまでを見る。
**停止時点の `IteratorAge` がそのまま回復時間になる**という関係
（design §2.4）をグラフで確認する。

A8 は負荷生成を先に開始し、ピーク中に並行計測をぶつける。

```bash
LOAD_ID=$(curl -s -X POST "$API/load-test/start" -H 'Content-Type: application/json' \
  -d '{"ordersPerMinute": 1000, "durationSeconds": 900}' | jq -r .executionId)

# 数分待って処理が定常になってから
curl -X POST "$API/measure/start" -H 'Content-Type: application/json' \
  -d "{\"concurrency\": 60, \"durationSeconds\": 120, \"loadTestId\": \"$LOAD_ID\"}"
```

**波及は「遅くなる」ではなく「エラーになる」**（design §2.7）。
成功応答のレイテンシは 500ms 以内のまま、一部が 429 になる形で現れる。
`latency_percentiles` だけを見て「波及なし」と判定しない。
`throttle_count` を見る。

### 軸 B: 事前ウォームでシャードを増やしたテーブル

**軸 B に進む前に [warm throughput の事前確認](#warm-throughput-引き上げの事前確認必須)を
完了させ、承認を得ること。** 想定コスト 約 $18.3 + ウォーム課金。

| ID | warm write | PF | 投入 | 継続 | 並行計測 | 狙い |
|----|-----------|----|------|------|---------|------|
| B0 | 未設定 | 10 | — | — | なし | ウォーム前のシャード数を記録 |
| B1 | 40,000 | 10 | 2/分 | 5 分 | なし | **仮説検証: ウォームでシャードが増えるか** |
| B2 | 40,000 | 10 | 2,000/分 | 15 分 | なし | 軸 A で壁だったレートが通るか |
| B3 | 100,000 | 10 | 16,000/分 | 10 分 | なし | **同時実行枠に到達するか** |
| B4 | 100,000 | 10 | 16,000/分 | 10 分 | 60 並行 × 2 分 | **巻き添えが自然に発生するか。** A8 との対比 |

B0 は負荷生成を短く 1 回叩いてシャード数だけ記録する（投入は最小で足りる）。

**B1 が軸 B 全体の前提である。** ウォームスループットとシャード数の関係は
AWS ドキュメントに明記されていない。B1 でシャードが増えなければ
軸 B は成立しないため、B2 以降に進まず design §2.5 のフォールバックへ切り替える。

フォールバック（手動操作。IaC には含めない）:

```bash
# 一時的にプロビジョンドモードで高 WCU を設定してパーティション分割を誘発する
aws dynamodb update-table --table-name <注文テーブル名> \
  --billing-mode PROVISIONED \
  --provisioned-throughput ReadCapacityUnits=1000,WriteCapacityUnits=40000

# 分割が進んだらオンデマンドに戻す（パーティションはマージされない）
aws dynamodb update-table --table-name <注文テーブル名> --billing-mode PAY_PER_REQUEST
```

40,000 WCU は約 $26/時。30 分で約 $13。
**要件 17.3（オンデマンド課金）からの一時的な逸脱**として検証記録に明記する。
戻し忘れると課金が続くため、この操作をした日は必ず同日に戻す。

---

## シャード数の確認

シャード数は CloudWatch メトリクスとして提供されない。
しかし本 PoC の答え（`S × P`）が S に依存するため、S が記録されていない
実行結果は解釈できない。

### 自動記録（通常はこれで足りる）

`POST /load-test/start` を叩くと `load-generator` が `DescribeStream` を呼び、
**終端シーケンス番号を持たないシャード（= オープンシャード）**を数えて
実行レコードに記録する（要件 19.1 / 19.2）。
`LastEvaluatedShardId` を追って全ページを取得するため、シャードが多い軸 B でも
数え落ちない。

```bash
curl -s "$API/executions/<executionId>" | jq '{
  open_shard_count, shard_count_error,
  parallelization_factor, estimated_capacity_per_minute,
  warm_throughput_write
}'
```

取得に失敗しても負荷生成は継続し、理由が `shard_count_error` に入る（要件 19.5）。
**その実行の結果は消費能力の検証に使わない。**

### 手動確認（自動記録が失敗したとき、投入なしで見たいとき）

```bash
TABLE=<注文テーブル名>   # CloudFormation のリソース一覧から取る

STREAM_ARN=$(aws dynamodb describe-table --table-name "$TABLE" \
  --query 'Table.LatestStreamArn' --output text)

# オープンシャード数と次ページの有無（1 ページ = 最大 100 シャード）
aws dynamodbstreams describe-stream --stream-arn "$STREAM_ARN" \
  | jq '{
      open_shards: [.StreamDescription.Shards[]
                    | select(.SequenceNumberRange.EndingSequenceNumber == null)] | length,
      total_shards: (.StreamDescription.Shards | length),
      next_page: .StreamDescription.LastEvaluatedShardId
    }'
```

`next_page` が `null` 以外なら、軸 B のようにシャードが 100 を超えている。

次ページがある場合は `--exclusive-start-shard-id <LastEvaluatedShardId>` を付けて
繰り返し、各ページのオープンシャード数を合算する。
**合算を忘れると軸 B で S を大幅に過小評価する。**

warm throughput の現在値:

```bash
aws dynamodb describe-table --table-name "$TABLE" --query 'Table.WarmThroughput'
```

---

## warm throughput 引き上げの事前確認（必須）

### ⚠️ warm throughput は引き上げ後に下げられない

AWS の仕様である。テーブルを作り直す以外に戻す手段がない。
かつ**課金は発生するが、AWS ドキュメントは単価を明記していない**（design 論点 11）。

したがって軸 B（シナリオ B1 / B3）の実行は
**検証者の明示的な承認を必要とする操作**として扱う。

### 手順

1. AWS Pricing の DynamoDB ページで事前ウォームの課金体系を確認する
2. 目標値（書き込み 40,000 / 100,000 units/s）での想定コストを算出する
3. 軸 A の実績を差し引いた残予算に収まることを確認する
4. **検証者の明示的な承認を得る**（この 4 番を飛ばして `ORDER_WARM_THROUGHPUT_*` を
   設定しない）
5. 実行後に Cost Explorer で実際の課金額を確認し、
   `docs/poc/verification-results.md` に記録する

3 の判断に使う数字:

| 項目 | 想定 |
|------|------|
| 軸 A の実績 | 約 $2.7 |
| 軸 B のシナリオ実行分 | 約 $18.3 |
| ウォーム課金 | **不明。1 で確認する** |
| フォールバック（プロビジョンド）を採る場合 | 40,000 WCU ≒ $26/時、100,000 WCU ≒ $65/時 |
| 予算枠 | $100 |

ウォーム課金の見積もりが残予算を超える場合は、軸 B をフォールバック
（プロビジョンドで一時的に高 WCU）に切り替える。こちらは時間課金であり、
短時間で終えれば総額を抑えられる。ただし戻し忘れのリスクを負う。

---

## お片付け（リソース削除）

要件 17.1。**検証していない期間はスタックを消しておく。**
無認証 API を放置しないためでもある。

```bash
# 1. sandbox の削除（DynamoDB 4 本、Lambda 7 本、API Gateway、DLQ、
#    ダッシュボード、アラーム、SNS トピックがまとめて消える）
npx ampx sandbox delete
```

全テーブルと DLQ、SNS トピックは `RemovalPolicy.DESTROY` を明示しているため、
スタック削除で消える（要件 17.5）。データのバックアップは残らない。

削除後に手で確認・後始末するもの:

| 対象 | 確認方法 | 備考 |
|------|---------|------|
| Lambda のロググループ | CloudWatch Logs で `/aws/lambda/kiro-` を検索 | Lambda が暗黙に作るためスタック削除では消えない。放置するとわずかに保管料がかかる |
| SNS サブスクリプション | 自分で `sns subscribe` した場合 | トピックごと消えるため通常は不要 |
| プロビジョンドモードのまま残ったテーブル | `DescribeTable` の `BillingModeSummary` | フォールバックを使った場合。**戻し忘れは高額** |
| Cost Explorer | 実績の記録 | 24〜48 時間遅れて反映される |

### 検証途中の後始末

スタックを消さずにデータだけ減らす場合は TTL に任せる（既定 7 日、
`ORDER_DATA_TTL_DAYS` で変更可能）。**一括削除 API は用意していない。**
削除自体が大量の書き込みを発生させ、検証中に走らせるとメトリクスを汚すためである
（design 論点 5）。TTL の削除は課金対象外で、反映は最大 48 時間遅れる。

---

## 記録先

実測結果と判定は [verification-results.md](verification-results.md) に書く。
壁になった要素と壁にならなかった要素を**別々に**記録する枠がある（要件 20.5）。

## 関連ドキュメント

| ドキュメント | 内容 |
|-------------|------|
| `.kiro/specs/order-pipeline-poc/requirements.md` | 要件・検証シナリオ・成功基準 |
| `.kiro/specs/order-pipeline-poc/design.md` | 限界の構造（§2）、コスト（§7）、セキュリティ（§8）、パラメータ（§10） |
| [kiro-roasters-background.md](kiro-roasters-background.md) | 架空企業の業務設定・命名規則 |
| [phase2-streams-requirements.md](phase2-streams-requirements.md) | 出典の要件定義（一次入力） |
| [verification-results.md](verification-results.md) | 実測結果・出典からの変更点 |
