# エージェントチャット

サンプルページに配置された AgentCore Runtime との対話デモです。

## 概要

Cognito 認証済みユーザーが、CopilotKit + AG-UI プロトコル経由で AgentCore Runtime 上のエージェントとリアルタイムに対話できるチャット UI です。エージェントの応答はトークン単位でストリーミング表示されます。

## アーキテクチャ

```
ブラウザ (CopilotKit + Cognito トークン)
  │
  ├─ 1. fetchAuthSession() → Cognito Access Token 取得
  │
  ├─ 2. POST /api/copilotkit
  │     Authorization: Bearer {Cognito JWT}
  │     Body: CopilotKit ランタイムリクエスト
  │
  └─ Next.js API Route (Amplify Hosting SSR Lambda)
       │
       ├─ 3. Bearer トークン存在確認（ユーザー認証ゲート）
       │
       ├─ 4. CopilotRuntime + ExperimentalEmptyAdapter
       │     HttpAgent → SigV4 署名（コンピューティングロールの IAM 権限）
       │
       └─ 5. AgentCore Runtime (IAM 認証)
             → AG-UI イベントストリーム応答
```

## 通信方式

### ブラウザ → API Route

| 項目 | 値 |
|------|-----|
| プロトコル | HTTPS |
| メソッド | POST |
| エンドポイント | `/api/copilotkit` |
| 認証 | `Authorization: Bearer {Cognito Access Token}` |
| リクエスト形式 | CopilotKit Runtime プロトコル |

### API Route → AgentCore Runtime

| 項目 | 値 |
|------|-----|
| プロトコル | AG-UI over HTTPS |
| メソッド | POST |
| エンドポイント | `https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{arn}/invocations?qualifier=DEFAULT` |
| 認証 | SigV4（サービス: `bedrock-agentcore`、コンピューティングロールの IAM 権限） |
| リクエスト形式 | `RunAgentInput`（`threadId`, `runId`, `messages[]`, `tools[]`, `state`） |
| レスポンス形式 | AG-UI イベントストリーム（SSE） |

## AG-UI イベント

| イベント | 説明 |
|---------|------|
| `RUN_STARTED` | エージェント実行開始 |
| `TEXT_MESSAGE_START` | メッセージ開始 |
| `TEXT_MESSAGE_CONTENT` | テキストチャンク（`delta` フィールド） |
| `TEXT_MESSAGE_END` | メッセージ終了 |
| `TOOL_CALL_START` | ツール呼び出し開始 |
| `TOOL_CALL_RESULT` | ツール実行結果 |
| `RUN_FINISHED` | エージェント実行完了 |
| `RUN_ERROR` | エラー発生 |

## SigV4 署名の仕組み

API Route 内で `@smithy/signature-v4` を使用して署名します:

1. `defaultProvider()` でコンピューティングロールの認証情報を取得
2. `SignatureV4` でリクエストに署名（サービス: `bedrock-agentcore`）
3. 署名済みヘッダーを付与して AgentCore Runtime に送信

コンピューティングロールには `bedrock-agentcore:InvokeAgentRuntime` 権限が必要です。権限設定の詳細は [../deployment.md](../deployment.md) の手順 3 を参照してください。

## CopilotKit

フロントエンドの UI は CopilotKit が提供するコンポーネントを使用しています:

- `CopilotKit`（`@copilotkit/react-core/v2`）— API Route への接続プロバイダー（認証ヘッダー付与）
- `CopilotChat` — チャット UI コンポーネント（ストリーミング表示対応）

CopilotKit が AG-UI イベントのパース、メッセージ状態管理、ストリーミング表示を担当するため、独自の SSE パース実装は不要です。

### API Route 側

- `CopilotRuntime` — エージェントの管理とリクエストルーティング
- `ExperimentalEmptyAdapter` — `serviceAdapter` として必須（LLM 直接呼び出しを行わないため）
- `HttpAgent`（`@ag-ui/client`）— SigV4 署名付きの fetch で AgentCore Runtime に接続

## エージェント側

エージェントは `ag-ui-strands` でラップされた FastAPI サーバーです:

- `create_strands_app()` で AG-UI 対応の FastAPI アプリを生成
- `/invocations`（POST）と `/ping`（GET）エンドポイントを公開
- `StrandsAgent` が Strands Agent の応答を AG-UI イベントに変換
- AgentCore Runtime に `protocol: "AGUI"` でデプロイ

## エラーハンドリング

| エラー種別 | 条件 | UI 表示 |
|-----------|------|---------|
| Runtime 未設定 | `NEXT_PUBLIC_AGENTCORE_RUNTIME_ARN` が空 | 入力無効化 + 案内メッセージ |
| 認証エラー | Cognito 未ログイン or トークン期限切れ | 401 → CopilotKit のエラー表示 |
| 権限エラー | コンピューティングロールの権限不足 | 500 → サーバーエラー表示 |
| AG-UI エラー | `RUN_ERROR` イベント | CopilotKit のエラー表示 |

## 関連ファイル

| ファイル | 役割 |
|---------|------|
| `src/app/api/copilotkit/route.ts` | CopilotKit Runtime + SigV4 → AgentCore プロキシ |
| `src/components/agent/AgentChatSection.tsx` | チャット UI セクション（CopilotChat 使用） |
| `src/lib/agent/CopilotProvider.tsx` | CopilotKit プロバイダー（Cognito トークン付与） |
| `agents/app/sample_agent/main.py` | AG-UI サーバー（FastAPI + ag-ui-strands） |

## 前提条件

- Amplify Hosting にデプロイ済みであること
- `NEXT_PUBLIC_AGENTCORE_RUNTIME_ARN` 環境変数が設定されていること
- AgentCore Runtime がデプロイ済みであること
- コンピューティングロールに `bedrock-agentcore:InvokeAgentRuntime` 権限があること
- ユーザーが Cognito でログイン済みであること

## ローカルでの制限

エージェントチャットの結合テストはローカルでは実行できません:
- SigV4 署名に Amplify Hosting のコンピューティングロール（IAM）が必要
- ローカルの `npm run dev` には該当ロールがない

エージェント単体のテストは `uvicorn` または `agentcore dev` でローカル実行可能です。

## カスタマイズ

- エージェントのシステムプロンプトやツールは `agents/app/sample_agent/main.py` で変更
- CopilotKit の UI は `AgentChatSection.tsx` の `labels` やスタイルで調整
- 新しいエージェントを追加する場合は API Route の `agents` オブジェクトにも追加
- AgentCore Memory 有効化時は API Route で `X-Amzn-Bedrock-AgentCore-Runtime-User-Id` ヘッダーを追加
