---
inclusion: always
---

# 技術方針

主要スタック:
- フロントエンド: Next.js + TypeScript
- バックエンド: AWS Amplify Gen 2
- エージェント UI: CopilotKit（@copilotkit/react-core/v2 + @copilotkit/react-ui）
- エージェント通信: AG-UI プロトコル
- エージェント（任意）: Python 3.12〜3.13 / Strands Agents SDK + ag-ui-strands
- エージェント実行基盤（任意）: Amazon Bedrock AgentCore Runtime
- エージェント管理 CLI（任意）: AgentCore CLI (`@aws/agentcore`)
- リポジトリ: GitHub
- デプロイ先（Web）: Amplify Hosting
- デプロイ先（エージェント）: AgentCore CLI (`agentcore deploy`)
- IDE 支援: Kiro + Agent Toolkit for AWS（MCP サーバー）

技術ルール:
- フロントエンドと Amplify バックエンド定義には TypeScript を使用する
- Python は `agents/` 内でのみ使用する
- エージェントのランタイム関連処理は Web アプリ本体から分離する
- 暗黙の規約より、明示的で読みやすい設定を優先する
- MCP サーバーは Agent Toolkit for AWS（aws-mcp）を使用する

# CopilotKit + AgentCore 接続の構成

```
ブラウザ (@copilotkit/react-core/v2 + CopilotChat)
  → /api/copilotkit (Next.js API Route, Amplify Hosting SSR Lambda)
    → CopilotRuntime + ExperimentalEmptyAdapter
      → HttpAgent (fetch: sigv4Fetch でカスタム SigV4 署名)
        → AgentCore Runtime (IAM 認証, AG-UI プロトコル)
```

重要な設定:
- バックエンドの CopilotRuntime には `ExperimentalEmptyAdapter` が必須
- フロントエンドは `@copilotkit/react-core/v2` を使う（v1 ではない）
- AgentCore への認証は SigV4（IAM）— JWT は CopilotKit 経由では動作しない
- Amplify Hosting にコンピューティングロール（`bedrock-agentcore:InvokeAgentRuntime` 権限）が必要
