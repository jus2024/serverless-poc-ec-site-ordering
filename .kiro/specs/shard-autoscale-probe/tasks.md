# Implementation Plan: シャード自動拡張プローブ

## Overview

使い捨ての検証装置を `tmp/shard-autoscale-probe/`（git 管理外）に実装し、6 段の漸増負荷で
S の成長カーブと各段 IteratorAge を実測する。PoC 本体（`amplify/` `src/` `agents/`）には触れない。
コスト発生操作（タスク 6 の run）の前に概算を提示しユーザー判断を仰ぐ。全体 30 分・各段 5 分、
終了後ただちに teardown して課金を止める。

## Task Dependency Graph

```
1 (dir/assets)
2 (sleep Lambda handler)
   \
3.1 table ──> 3.2 IAM ──> 3.3 Lambda ──> 3.4 ESM
                                           |
                                           v
                        4 (sanity: S=4, metrics 出る)
                                           |
            5 (metrics.mjs) ───────────────┤
                                           v
                        6.1 ─> 6.2 ─> 6.3  (run: ★コスト)
                                           |
                                           v
                                   7 (分析/カーブ)
                                           |
                                           v
                                   8 (teardown: 課金停止)
                                           |
                                           v
                                   9 (記録 docs/poc + README)
```

依存の要点:
- 2 は 3.3 までに完成していればよい（1 と並行可）。
- 3.1→3.2→3.3→3.4 は直列。4(sanity) は 3.4 完了後。
- 5(metrics.mjs) は 6 までに完成していればよい（4 と並行可）。
- 6 はコスト発生。6 の前に概算提示 → ユーザー判断。
- 8(teardown) は 7 の採取完了後すぐ。9 は最後。

以下は並列実行の波（wave）定義。同一 wave 内のタスクは並行可能。

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1", "2", "3.1"] },
    { "wave": 2, "tasks": ["3.2", "5"] },
    { "wave": 3, "tasks": ["3.3"] },
    { "wave": 4, "tasks": ["3.4"] },
    { "wave": 5, "tasks": ["4"] },
    { "wave": 6, "tasks": ["6.1"] },
    { "wave": 7, "tasks": ["6.2"] },
    { "wave": 8, "tasks": ["6.3"] },
    { "wave": 9, "tasks": ["7"] },
    { "wave": 10, "tasks": ["8"] },
    { "wave": 11, "tasks": ["9"] }
  ]
}
```


## Tasks

---

- [x] 1. 作業ディレクトリとドライバ資産の配置
  - `tmp/shard-autoscale-probe/` を作成（`.gitignore` の `tmp/` で管理外を確認）
  - 既存 `tmp/shard-probe/` の `e2-burst.mjs` / `overload.mjs` / `count-shards.mjs` をコピーし、
    テーブル名を引数で受けられることを確認（既に対応済なら流用）
  - _要件: 1.6, 2.5, 6.2_

- [x] 2. sleep Lambda ハンドラの実装
  - `consumer/index.mjs`: DynamoDB Streams イベントを受け、各レコードごとに `await sleep(3000)`
  - `BatchSize=1` 前提で 1 呼び出し=1 レコード=3.0 秒になることをコードコメントで明示
  - zip 化（依存なし、標準のみ）
  - _要件: 1.3, 4.5_（Property 2）

- [x] 3. create.sh — 検証スタック作成
- [x] 3.1 DynamoDB テーブル作成（PAY_PER_REQUEST / pk:S / GSI なし / Streams NEW_AND_OLD_IMAGES）
  - ACTIVE 待ち。StreamArn を控える
  - _要件: 1.1_
- [x] 3.2 IAM 実行ロール作成（最小権限: Stream 読み取り + BasicExecution ログ）
  - _要件: 1.4, NFR-セキュリティ_
- [x] 3.3 Lambda 関数作成（Node.js 20 / 128MB / timeout 60s / consumer zip）
  - _要件: 1.3_
- [x] 3.4 ESM 作成（ParallelizationFactor=10 / BatchSize=1 / MaxBatchingWindow=0 / StartingPosition=LATEST）
  - 有効化（Enabled）を確認
  - _要件: 1.4, 2.3_（Property 3）

- [x] 4. sanity チェック（装置の確からしさ）
  - create 直後に `count-shards` が **S=4 / warm 4,000** を返すことを確認
  - 少量投入（数百件）で Lambda が起動し、CloudWatch に `IteratorAgeMilliseconds` と
    `ConcurrentExecutions` が出ることを確認
  - PoC 本体リソースに触れていないこと（名前空間）を確認
  - _要件: 1.2, Testing Strategy_（Property 1）

- [x] 5. metrics.mjs — CloudWatch 採取スクリプト
  - `GetMetricData` で `AWS/Lambda` の `GetRecords.IteratorAgeMilliseconds`(Max/Avg) と
    `ConcurrentExecutions`(Max) を、指定ウィンドウ [t0,t1]・period=60s で取得
  - 段・目標・実効・S・IteratorAge・Concurrency を 1 行に整形出力
  - _要件: 4.1, 4.2_

- [x] 6. run.sh — 4 段の漸増負荷実行と採取（★コスト発生: 概算 $8〜15、事前提示しユーザー判断）
- [x] 6.1 段定義（2k→4k→8k→16k で打ち切り、procs 目安 1/1/2/3。各段は S 安定ゲート=S が3分変化なしで次へ・上限10分）
  - _要件: 2.1, 2.4, 3.3_
- [x] 6.2 各段ループ: t0 記録 → overload 投入継続 → count-shards を繰り返し **S が3分変化なし(上限10分)** を待つ → 実効レート/S 記録 → t1 記録 → metrics 採取 → 結果表に追記
  - _要件: 2.2, 3.1, 3.2, 4.1, 4.3, 4.4_（Property 4）
- [x] 6.3 S 増と投入ピークの時刻紐づけ（S が増えた段の t0 と増加観測時刻を対応づけ）
  - _要件: 3.5, 3.4_

- [x] 7. 結果の分析とカーブ化
  - `(実効到達ピーク write/s, S)` の対応表／カーブを作成
  - 4 段（〜16k）のカーブから **終点 S=64 を外挿**し、既知の Max と整合するか確認（Max は実測しない）
  - 各段の IteratorAge を `S×P÷D=S×3.33 行/s` の処理能力に対する超過度と対応づけ
  - _要件: 3.3, 3.4, 4.2, 4.3, 4.4_

- [ ] 8. teardown.sh — お片付け（課金停止）
  - ESM 削除 → Lambda 削除 → IAM ロール/ポリシー削除 → テーブル削除
  - 冪等（存在しないものはスキップ）。最後に `list-tables` / `list-event-source-mappings` /
    `get-function` で残存ゼロを確認
  - _要件: 5.1, 5.2, 5.3_（Property 5）

- [x] 9. 記録を docs/poc に追記
  - E1〜E6 と同じ記法（S/P/D・実測表・🟢/🔴）で結果を
    `docs/poc/shard-warm-throughput-experiment.md` の続き or 新規 `docs/poc/shard-autoscale-probe-results.md` にまとめる
  - README に create→run→teardown の 3 ステップを明示（要件 1.7）
  - E1〜E6 の結論との関係（S=64 への到達経路違い、1,000 多重は対象外）を明記
  - _要件: 6.1, 6.3, 6.4_

## Notes

- **コスト:** タスク 6(run) のみ従量課金が発生（DynamoDB write + Lambda）。実行前に概算を提示し
  ユーザー判断を仰ぐ（要件 5.4）。warm は不可逆のため、タスク 8(teardown) でテーブル削除必須（要件 5.2）。
- **分離:** 全リソースは `shard-autoscale-probe` 接頭辞。PoC 本体に触れない（Property 1）。
- **圧縮版の限界:** 各段 5 分の圧縮版のため「30 分以上の緩やか漸増」ではなく、段切替直後に
  スロットリングが混じりうる。実効レート低下として記録する（NFR）。
- **記録先:** `docs/poc/`。使い捨てスクリプトは `tmp/`（git 管理外）。
