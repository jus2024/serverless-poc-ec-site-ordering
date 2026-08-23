---
name: strands-agent-implementation
description: agents/ 配下の Strands エージェントコードを実装・更新する。新規エージェント作成、ツール追加、AG-UI サーバー定義、ローカルスモークテストの準備時に使用する。
---

## 目的

- エージェントをモジュール化する
- ツールを明示的に定義する
- ローカル実行を簡単に保つ（`run_local.py` または `agentcore dev`）
- AG-UI プロトコルに準拠した FastAPI サーバーとして実装する
- フロントエンドとの接続は CopilotKit + AG-UI プロトコル経由とする

## ワークフロー

1. エージェントの目的を明確にする
2. 設定、プロンプト、ツール、ランタイムロジックを分離する
3. まず小さな実行可能サンプルを作成する
4. 有用な箇所にログを追加する
5. 隠れた副作用を避ける
6. ローカルでの実行方法を説明する（`run_local.py` または `agentcore dev` で確認）
7. AG-UI サーバーを定義する（FastAPI + `ag-ui-strands` の `StrandsAgent`）
8. Strands Agents SDK の実装は Power（strands）で最新ドキュメントを確認してから着手する
9. AgentCore Runtime の設定・デプロイは Power（aws-agentcore）で最新ドキュメントを確認する

## AG-UI サーバーの構成

- FastAPI + uvicorn で `/invocations`（POST）と `/ping`（GET）を公開する
- `ag-ui-strands` の `StrandsAgent` で Strands Agent を AG-UI 対応にラップする
- `RunAgentInput` を受け取り、AG-UI イベントストリームを返す
- AgentCore Runtime にデプロイ時は `--protocol AGUI` を指定する

## AgentCore CLI の規約

- エージェントコードは `agents/app/<agent_name>/` に配置する
- エントリーポイントは `main.py`（FastAPI app）
- 各エージェントに `pyproject.toml` を配置する
- AgentCore CLI の設定は `agents/agentcore/agentcore.json` で管理する
- ローカル開発は `agentcore dev`、デプロイは `agentcore deploy`

## デプロイの注意

- Amplify Hosting と AgentCore Runtime は別々にデプロイする
- `agents/` 内に Web UI 層を含めない
- Lambda や API Route でエージェントをラップしない

## 出力の期待事項

- ファイル構成の提示
- ツールの責務の説明
- AG-UI サーバーの構成説明
- 最小限のローカル検証手順
- AgentCore Runtime へのデプロイ手順（該当する場合）
