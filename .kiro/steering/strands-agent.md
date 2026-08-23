---
inclusion: fileMatch
fileMatchPattern: "agents/**/*"
---

# Strands エージェント方針

- Python 3.12〜3.13 互換のコードを書く（3.14 は ag-ui-strands 非対応）
- エージェントはモジュール化し、ツールは明示的に定義する
- 隠れた副作用を避ける
- ログによる観測可能なランタイム動作を優先する
- 設定、プロンプト、ツール、ランタイムロジックを分離する
- ローカル実行を簡単かつ再現可能に保つ
- `agents/` はオプションのプロジェクト拡張コードであり、アプリの中心ではない

# AgentCore Runtime 前提（AG-UI プロトコル）

- エージェントは Amazon Bedrock AgentCore Runtime 上での実行を前提とする
- AG-UI プロトコルに準拠したサーバーとして実装する
- `ag-ui-strands` の `create_strands_app()` で AG-UI アプリを構築する
- エンドポイント: `/invocations`（POST）と `/ping`（GET）
- AgentCore Runtime のデプロイ時は `--protocol AGUI` を指定する
- `agents/` 内に Web UI 層を含めない
- フロントエンドとの接続は CopilotKit + AG-UI + SigV4 経由

# AgentCore CLI（`@aws/agentcore`）

- エージェントの管理・デプロイは AgentCore CLI を使用する
- `agents/` ディレクトリが存在しない場合、エージェントコードを直接作成しない。ユーザーに `agentcore create` の実行を案内する
- `agentcore create` は対話的 CLI のため、Kiro から自動実行できない。ユーザーに手動実行を依頼する
- `agentcore create` でプロジェクト初期化（AG-UI + Strands + Container を選択）
- ローカル開発: `agentcore dev` または `uvicorn` で直接起動
- デプロイ: `agentcore deploy`
- リソース削除: `agentcore remove all --yes` + `agentcore deploy`
- エージェント追加: `agentcore add agent`

# 認証構成

- AgentCore Runtime は IAM（SigV4）認証を使用する
- JWT 認証は CopilotKit 経由では動作しないため使用しない
- SigV4 署名は Next.js API Route 内で行い、Amplify Hosting のコンピューティングロールの権限を使用する
- Amplify Hosting のコンピューティングロールに `bedrock-agentcore:InvokeAgentRuntime` 権限が必要

# デプロイ方針

Amplify Hosting と AgentCore Runtime は別々にデプロイする:

- Amplify Hosting: フロントエンド + Cognito + API Route（Git push で自動デプロイ）
- AgentCore Runtime: AgentCore CLI（`agentcore deploy`）で手動デプロイ
- Amplify Hosting のビルド環境は Docker 非対応のため、AgentCore Runtime を Amplify の CDK スタックに含めない

環境分離:
- 開発環境と本番環境で AgentCore Runtime を分ける
- ローカル開発でのエージェント動作確認は `uvicorn` または `agentcore dev` を使用（Runtime 不要）
- フロントエンド結合テストは Amplify Hosting のデプロイ環境で行う

# ドキュメント確認

- Strands Agents SDK の実装は、Power（strands）で最新ドキュメントを確認してから着手する
- AgentCore Runtime の設定・デプロイは、Power（aws-agentcore）で最新ドキュメントを確認してから着手する
- Amplify Gen 2 との統合は、Power（aws-amplify）または AWS MCP で最新ドキュメントを確認する
