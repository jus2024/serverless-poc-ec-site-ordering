# AGENTS.md

## リポジトリ原則
- Git をソースオブトゥルースとする
- 実装作業は feature ブランチで行う
- `main` への直接編集は想定しない
- 変更は小さく、依頼内容にスコープを絞る
- 明示的に依頼されない限り、無関係なリファクタは行わない

## セキュリティ原則
- シークレット、トークン、API キー、認証情報をハードコードしない
- AWS 標準の認証方式と環境変数ベースの設定を優先する
- IAM、CI/CD、認証、デプロイの変更はレビュー必須とする
- コンピューティングロールの権限変更は高感度変更として扱う

## 検証原則
- 最も狭い範囲の検証を最初に実行する
- 影響レイヤーを明示する: フロントエンド、Amplify バックエンド、エージェント、CI/CD
- 変更が複数レイヤーにまたがる場合は、関係性を明確に説明する

## プロジェクト構成
- `src/` : フロントエンドコード（Next.js App Router）
  - `src/app/api/copilotkit/` : CopilotKit Runtime API Route（SigV4 → AgentCore プロキシ）
  - `src/lib/agent/` : CopilotProvider（Cognito 認証 + CopilotKit 接続）
  - `src/components/agent/` : AgentChatSection（CopilotChat UI）
- `amplify/` : Amplify Gen 2 バックエンド定義（auth, data）
- `agents/` : オプションの Strands エージェントコード（AgentCore CLI 管理）
  - `agents/agentcore/` : AgentCore CLI 設定（agentcore.json, aws-targets.json, CDK）
  - `agents/app/` : エージェントコード（AG-UI サーバー）
- `.kiro/` : Kiro ワークスペース設定（steering, skills, MCP）
- `.github/` : CI ワークフロー（Web App lint + Agent smoke check）
- `docs/` : 詳細ドキュメント

## 接続アーキテクチャ（エージェント使用時）
```
ブラウザ (CopilotKit + Cognito JWT)
  → /api/copilotkit (Next.js API Route, Amplify Hosting SSR Lambda)
    → CopilotRuntime + ExperimentalEmptyAdapter
      → HttpAgent (SigV4 署名、コンピューティングロールの IAM 権限)
        → AgentCore Runtime (IAM 認証, AG-UI プロトコル)
```

## ツール
- IDE: Kiro
- MCP: Agent Toolkit for AWS（aws-mcp）
- エージェント管理: AgentCore CLI (`@aws/agentcore`)
- Web デプロイ: Amplify Hosting（Git push で自動）
- エージェントデプロイ: `agentcore deploy`

## CI/CD
- Web アプリ: `.github/workflows/ci.yml`（lint + 型チェック）
- エージェント: `.github/workflows/ci-agents.yml`（ruff lint + インポート確認）
- Web デプロイ: Amplify Hosting（push → 自動ビルド）
- エージェントデプロイ: `agentcore deploy`（手動）

## 成果物の方針
- 実用的で本番運用を意識した解決策を優先する
- 明示的に依頼されない限り、既存のプロジェクト構成を維持する
- 新規追加ファイルが必要な理由を説明する
