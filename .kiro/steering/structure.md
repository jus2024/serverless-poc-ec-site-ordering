---
inclusion: always
---

# リポジトリ構成

想定構成:
- `src/` : Web アプリケーション本体
  - `src/app/api/copilotkit/` : CopilotKit Runtime API Route（SigV4 → AgentCore プロキシ）
  - `src/lib/agent/` : CopilotProvider（認証 + CopilotKit 接続）
  - `src/components/agent/` : AgentChatSection（CopilotChat UI）
- `amplify/` : Amplify Gen 2 バックエンド定義
- `agents/` : AgentCore CLI プロジェクト（`agentcore create` で生成）
  - `agents/agentcore/` : agentcore.json, CDK 等
  - `agents/app/` : エージェントコード
- `.kiro/` : Kiro ワークスペース設定
- `.github/` : CI/CD とリポジトリテンプレート

ルール:
- 明示的に依頼されない限り、主要ディレクトリを移動しない
- エージェントコードは Web アプリのパスから分離する
- `agents/` に Web UI 層（API エンドポイント、HTML、フロントエンド）を含めない
- `src/` にエージェントのランタイムロジック（Python コード、エージェント定義）を含めない
- フロントエンドとエージェントの接続は CopilotKit + API Route + SigV4 経由とする

# ページ構成

- 新規機能はトップページ（`src/app/page.tsx`）に構築する
- 明示的に依頼されない限り、サブページを新たに作らず、トップページを主画面とする
- `src/app/sample/` はテンプレートの参考実装であり、機能開発時にはサンプルページへのリンクを外す
- サンプルページ自体は参照用に残してよいが、ナビゲーションからは除外する
