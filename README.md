# Amplify Gen 2 業務 Web アプリテンプレート

AWS Amplify Gen 2 を中核にした業務 Web アプリケーション用のスターターテンプレートです。
オプションで Strands Agents による AI エージェント機能を追加できます。

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
  components/agent/     # AgentChatSection（CopilotChat UI）
amplify/                # Amplify Gen 2 バックエンド定義
agents/                 # エージェント（任意、AgentCore CLI 管理）
  agentcore/            # AgentCore CLI 設定
  app/                  # エージェントコード
docs/                   # 詳細ドキュメント
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
