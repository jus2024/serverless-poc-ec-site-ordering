---
inclusion: fileMatch
fileMatchPattern: "amplify/**/*"
---

# Amplify バックエンド方針

- `amplify/` をバックエンド定義のソースとして扱う
- バックエンド定義は TypeScript ファーストで、レビューしやすく保つ
- 大規模な書き換えより、段階的なバックエンド変更を優先する
- バックエンド定義を変更する際は、フロントエンドへの影響を説明する
- Amplify sandbox による反復開発と相性の良いパターンを優先する

# AgentCore Runtime との責務分離

- Amplify Hosting は Web アプリ + Cognito を担当する
- AgentCore Runtime はエージェントの実行基盤を担当する（AgentCore CLI で管理）
- Amplify のビルド環境は Docker 非対応のため、AgentCore Runtime を Amplify の CDK スタックに含めない
- Cognito User Pool は Amplify が管理し、AgentCore の JWT 認証設定で参照する
