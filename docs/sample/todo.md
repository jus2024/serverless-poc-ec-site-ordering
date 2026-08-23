# Todo リスト

サンプルページの上部に配置された Amplify Data との CRUD 連携デモです。

## 概要

`/sample` にアクセスすると表示される Todo リストは、Amplify Gen 2 の Data 機能（AppSync + DynamoDB）を使ったリアルタイム CRUD のサンプルです。`observeQuery` によるリアルタイム購読で、データ変更が即座に UI に反映されます。

## データモデル

`amplify/data/resource.ts` で定義:

```typescript
Todo: a.model({
  content: a.string(),
  isDone: a.boolean().default(false),
}).authorization((allow) => [allow.publicApiKey()])
```

| フィールド | 型 | 説明 |
|-----------|------|------|
| `id` | string | 自動生成（Amplify 管理） |
| `content` | string | Todo の内容 |
| `isDone` | boolean | 完了フラグ（デフォルト: false） |

認可モードは `apiKey`（開発用）です。本番環境では認証方式を見直してください。

## 機能

| 操作 | API | 説明 |
|------|-----|------|
| 一覧表示 | `observeQuery()` | リアルタイム購読で自動更新 |
| 追加 | `Todo.create()` | テキスト入力 → 追加ボタン |
| 完了切替 | `Todo.update()` | チェックボックスで `isDone` をトグル |
| 削除 | `Todo.delete()` | 削除ボタンで即時削除 |

## 関連ファイル

| ファイル | 役割 |
|---------|------|
| `src/app/sample/page.tsx` | ページコンポーネント（Todo + エージェントチャット） |
| `src/app/sample/sample.module.css` | スタイル定義 |
| `amplify/data/resource.ts` | データモデル定義 |

## 前提条件

- Amplify sandbox が起動していること（`npx ampx sandbox`）
- sandbox 未起動時は「Amplify バックエンドに接続できません」エラーが表示されます

## カスタマイズ

Todo モデルはサンプルです。プロジェクトに合わせて `amplify/data/resource.ts` のスキーマを編集し、`page.tsx` の UI を置き換えてください。