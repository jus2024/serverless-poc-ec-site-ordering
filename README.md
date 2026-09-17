# Amplify Gen 2 業務 Web アプリテンプレート + 注文処理パイプライン PoC

AWS Amplify Gen 2 を中核にした業務 Web アプリケーション用のスターターテンプレートです。
オプションで Strands Agents による AI エージェント機能を追加できます。

このリポジトリにはテンプレートの上に、**DynamoDB Streams と Lambda を直結したときの
限界を実測する PoC**（`order-pipeline-poc`）が載っています。次の節を参照してください。

---

## 注文処理パイプライン PoC

架空のスペシャルティコーヒー焙煎メーカー Kiro Roasters の D2C EC を題材に、
**バズで入力が 100 倍・1000 倍になったとき、Streams 直結構成のどこが壊れるのか**を
絶対レートで実測します。

### ⚠️ 公開環境に置かないでください

**この PoC の API Gateway には認証が掛かっていません。** URL を知る第三者が
注文投入も負荷生成も起動でき、コストを発生させられます。検証者自身の sandbox で動かし、
使わない期間はスタックを削除してください。詳細と守るべき運用は
[docs/poc/verification-guide.md](docs/poc/verification-guide.md) の冒頭にあります。

### 中心的な問い

1. DynamoDB Streams の発行側が限界になるのか
2. Lambda の同時実行数が限界になるのか
3. 限界は段階的・連鎖的に現れるのか

事前分析の仮説は「壁は Lambda の同時実行枠ではなく**オープンシャード数 × 並列化係数**である」。
Streams のオープンシャードはテーブルのパーティションと 1 対 1 で対応し、
Lambda は 1 シャードを 1 インスタンスで処理します。

```
最大同時実行数 = オープンシャード数(S) × 並列化係数(P)
消費能力       = S × P ÷ 1 レコードの処理時間(D)
```

**入力が 1000 倍になってもシャードは増えないため、消費能力は 1 倍のまま**という予測です。
これを実測で検証・反証します。

### 検証の 2 つの軸

| 軸 | テーブルの状態 | 見に行く壁 |
|----|-------------|-----------|
| A | 既定のオンデマンドテーブル（S ≒ 4 と推定） | `S × P` の壁。滞留とデータロス |
| B | 事前ウォームでシャードを増やしたテーブル | Lambda 同時実行枠の壁。同期パスへの巻き添え |

同じバズが、テーブルの成熟度によって違う壊れ方をすることを示します。

### 構成

```
ブラウザ (OrderDashboard: 注文 / 負荷テスト / 計測結果 / 設定)
  → API Gateway (REST、認証なし)
    ├─ 同期パス   : order-accept / order-query
    ├─ 検証ツール : inventory-seed / load-generator / query-impact-measure / execution-status
    └─ DynamoDB orders (Streams: NEW_AND_OLD_IMAGES)
         → Streams ESM (filter: INSERT、PF 可変)
           → order-processor (決済 → 引当 → 通知 → ポイント付与を直列実行)
             → DLQ (SQS)
```

コードの置き場所:

| パス | 内容 |
|------|------|
| `amplify/custom/` | IaC（テーブル、Lambda 定義、API、Streams ESM、ダッシュボード、アラーム） |
| `amplify/functions/` | Lambda ハンドラと共有モジュール |
| `src/components/orders/` | 検証操作 UI |
| `src/lib/orders/` | API クライアントと消費能力・滞留の算術 |
| `.kiro/specs/order-pipeline-poc/` | requirements / design / tasks |

### セットアップ

```bash
npm ci

# バックエンドをデプロイ（別ターミナル）
npx ampx sandbox

# 出力された API URL を .env.local に写す
cp .env.example .env.local
# NEXT_PUBLIC_ORDER_API_URL=<amplify_outputs.json の custom.orderApiUrl>

# 開発サーバー（別ターミナル）
npm run dev
```

`http://localhost:3000` が検証操作 UI です。続けて初期在庫を投入し、
有効な検証パラメータを確認します。

```bash
export API=<custom.orderApiUrl>

curl -X POST "$API/inventory/seed" -H 'Content-Type: application/json' -d '{}'
curl -s "$API/config" | jq
```

`GET /config` の出典は `.env.local` ではなく**デプロイ済みの Lambda 環境変数**です。
計測条件の取り違えを防ぐため、シナリオ実行の直前に必ず確認してください。

### シナリオの実行

```bash
# 負荷生成の開始（202 が返り、投入は非同期に継続する）
curl -X POST "$API/load-test/start" -H 'Content-Type: application/json' \
  -d '{"ordersPerMinute": 1000, "durationSeconds": 900, "useRampCurve": false}'

# 結果の照会（シャード数・実測投入レート・算出した消費能力を含む）
curl -s "$API/executions/<executionId>" | jq
```

**設定の変え方は 2 系統あります。**

| 系統 | 対象 | 反映方法 |
|------|------|---------|
| 環境変数 | 並列化係数 P、擬似処理時間 D、warm throughput、TTL、パラメータ上限 | `.env` を書き換えて **再デプロイ**（`npx ampx sandbox`） |
| リクエストパラメータ | 投入レート、継続時間、負荷カーブ、並行計測の並行数・継続時間 | 再デプロイ**不要** |

シナリオ別の設定値、シャード数の確認方法、warm throughput 引き上げの事前確認
（**引き上げ後は下げられません**）、リソース削除手順は
[docs/poc/verification-guide.md](docs/poc/verification-guide.md) にまとめています。

### 検証状況

**軸 A（A0〜A8）と軸 B（B0 / B1 / B2）を実行しました。** 軸 B は検証者の承認により
B0〜B2 に限定しており、**B3 / B4 は実行できませんでした**（ウォーム write 100,000 が
us-west-2 のクォータ上限を超え、引き上げ申請を行わない方針のため）。
全記録は [docs/poc/verification-results.md](docs/poc/verification-results.md)、
実行できなかった論点（B3 / B4 を要する Lambda 同時実行枠の壁の挙動）は
[design.md §13](.kiro/specs/order-pipeline-poc/design.md) にまとめています。

**仮説は成立しました。壁は `S × P ÷ D` であり、Lambda の同時実行枠ではありません。**
事前ウォーム（write 40,000）でオープンシャードは 4 → 64 に増え、壁もそれに追随しました。
S=4 で 42,814 件の滞留を積んだ 2,000 件/分 と同じ負荷が、S=64 では滞留ゼロまで消化されています。

主な補正と想定外の発見:

- **式は P について線形にスケールしません（設計が想定していなかった補正）。** P=10 の飽和能力は
  式の値の約 0.84 倍（`ParallelizationFactor` 内のチェックポイント同期による損失）。
  PF=10 の壁を見積もるときは `S × P ÷ D × 0.84` を使います。
- **設計の式に誤りが見つかり訂正しました。** `IteratorAge = 滞留 ÷ 投入レート` であり、
  `÷ 消費能力` ではありません。これに伴いデータロス猶予時間と回復時間の式を訂正し、
  design §2.4 と `src/lib/orders/capacity.ts` を修正しています。
- **出典要件が想定していなかった 2 点。** (1) 過負荷は請求額に現れません（コストは処理件数に比例し、
  処理件数は能力で頭打ちになるため。過負荷を検知できるのは `IteratorAge` だけ）。
  (2) 要件 15.1 の「投入 < 消費能力 なら 10 秒以内」という前提は壁の近傍では成立せず、
  おおむね 投入 ≤ 能力 × 0.36 が必要でした。

出典の要件定義から変更した点（シナリオ D / E の差し替え理由を含む）は同じドキュメントに
記載済みです。

### コスト

事前見積もりは 軸 A 約 $2.7 + 軸 B 約 $18.3 でしたが、B3 / B4 を実行しなかったため実績は異なります。
軸 B のシナリオコストは約 $1.3 で、これに write 40,000 への事前ウォームの一回限りの課金 $23.40 が
加わります（この $23.40 は引き下げられませんが、テーブル削除でリセットされます）。
Cost Explorer の実績値は反映待ち（24〜48 時間）です。予算枠は $100。
検証していない期間は `npx ampx sandbox delete` でスタックを削除してください。

---

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| フロントエンド | Next.js + TypeScript |
| バックエンド | AWS Amplify Gen 2 |
| エージェント UI（任意） | CopilotKit（`@copilotkit/react-core/v2`）+ AG-UI プロトコル |
| エージェント（任意） | Python 3.12〜3.13 / Strands Agents SDK + ag-ui-strands |
| エージェント実行基盤（任意） | Amazon Bedrock AgentCore Runtime |
| エージェント管理（任意） | AgentCore CLI (`@aws/agentcore`) |
| ホスティング | Amplify Hosting |
| IDE 支援 | Kiro + Agent Toolkit for AWS |

## ディレクトリ構成

```
src/                    # フロントエンド（Next.js App Router）
  app/api/copilotkit/   # CopilotKit Runtime API Route（SigV4 → AgentCore プロキシ）
  lib/agent/            # CopilotProvider（認証 + CopilotKit 接続）
  lib/orders/           # PoC: API クライアントと消費能力・滞留の算術
  components/agent/     # AgentChatSection（CopilotChat UI）
  components/orders/    # PoC: 検証操作 UI
amplify/                # Amplify Gen 2 バックエンド定義
  custom/               # PoC: IaC（テーブル、Lambda、API、Streams、監視）
  functions/            # PoC: Lambda ハンドラと共有モジュール
agents/                 # エージェント（任意、AgentCore CLI 管理）
  agentcore/            # AgentCore CLI 設定
  app/                  # エージェントコード
docs/                   # 詳細ドキュメント
  poc/                  # PoC の業務設定・出典要件・検証手順・実測結果
.kiro/                  # Kiro ワークスペース設定
.github/                # CI/CD
```

---

## クイックスタート

### Web アプリを動かす（全員共通、5 分）

```bash
git clone <リポジトリURL>
cd <プロジェクト名>
npm ci
```

ターミナルを2つ開いて:

```bash
# ターミナル 1: Amplify sandbox 起動（初回は数分）
npx ampx sandbox

# ターミナル 2: 開発サーバー起動
npm run dev
```

`http://localhost:3000/sample` で Todo リストが動けば成功です。

---

### エージェントを動かす（任意）

エージェント機能は段階的に試せます。Web アプリとの結合にはデプロイが必要ですが、エージェント単体はローカルで確認できます。

#### Step 1: エージェントプロジェクトを作成する

リポジトリルートで AgentCore CLI を使ってエージェントプロジェクトを生成します。

```bash
# AgentCore CLI インストール（未インストールの場合）
npm install -g @aws/agentcore

# リポジトリルートで実行
agentcore create
```

対話 UI で以下を選択:
- Project name: **`agents`**
- Add agent: **Yes**
- Agent name: 任意（例: `my_agent`）
- Type: **Create new agent**
- Language: **Python**
- Build: **Container**
- Protocol: **AG-UI**
- Framework: **Strands Agents SDK**
- Model: **Amazon Bedrock**
- Memory: **None**（サンプルでは不要）
- Advanced: スキップ（JWT 認証は不要 — SigV4 を使用）

#### Step 2: エージェントをローカルで試す

生成されたエージェントの動作確認:

```bash
cd agents
agentcore dev
```

ブラウザで `http://localhost:8080/invocations` を開くと、Dev 用の AI チャット画面が表示されます（Docker が起動している必要があります）。

別ターミナルから curl で直接リクエストを送ることもできます:

```bash
curl -N -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -H "X-Agentcore-Local: true" \
  -d '{
    "threadId": "test-1",
    "runId": "run-1",
    "prompt": "1+2は？",
    "messages": [{"id": "m1", "role": "user", "content": "1+2は？"}],
    "tools": [], "context": [], "state": {}, "forwardedProps": {}
  }'
```

AG-UI イベント（`RUN_STARTED`, `TEXT_MESSAGE_CONTENT`, `RUN_FINISHED`）が返れば成功です。

#### Step 3: Web アプリとエージェントを接続する（要デプロイ）

ローカルでの結合テストはできません（SigV4 署名に Amplify Hosting のコンピューティングロールが必要なため）。接続には以下の手順が必要です:

1. **Amplify Hosting にリポジトリ接続** → Web アプリ + Cognito をデプロイ
2. **AgentCore Runtime にデプロイ** → `cd agents && agentcore deploy`
3. **コンピューティングロールに権限追加** → `bedrock-agentcore:InvokeAgentRuntime` ポリシーをアタッチ
4. **環境変数を設定** → Amplify コンソールで `NEXT_PUBLIC_AGENTCORE_RUNTIME_ARN` を設定
5. **再デプロイ** → 環境変数反映のためビルドをトリガー

詳細な手順は [docs/deployment.md](docs/deployment.md) を参照してください。

**接続の仕組み:**

```
ブラウザ (CopilotKit + Cognito トークン)
  → /api/copilotkit (Next.js API Route, Amplify Hosting SSR Lambda)
    → CopilotRuntime + ExperimentalEmptyAdapter
      → HttpAgent (SigV4 署名、コンピューティングロールの権限で署名)
        → AgentCore Runtime (IAM 認証, AG-UI プロトコル)
```

---

## 更新時のデプロイ

### Web アプリの更新

```bash
git push origin <ブランチ名>
```

Amplify Hosting が自動デプロイします。

### エージェントの更新

```bash
cd agents
agentcore deploy
```

### 両方を更新する場合

エージェント → フロントエンドの順にデプロイしてください。

---

## お片付け（リソース削除）

```bash
# 1. AgentCore Runtime の削除
cd agents
agentcore remove all --yes
agentcore deploy

# 2. Amplify Hosting の削除（コンソールから）
# AWS コンソール → Amplify → アプリを削除

# 3. sandbox の停止（残っている場合）
npx ampx sandbox delete
```

---

## ブランチ戦略

| ブランチ | 用途 |
|---------|------|
| `main` | 本番向け |
| `develop` | 統合ブランチ |
| `feature/*` | 実装作業用 |

## CI/CD

| 対象 | 担当 | 方法 |
|------|------|------|
| Web アプリ（品質ゲート） | GitHub Actions | lint、型チェック |
| Web アプリ（デプロイ） | Amplify Hosting | Git push で自動 |
| エージェント（品質ゲート） | GitHub Actions | lint、インポート確認 |
| エージェント（デプロイ） | AgentCore CLI | `agentcore deploy` |

## Kiro + Agent Toolkit for AWS

[Agent Toolkit for AWS](https://github.com/aws/agent-toolkit-for-aws) の MCP サーバーを設定済みです。Kiro から AWS ドキュメント検索、スキル検索、CLI 実行が利用できます。Skills はオンデマンド検索されるためローカルインストール不要です。

---

## サンプルの除去

テンプレートから自分のプロジェクトを始める際:

**フロントエンド:**
1. `src/app/sample/` を削除
2. `src/components/agent/` を削除（エージェント不使用の場合）
3. `src/lib/agent/` を削除（エージェント不使用の場合）
4. `src/app/api/copilotkit/` を削除（エージェント不使用の場合）
5. `amplify/data/resource.ts` の `Todo` モデルを自分のモデルに置き換え

**エージェント（使わない場合）:** `agents/` ディレクトリごと削除

**エージェント（使う場合）:** `agents/app/sample_agent/` を参考に新規エージェントを作成

## 詳細ドキュメント

| ドキュメント | 内容 |
|-------------|------|
| [docs/setup.md](docs/setup.md) | セットアップ詳細・前提条件 |
| [docs/deployment.md](docs/deployment.md) | デプロイ手順の詳細（Amplify + AgentCore + コンピューティングロール） |
| [docs/kiro-usage.md](docs/kiro-usage.md) | Kiro の steering/skills の使い方 |
| [docs/sample/](docs/sample/) | サンプルページの仕組み |
| [agents/README.md](agents/README.md) | エージェント開発の詳細 |
| [docs/poc/verification-guide.md](docs/poc/verification-guide.md) | PoC の検証手順書（シナリオ実行、シャード数確認、warm throughput の事前確認、お片付け） |
| [docs/poc/verification-results.md](docs/poc/verification-results.md) | PoC の実測結果と出典からの変更点 |
| [docs/poc/kiro-roasters-background.md](docs/poc/kiro-roasters-background.md) | 架空企業 Kiro Roasters の業務設定・命名規則 |
| [docs/poc/phase2-streams-requirements.md](docs/poc/phase2-streams-requirements.md) | PoC の出典となった要件定義 |
