# デプロイガイド

Amplify Hosting（フロントエンド + Cognito）と AgentCore Runtime（エージェント）は別々にデプロイします。
エージェントとの接続には、Amplify Hosting のコンピューティングロールに IAM 権限を追加する必要があります。

## 全体像

```
┌─────────────────────────────────────────────────────────────┐
│ Amplify Hosting                                             │
│                                                             │
│  Next.js SSR Lambda (コンピューティングロール)                  │
│    └─ /api/copilotkit → SigV4 署名 → AgentCore Runtime     │
│                                                             │
│  Cognito User Pool (ユーザー認証)                             │
│  AppSync + DynamoDB (データ)                                 │
└─────────────────────────────────────────────────────────────┘
          │ SigV4 (IAM)
          ▼
┌─────────────────────────────────────────────────────────────┐
│ AgentCore Runtime                                           │
│                                                             │
│  sample_agent (AG-UI プロトコル)                              │
│    └─ Strands Agent + ag-ui-strands                         │
└─────────────────────────────────────────────────────────────┘
```

**認証フロー:**
1. ブラウザ → Cognito 認証 → JWT トークン取得
2. ブラウザ → `/api/copilotkit` に Bearer トークン付きリクエスト
3. API Route → Cognito トークンの存在を確認（ユーザー認証ゲート）
4. API Route → コンピューティングロールの IAM 権限で SigV4 署名
5. API Route → AgentCore Runtime に署名済みリクエスト送信

---

## 1. Amplify Hosting（フロントエンド）

### 初回接続

1. AWS コンソールで Amplify を開く
2. 「新しいアプリ」→「GitHub」を選択
3. リポジトリとブランチを選択
4. ビルド設定を確認（`amplify.yml` が自動検出されます）
5. デプロイ

デプロイ完了後、以下のリソースが自動作成されます:
- Cognito User Pool（ユーザー認証）
- AppSync API + DynamoDB（データ）
- SSR Lambda + コンピューティングロール（Next.js サーバーサイド実行）

### ブランチ別デプロイ

| ブランチ | 環境 |
|---------|------|
| `main` | 本番 |
| `develop` | ステージング（任意） |

### CI/CD の流れ

```
Push → GitHub Actions（lint / 型チェック）→ Amplify Hosting（ビルド / デプロイ）
```

---

## 2. AgentCore Runtime（エージェント、任意）

エージェント機能を使う場合のみ必要です。

### 前提条件

- AgentCore CLI がインストール済み
  ```bash
  npm install -g @aws/agentcore
  ```
- AWS 認証情報が設定済み
- Docker が起動している（Container ビルドのため）

### 2-1. デプロイ

```bash
cd agents
agentcore deploy
```

初回は CDK の bootstrap とインフラ構築で数分かかります。

### 2-2. Runtime ARN の確認

デプロイ完了後、`agentcore status` で Runtime ARN を確認します:

```bash
agentcore status
```

出力例:

```
AgentCore Status (target: default, us-west-2)
Agents
  MyAgent: Deployed - Runtime: READY (arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/agents_MyAgent-xxxxxxxxxx)
  URL: https://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/...
```

`arn:aws:bedrock-agentcore:...` の部分が Runtime ARN です。手順 4 で環境変数に設定するので控えてください。

### 2-3. 動作確認

```bash
agentcore invoke
```

対話 UI でエージェントを選択し、テストメッセージを送信して動作確認します。

---

## 3. コンピューティングロールに AgentCore 呼び出し権限を追加

Amplify Hosting の SSR Lambda（API Route）から AgentCore Runtime を呼び出すため、コンピューティングロールに IAM ポリシーをアタッチします。

### 3-1. コンピューティングロールの設定

Amplify Hosting のデプロイ直後はコンピューティングロールが未設定です。手動で設定する必要があります。

1. Amplify コンソール → アプリ → 「ホスティング」→「コンピューティング」を開く
2. デフォルトのロールを選択する（未作成の場合は事前に作成が必要）

**ロールが未作成の場合（AWS CLI で作成）:**

```bash
# 信頼ポリシーを指定してロールを作成
aws iam create-role \
  --role-name amplify-compute-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": "amplify.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }]
  }'

# SSR Lambda の基本実行権限をアタッチ
aws iam attach-role-policy \
  --role-name amplify-compute-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

作成後、Amplify コンソールの「コンピューティング」画面で `amplify-compute-role` を選択してください。

### 3-2. IAM ポリシーの作成

以下のポリシーを作成します:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "bedrock-agentcore:InvokeAgentRuntime",
      "Resource": "arn:aws:bedrock-agentcore:us-west-2:<ACCOUNT_ID>:runtime/*"
    }
  ]
}
```

**より厳密にする場合**（特定の Runtime のみ許可）:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "bedrock-agentcore:InvokeAgentRuntime",
      "Resource": "arn:aws:bedrock-agentcore:us-west-2:<ACCOUNT_ID>:runtime/sample_agent-*"
    }
  ]
}
```

### 3-3. ポリシーのアタッチ

**AWS コンソールの場合:**

1. IAM コンソール → ロール → `amplify-compute-role` で検索
2. 「許可を追加」→「インラインポリシーを作成」
3. JSON エディタに上記ポリシーを貼り付け
4. ポリシー名: `AgentCoreInvokePolicy`

**AWS CLI の場合:**

> `<ACCOUNT_ID>` は自分の AWS アカウント ID（12桁の数字）に置き換えてください。

```bash
# ポリシーを作成
aws iam create-policy \
  --policy-name AgentCoreInvokePolicy \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": "bedrock-agentcore:InvokeAgentRuntime",
      "Resource": "arn:aws:bedrock-agentcore:us-west-2:<ACCOUNT_ID>:runtime/*"
    }]
  }'

# コンピューティングロールにアタッチ
aws iam attach-role-policy \
  --role-name amplify-compute-role \
  --policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/AgentCoreInvokePolicy
```

---

## 4. 環境変数の設定

Amplify コンソール → アプリ → ホスティング → 環境変数:

| キー | 値 | 説明 |
|------|-----|------|
| `NEXT_PUBLIC_AGENTCORE_RUNTIME_ARN` | 手順 2-2 で取得した ARN | AgentCore Runtime の識別子 |

設定後、再デプロイ（Amplify コンソールで「再ビルド」をトリガー、または Git push）が必要です。

---

## 5. 動作確認

再デプロイ完了後:

1. Amplify Hosting の URL にアクセス
2. Cognito でログイン
3. `/sample` ページのエージェントチャットでメッセージを送信
4. AG-UI ストリーミングで応答が表示されれば成功

### トラブルシューティング

| 症状 | 原因 | 対処 |
|------|------|------|
| 「AgentCore Runtime が設定されていません」 | 環境変数未設定 | 手順 4 を確認 |
| 401 Unauthorized | Cognito 未ログイン | ログイン画面でサインイン |
| 500 Internal Server Error | コンピューティングロールの権限不足 | 手順 3 を確認 |
| タイムアウト | AgentCore Runtime 未デプロイ | 手順 2 を確認 |
| `SignatureDoesNotMatch` | リージョン不一致 | API Route の `REGION` 定数と Runtime のリージョンを確認 |

CloudWatch Logs で詳細を確認:
- Amplify SSR Lambda のログ: `/aws/amplify/<app-id>/<branch>/compute`
- AgentCore Runtime のログ: `agentcore logs`

---

## 6. プログラム更新時のデプロイ

### フロントエンドの更新

```bash
git push origin <ブランチ名>
```

Amplify Hosting が Git push を検知して自動ビルド・デプロイします。

### エージェントの更新

```bash
cd agents
agentcore deploy
```

### 両方を更新する場合

エージェント側を先にデプロイしてください。

1. `cd agents && agentcore deploy`
2. `git push` でフロントエンドをデプロイ

---

## 7. エージェントの追加

新しいエージェントを追加する場合:

```bash
cd agents
agentcore add agent
```

追加後、`agentcore.json` に新しい Runtime エントリが追加されます。API Route の `agents` オブジェクトにも対応する HttpAgent を追加してください。

---

## 8. お片付け（リソース削除）

### 削除順序

1. **AgentCore Runtime** → 2. **Amplify Hosting** → 3. **IAM ポリシー** → 4. **sandbox**

### AgentCore Runtime の削除

```bash
cd agents
agentcore remove all --yes && agentcore deploy
```

### Amplify Hosting の削除

1. AWS コンソール → Amplify → アプリを選択
2. 「アプリの設定」→「全般」→「アプリを削除」

### IAM ポリシーの削除

```bash
# ロールからデタッチ
aws iam detach-role-policy \
  --role-name amplify-compute-role \
  --policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/AgentCoreInvokePolicy

# ポリシー削除
aws iam delete-policy \
  --policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/AgentCoreInvokePolicy
```

### sandbox の停止

```bash
npx ampx sandbox delete
```

---

## 注意事項

- 環境変数は Amplify コンソールで設定してください（シークレットをリポジトリにコミットしない）
- Amplify のビルド環境は Docker 非対応のため、AgentCore Runtime を Amplify の CDK スタックに含めない
- sandbox の Cognito と Amplify Hosting の Cognito は異なるため、sandbox 環境でのエージェント結合テストは不可
- 結合テストは Amplify Hosting のデプロイ環境（develop ブランチ推奨）で行う
- コンピューティングロールは Amplify が管理するため、ロール自体を削除しないこと
