# Kiro の使い方

## 概要

このテンプレートには Kiro のワークスペース設定が含まれています。
Kiro でリポジトリを開くと、steering と skills が自動的に読み込まれます。

## MCP サーバー（Agent Toolkit for AWS）

`.kiro/settings/mcp.json` で [Agent Toolkit for AWS](https://github.com/aws/agent-toolkit-for-aws) の MCP サーバーが設定されています。以下の機能が利用できます:

- AWS ドキュメント検索（`search_documentation`）
- Agent Skills のオンデマンド検索・取得（`retrieve_skill`）
- AWS CLI コマンド実行（`call_aws`）
- Python スクリプト実行（`run_script`）
- リージョン別サービス可用性の確認

AWS の汎用スキルはローカルにインストールせず、MCP サーバー経由でオンデマンド検索されます。

## Steering（方針ガイド）

`.kiro/steering/` に配置された方針ファイルが、Kiro の動作を案内します。

| ファイル | 内容 | 適用条件 |
|---------|------|---------|
| `product.md` | プロダクト方針 | 常時 |
| `tech.md` | 技術方針 | 常時 |
| `structure.md` | リポジトリ構成 | 常時 |
| `security.md` | セキュリティ方針 | 常時 |
| `repo-workflow.md` | ワークフロー方針 | 常時 |
| `testing.md` | テスト方針 | 常時 |
| `amplify-backend.md` | バックエンド方針 | `amplify/` 編集時 |
| `amplify-frontend.md` | フロントエンド方針 | `src/` 編集時 |
| `strands-agent.md` | エージェント方針 | `agents/` 編集時 |
| `github-actions.md` | CI/CD 方針 | `.github/workflows/` 編集時 |

## Skills（作業手順）

`.kiro/skills/` に配置されたスキルは、繰り返し使う作業手順を定義しています。

| スキル | 用途 |
|-------|------|
| `amplify-feature` | Amplify ベースの業務機能の実装・更新 |
| `pr-deploy-readiness` | PR サマリーとデプロイ準備レビュー |
| `strands-agent-implementation` | エージェントコードの実装・更新 |
| `mcp-tool-onboarding` | MCP 機能の導入評価 |

## カスタマイズ

プロジェクト固有の方針やスキルを追加する場合は、同じディレクトリに新しいファイルを作成してください。
