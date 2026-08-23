---
inclusion: fileMatch
fileMatchPattern: "src/**/*"
---

# フロントエンド方針

- TypeScript を一貫して使用する
- 小さく合成可能なコンポーネントと機能単位の構成を優先する
- UI ロジックとインフラ関連処理を可能な限り分離する
- UI コードとオプションのエージェントランタイムコードの密結合を避ける
- バックエンド生成アーティファクトへの依存がある場合は文書化する

# エージェントチャット UI（CopilotKit）

- エージェント UI は CopilotKit を使用する
- フロントエンドの import は `@copilotkit/react-core/v2` を使用する（v1 ではない）
- `CopilotProvider` が認証ヘッダー（Cognito トークン）を付与して `/api/copilotkit` にリクエストを送る
- `CopilotChat` コンポーネントがチャット UI を提供する
- `AgentChatSection` で Runtime ARN が設定されているか確認し、未設定時は案内を表示する

# API Route（/api/copilotkit）

- Next.js API Route で CopilotKit Runtime を動作させる
- `ExperimentalEmptyAdapter` を `serviceAdapter` に指定する（必須）
- `HttpAgent` のカスタム `fetch` で SigV4 署名を行い、AgentCore Runtime に接続する
- フロントエンドの Cognito トークンは API Route で存在チェックし、ユーザー認証のゲートとする
- SigV4 はサーバーサイド（Lambda）の IAM ロールで署名する

# AgentCore Memory 拡張時の注意

- Memory 有効化時は `X-Amzn-Bedrock-AgentCore-Runtime-User-Id` ヘッダーに Cognito ユーザー ID を設定する
- `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` でセッションを管理する
- Cognito トークンの `sub` クレームをユーザー ID として使用する
