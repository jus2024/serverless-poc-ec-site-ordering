# セットアップガイド

## 前提条件

- Node.js 20 以上
- npm
- AWS アカウントと認証情報（`aws configure` 設定済み）
- Git

### エージェント機能を使う場合（任意）

- Python 3.12〜3.13（3.14 は ag-ui-strands 非対応）
- Docker（Container ビルドのエージェントに必要）
- AgentCore CLI (`npm install -g @aws/agentcore`)

## Web アプリのセットアップ

```bash
# リポジトリのクローン
git clone <リポジトリURL>
cd <プロジェクト名>

# 依存関係のインストール
npm ci

# 環境変数の設定
cp .env.example .env.local
# .env.local を編集（エージェント不使用なら編集不要）

# Amplify sandbox の起動（バックエンド開発用、別ターミナルで）
npx ampx sandbox

# 開発サーバーの起動（別ターミナルで）
npm run dev
```

`http://localhost:3000/sample` で Todo リストが動けば成功です。

### 環境変数

| 変数 | 用途 | 必須 |
|------|------|------|
| `NEXT_PUBLIC_AGENTCORE_RUNTIME_ARN` | AgentCore Runtime の ARN | エージェント使用時のみ |

ローカル開発では環境変数なしで Web アプリの基本機能（Todo リスト等）が動作します。エージェントチャットは Runtime ARN 設定後のデプロイ環境でのみ動作します。

## エージェントのセットアップ（任意）

### AgentCore CLI のインストール

```bash
npm install -g @aws/agentcore
agentcore --version
```

### Python 環境

```bash
cd agents/app/sample_agent
python3.13 -m venv .venv    # Python 3.12 または 3.13 を使用
source .venv/bin/activate
pip install -e .
```

### ローカル動作確認

```bash
# 方法 1: uvicorn で直接起動（最小確認）
cd agents/app/sample_agent
source .venv/bin/activate
LOCAL_DEV=1 uvicorn main:app --host 0.0.0.0 --port 8080

# 方法 2: AgentCore CLI でローカル開発サーバーを起動
cd agents
agentcore dev
```

動作確認:

```bash
# /ping エンドポイント
curl http://localhost:8080/ping

# AG-UI リクエスト
curl -N -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{
    "threadId": "test-1",
    "runId": "run-1",
    "messages": [{"id": "m1", "role": "user", "content": "1+2は？"}],
    "tools": [], "context": [], "state": {}, "forwardedProps": {}
  }'
```

### プロジェクト構成

```
agents/
├── agentcore/
│   ├── agentcore.json      # AgentCore プロジェクト設定
│   ├── aws-targets.json    # デプロイ先（アカウント + リージョン）
│   ├── .llm-context/       # 型定義（AI アシスタント用）
│   └── cdk/                # CDK インフラ定義
├── app/
│   └── sample_agent/       # サンプルエージェント
│       ├── main.py         # AG-UI サーバー（FastAPI + ag-ui-strands）
│       ├── model/          # モデルローダー
│       ├── pyproject.toml  # Python 依存関係
│       ├── Dockerfile      # Container ビルド用
│       └── uv.lock         # ロックファイル
├── AGENTS.md               # AgentCore プロジェクト説明
└── README.md               # エージェント開発ガイド
```

## Kiro + Agent Toolkit for AWS

`.kiro/settings/mcp.json` で Agent Toolkit for AWS の MCP サーバーが設定済みです。
Kiro から以下の機能が利用できます:

- AWS ドキュメント検索
- AWS CLI コマンド実行
- Python スクリプト実行（boto3 経由）
- Agent Skills のオンデマンド検索・取得
- リージョン別サービス可用性の確認

Skills はローカルにインストールせず、MCP サーバー経由でオンデマンド検索されます。

## ローカル開発の制限事項

| 機能 | ローカルで動作 | 備考 |
|------|:---:|------|
| Todo リスト | ✅ | sandbox 起動が必要 |
| Cognito 認証 | ✅ | sandbox の Cognito を使用 |
| エージェント単体 | ✅ | uvicorn / agentcore dev |
| エージェントチャット（結合） | ❌ | SigV4 + コンピューティングロールが必要 |

エージェントチャットの結合テストは Amplify Hosting のデプロイ環境で行ってください。詳細は [deployment.md](deployment.md) を参照。

## 注意事項

- `.env.local` はコミットしないでください
- Amplify sandbox は開発用の一時的なバックエンド環境を作成します
- `LOCAL_DEV=1` を設定すると OpenTelemetry の警告が抑制されます
- AgentCore CLI の `agentcore dev` はローカル開発サーバーを起動しますが、AWS リソースは作成しません
