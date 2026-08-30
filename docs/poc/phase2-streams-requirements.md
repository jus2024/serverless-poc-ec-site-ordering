# Kiro Roasters EC 注文処理 — 検証用リポジトリ要件定義

## プロジェクト概要

Kiro Roasters（架空のスペシャルティコーヒー焙煎メーカー）の D2C EC サイトにおける注文処理基盤。
DynamoDB Streams → Lambda → SQS の段階的アーキテクチャ進化を検証するためのリポジトリ。

### 目的

- DynamoDB Streams + Lambda の同時実行限界を実測する
- SQS ファンアウトによるスケール解放と流量制御を検証する
- FIFO Queue / EventBridge Pipes / Kinesis による拡張パターンを比較する
- 上記の知見を Qiita 記事シリーズとして発信する

---

## ビジネスコンテキスト

### Kiro Roasters EC の概要

| 項目 | 内容 |
|------|------|
| 事業形態 | スペシャルティコーヒーの D2C EC + サブスクリプション |
| 通常時の注文量 | 月間約 500件（1〜2件/分） |
| 商品 | 焙煎済み豆、ドリップバッグ、ギフトセット等（約3,000 SKU） |
| 顧客層 | コーヒー好きの個人。サブスク会員は約 500人 |
| 決済 | 外部決済サービス（Stripe 想定） |
| ポイント制度 | 購入金額の 1% をポイント付与。次回購入時に利用可能 |

### 検証シナリオの背景

EC サイトが YouTuber レビュー + SNS 拡散でバズり、通常の 100〜500倍 の注文が数時間に集中する。
DynamoDB はオンデマンドモードで書き込みを捌けるが、後続処理（決済・引当・通知等）が詰まる。

---

## 機能要件

### FR-1: 注文受付

| ID | 要件 |
|----|------|
| FR-1.1 | 顧客が商品を選択し、注文を確定できる |
| FR-1.2 | 注文確定時に DynamoDB に注文レコードが書き込まれる |
| FR-1.3 | 注文レコードには注文ID、顧客ID、商品リスト、合計金額、ステータスが含まれる |
| FR-1.4 | 注文ステータスの初期値は `PENDING` |

### FR-2: 決済処理

| ID | 要件 |
|----|------|
| FR-2.1 | 注文確定後、外部決済 API を呼び出して課金を実行する |
| FR-2.2 | 決済成功時、注文ステータスを `PAID` に更新する |
| FR-2.3 | 決済失敗時、注文ステータスを `PAYMENT_FAILED` に更新し、DLQ に送る |
| FR-2.4 | 同一注文に対して決済が二重実行されないこと（冪等性） |
| FR-2.5 | 外部 API のレート制限（50 req/s 想定）を超えないよう流量制御する |

### FR-3: 在庫引当

| ID | 要件 |
|----|------|
| FR-3.1 | 決済完了後、注文商品の在庫を引当（確保）する |
| FR-3.2 | 引当成功時、注文ステータスを `ALLOCATED` に更新する |
| FR-3.3 | 在庫不足時、注文ステータスを `ALLOCATION_FAILED` に更新し、顧客に通知する |
| FR-3.4 | 同一注文に対して引当が二重実行されないこと（冪等性） |
| FR-3.5 | 在庫テーブルは DynamoDB 編で作成済みの `kiro-roasters-inventory` を使用する |

### FR-4: 注文確認通知

| ID | 要件 |
|----|------|
| FR-4.1 | 決済・引当が完了した注文について、顧客に確認メールを送信する |
| FR-4.2 | メールには注文番号、商品名、合計金額、到着予定を含める |
| FR-4.3 | 注文ステータスを `NOTIFIED` に更新する |
| FR-4.4 | 同一注文に対してメールが二重送信されないこと（冪等性） |

### FR-5: ポイント付与

| ID | 要件 |
|----|------|
| FR-5.1 | 決済完了後、購入金額の 1% をポイントとして付与する |
| FR-5.2 | ポイント付与が成功したら注文ステータスを `COMPLETED` に更新する |
| FR-5.3 | 同一注文に対してポイントが二重付与されないこと（冪等性） |

### FR-6: 注文ステータス照会

| ID | 要件 |
|----|------|
| FR-6.1 | 顧客が注文ステータスを API で照会できる |
| FR-6.2 | 後続処理の負荷に関わらず、照会 API の応答時間が 500ms 以内であること |

### FR-7: 負荷生成（検証用）

| ID | 要件 |
|----|------|
| FR-7.1 | 任意の注文件数/分 を指定してバズ状態を再現できる |
| FR-7.2 | 時間経過に伴う負荷カーブ（漸増→ピーク→漸減）をシミュレートできる |
| FR-7.3 | 生成する注文データは Kiro Roasters の商品マスタに基づくこと |

---

## 非機能要件

### NFR-1: スケーラビリティ

| ID | 要件 |
|----|------|
| NFR-1.1 | 通常時（1〜2件/分）は全後続処理が 10秒以内に完了する |
| NFR-1.2 | バズピーク時（800件/分）でもメッセージが欠落しない（最終的に全件処理される） |
| NFR-1.3 | 後続処理の負荷が照会 API に影響しない設計とする |

### NFR-2: 信頼性

| ID | 要件 |
|----|------|
| NFR-2.1 | 全ての後続処理は冪等に実装する（二重実行しても結果が変わらない） |
| NFR-2.2 | 処理失敗時は DLQ に退避し、手動またはバッチで再処理できる |
| NFR-2.3 | 一部の後続処理が失敗しても、他の処理は継続して実行される |

### NFR-3: 可観測性

| ID | 要件 |
|----|------|
| NFR-3.1 | CloudWatch ダッシュボードで以下を可視化する: IteratorAge, ConcurrentExecutions, Throttles, Queue深度 |
| NFR-3.2 | Lambda 枠の 80% 到達で Warning、Throttle 発生で Critical アラートを出す |
| NFR-3.3 | 各注文の処理フローを X-Ray でトレースできる |

### NFR-4: コスト

| ID | 要件 |
|----|------|
| NFR-4.1 | 検証終了後にリソースを一括削除できる（IaC で管理） |
| NFR-4.2 | 通常時にアイドルコストが最小限であること（サーバーレスアーキテクチャ） |
| NFR-4.3 | 負荷テスト時のコストが $10 以内に収まること（目安） |

### NFR-5: 開発体験

| ID | 要件 |
|----|------|
| NFR-5.1 | IaC は AWS CDK（TypeScript）で記述する |
| NFR-5.2 | Lambda ランタイムは Node.js（TypeScript）を使用する |
| NFR-5.3 | デプロイは `npx cdk deploy` で完結する |
| NFR-5.4 | 検証シナリオの切り替え（PF変更、SQS追加等）は CDK のコンテキストまたはスタックパラメータで行える |

---

## データモデル

### 注文テーブル: `kiro-roasters-orders`

| 属性 | 型 | キー | 説明 |
|------|-----|------|------|
| `order_id` | String | PK | `ORD#{ULID}` 形式。ソート可能な一意ID |
| `customer_id` | String | SK | `CUST#{user-id}` |
| `order_status` | String | — | PENDING / PAID / ALLOCATED / NOTIFIED / COMPLETED / PAYMENT_FAILED / ALLOCATION_FAILED |
| `items` | List | — | `[{sku: "ITEM#ETH-YIRG-G1-MEDIUM-200G", qty: 2, price: 1800}]` |
| `total_amount` | Number | — | 注文合計（税込） |
| `point_earned` | Number | — | 付与ポイント |
| `created_at` | String | — | ISO8601 |
| `updated_at` | String | — | ISO8601 |

- StreamViewType: `NEW_AND_OLD_IMAGES`
- Billing Mode: `PAY_PER_REQUEST`（オンデマンド）

#### GSI

| GSI名 | PK | SK | 用途 |
|--------|-----|-----|------|
| `customer-orders-index` | `customer_id` | `created_at` | 顧客別注文履歴照会 |

### 在庫テーブル: `kiro-roasters-inventory`（既存）

DynamoDB 編で作成済み。引当処理で `UpdateItem`（Atomic Counter）を使用。

### 冪等性管理テーブル: `kiro-roasters-idempotency`

Lambda Powertools Idempotency が使用。TTL 付きで自動期限切れ。

| 属性 | 型 | キー | 説明 |
|------|-----|------|------|
| `id` | String | PK | 冪等性キー（`{function-name}#{order_id}`） |
| `status` | String | — | INPROGRESS / COMPLETED / EXPIRED |
| `data` | String | — | 前回の実行結果（JSON） |
| `expiration` | Number | — | TTL（Unix timestamp） |

---

## アーキテクチャ構成（段階的）

### Phase 1: Streams → Lambda 直結（ダメな設計を体験する）

```
API GW ──→ Lambda（注文受付）──→ DynamoDB（orders）
                                       │
                                       │ Streams
                                       ▼
                                 Lambda（order-processor）
                                   │ 全後続処理を直列実行
                                   ├── 決済（sleep 3s）
                                   ├── 引当
                                   ├── 通知（sleep 500ms）
                                   └── ポイント

API GW ──→ Lambda（order-query） ← 巻き添えでスロットルされる
```

### Phase 2: SQS ファンアウト（推奨設計）

```
API GW ──→ Lambda（注文受付）──→ DynamoDB（orders）
                                       │
                                       │ Streams
                                       ▼
                                 Lambda（order-router）← 50ms で SQS に分配
                                   │
                    ┌──────────────┼──────────────┬──────────────┐
                    ▼              ▼              ▼              ▼
              SQS(payment)   SQS(allocation) SQS(notification) SQS(point)
                    │              │              │              │
                    ▼              ▼              ▼              ▼
              payment-worker allocation-worker notif-worker  point-worker
              MaxConc=50     MaxConc=200      MaxConc=200   MaxConc=200

API GW ──→ Lambda（order-query） ← スロットルされない
```

### Phase 3: FIFO / Pipes / Kinesis（発展形）

記事3の検証テーマに応じて追加構築。Phase 2 のスタックを拡張する形で実装。

---

## リポジトリ構成案

```
kiro-roasters-ec-stream/
├── README.md
├── package.json
├── tsconfig.json
├── cdk.json
├── .kiro/
│   └── steering/
│       └── project-context.md       # Kiro Roasters の業務コンテキスト
├── infra/
│   ├── bin/
│   │   └── app.ts                   # CDK エントリポイント
│   └── lib/
│       ├── phase1-stack.ts          # Streams → Lambda 直結
│       ├── phase2-stack.ts          # SQS ファンアウト
│       ├── phase3-stack.ts          # FIFO / Pipes / Kinesis
│       ├── shared/
│       │   ├── tables.ts            # DynamoDB テーブル定義
│       │   └── monitoring.ts        # CloudWatch ダッシュボード・アラーム
│       └── constructs/
│           ├── order-processor.ts   # Phase 1 用
│           ├── order-router.ts      # Phase 2 用
│           └── workers.ts           # SQS → Lambda ワーカー群
├── src/
│   ├── functions/
│   │   ├── order-accept/            # 注文受付 API
│   │   │   └── index.ts
│   │   ├── order-processor/         # Phase 1: 全処理直列
│   │   │   └── index.ts
│   │   ├── order-router/            # Phase 2: SQS へ分配
│   │   │   └── index.ts
│   │   ├── payment-worker/          # 決済処理
│   │   │   └── index.ts
│   │   ├── allocation-worker/       # 在庫引当
│   │   │   └── index.ts
│   │   ├── notification-worker/     # メール通知
│   │   │   └── index.ts
│   │   ├── point-worker/            # ポイント付与
│   │   │   └── index.ts
│   │   └── order-query/             # ステータス照会 API
│   │       └── index.ts
│   ├── shared/
│   │   ├── types.ts                 # 共通型定義
│   │   ├── idempotency.ts           # 冪等性ヘルパー
│   │   └── order-status.ts          # ステータス遷移ロジック
│   └── load-test/
│       ├── generate-orders.ts       # 負荷生成スクリプト
│       └── buzz-scenario.ts         # バズシナリオ定義
├── dashboards/
│   └── streams-monitoring.json      # CloudWatch ダッシュボード定義
└── docs/
    └── architecture.md              # アーキテクチャ図・判断記録
```

---

## 検証シナリオ

### シナリオ A〜E（記事1: Phase 1）

| ID | 条件 | 観測ポイント |
|----|------|------------|
| A | PF=1, 処理時間 100ms, 50件/分 | IteratorAge の基準値 |
| B | PF=1, 処理時間 3秒, 100件/分 | IteratorAge 上昇を観測 |
| C | PF=10, 処理時間 3秒, 300件/分 | PF引き上げの効果 |
| D | PF=10, 処理時間 3秒, 800件/分 | Lambda 枠 1,000 に接近 |
| E | D + order-query への並行リクエスト | 巻き添えスロットル発生 |

### シナリオ F〜H（記事2: Phase 2）

| ID | 条件 | 観測ポイント |
|----|------|------------|
| F | SQS Standard, MaxConc なし, 800件/分 | 自動スケールの挙動 |
| G | SQS Standard, payment MaxConc=50, 800件/分 | 流量制御。Queue 滞留と処理バランス |
| H | G + order-query への並行リクエスト | 巻き添え解消を確認 |

### シナリオ I〜K（記事3: Phase 3）

| ID | 条件 | 観測ポイント |
|----|------|------------|
| I | SQS FIFO, MessageGroupId=customer_id | 顧客単位の順序保証と並列度 |
| J | EventBridge Pipes, フィルタ付き | Lambda ルーター不要の構成 |
| K | Kinesis + Enhanced Fan-out, 3コンシューマ | 多コンシューマの独立性 |

---

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| IaC | AWS CDK v2（TypeScript） |
| ランタイム | Node.js 22.x（TypeScript） |
| DB | Amazon DynamoDB（オンデマンド） |
| ストリーム | DynamoDB Streams |
| キュー | Amazon SQS（Standard / FIFO） |
| イベントルーティング | Amazon EventBridge Pipes |
| ストリーミング | Amazon Kinesis Data Streams（Phase 3） |
| API | Amazon API Gateway（REST API） |
| 監視 | Amazon CloudWatch（ダッシュボード + アラーム） |
| トレーシング | AWS X-Ray |
| 冪等性 | Lambda Powertools for TypeScript（Idempotency） |
| 負荷生成 | AWS SDK for JavaScript（ローカルスクリプト） |

---

## スコープ外

以下はこのリポジトリでは扱わない:

- EC フロントエンド（UI）の実装
- 実際の決済 API（Stripe）との統合 — sleep で擬似化
- 実際のメール送信（SES）— ログ出力で代替
- 認証・認可（Cognito）
- CI/CD パイプライン
- 本番運用を想定したセキュリティ設計

---

## 前提条件

- AWS アカウントが利用可能であること
- Lambda 同時実行枠がデフォルト 1,000 であること（引き上げ申請はしない）
- DynamoDB 編で作成した在庫テーブルのスキーマ知識があること
- Node.js 22.x / AWS CDK CLI がローカルにインストール済み

---

## 成功基準

| 記事 | 成功基準 |
|------|---------|
| 1 | IteratorAge の爆発と巻き添えスロットルを CloudWatch グラフで明確に可視化できる |
| 2 | SQS ファンアウト導入前後で order-query の Throttle 有無が明確に変わる |
| 3 | FIFO / Pipes / Kinesis それぞれの特性を実測値で比較できる |
