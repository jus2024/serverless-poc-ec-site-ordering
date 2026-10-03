# shard-autoscale-probe — DynamoDB Streams シャード/同時実行の限界を実測する検証ツールキット

DynamoDB Streams のオープンシャード数 S・Lambda 同時実行・IteratorAge（滞留）の関係を、
使い捨ての最小スタック（テーブル + sleep Lambda + ESM）で実測するためのスクリプト群です。
実測結果は [../shard-autoscale-probe-results.md](../shard-autoscale-probe-results.md)（E1〜E11）、
背景は [../shard-warm-throughput-experiment.md](../shard-warm-throughput-experiment.md)（E1〜E6）にあります。

> **これは本番アプリ（`src/` `amplify/` `agents/`）とは完全に分離した使い捨て検証装置です。**
> 作成するリソースはすべて `shard-autoscale-probe` 接頭辞で、teardown で完全削除できます。

## 前提

- AWS 認証情報（検証用アカウント推奨。リソースを作成・削除します）
- `aws` CLI v2 / Node.js 20+
- **リポジトリルートの `node_modules`**（`.mjs` が `@aws-sdk/*` と `ulid` を import するため、
  リポジトリ直下で `npm ci` 済みであること。スクリプトはルートから実行する想定）
- リージョンは既定 `us-west-2`。環境変数 `REGION` で上書き可（例 `REGION=ap-northeast-1 bash create.sh`）

## コスト・安全上の注意（必読）

- **run 系スクリプトは DynamoDB のオンデマンド書き込み課金が発生します**（概算 $1〜10／実験による）。
- **warm throughput の引き上げは不可逆**です（下げられない）。負荷や warm-set で warm が上がったら、
  課金を止める唯一の方法は **テーブル削除（teardown）** です。**検証後は必ず `teardown.sh` を実行**してください。
- `teardown.sh` は ESM→Lambda→IAM ロール→テーブルを削除し、残存ゼロをリスト照会で確認します。

## 基本フロー

```bash
# リポジトリルートから実行（node_modules 解決のため）
bash docs/poc/shard-autoscale-probe/create.sh      # 1. 作成（テーブル+Lambda+IAM+ESM、consumer.zip 自動ビルド）
bash docs/poc/shard-autoscale-probe/run-e9.sh       # 2. 実験を実行（★従量課金。下表から選ぶ）
bash docs/poc/shard-autoscale-probe/teardown.sh     # 3. お片付け（課金停止・残存ゼロ確認）
```

## ファイル構成

| ファイル | 役割 |
|---|---|
| `create.sh` | 検証スタックを作成（テーブル PAY_PER_REQUEST / Streams、sleep Lambda、最小権限 IAM、ESM P=10・BatchSize=1・LATEST）。`consumer/index.mjs` から `consumer.zip` を自動ビルド。アカウント ID は呼び出し元の資格情報から取得 |
| `teardown.sh` | 全リソース削除・残存ゼロ確認 |
| `consumer/index.mjs` | sleep Lambda 本体。1 レコードを `D` ミリ秒 sleep して消費（`SLEEP_MS` で D を変更。E8 まで 3000、E9 以降 50） |
| `count-shards.mjs` | オープンシャード S をページングで計数（warm Status 併記） |
| `e2-burst.mjs` | 乱数キーで `BatchWriteItem` を多並列投入（全キースペースに分散） |
| `overload.mjs` | `e2-burst` を複数プロセス fork して合算レートを稼ぐ |
| `metrics.mjs` | CloudWatch から IteratorAge / ConcurrentExecutions を採取（period=60s 既定） |
| `conc-sample.mjs` | ConcurrentExecutions を高解像度（period=1s）で採取しピークを返す（E8 以降の同時実行測定用） |
| `drain-wait.mjs` | 投入停止後、IteratorAge が低位（floor）に戻る＝親シャード消化完了まで待つ |
| `poll-stable.sh` | S が一定時間変化しなくなるまでポーリング（run.sh の S 安定ゲート用） |

## 実験ランナーと対応するセクション

| スクリプト | 実験 | 消費者 D | 主な問い | 結果 |
|---|---|---|---|---|
| `run.sh` | E1〜E7（4 段 2k→16k・S 安定ゲート） | 3.0s | 負荷で S はどう育つか（成長カーブ） | results §7 |
| `run-e8.sh` | E8（滞留ゼロリセットの試行） | 3.0s | 滞留を消せば同時実行は S×P に伸びるか | results §8 |
| `run-e9.sh` | E9（緩やか倍々 2k→16k） | 50ms | 速い消費者での S 成長と同時実行の天井 | results §9 |
| `run-e9-gentle.sh` | E9 補足（低レート 470/935） | 50ms | 消化内なら滞留は秒オーダーで回るか | results §9.3 |
| `run-e11.sh` | E11（負荷育成→滞留ゼロ→バースト） | 50ms | 親シャード消化後に負荷育成 S でも S×P に届くか | results §11 |

> E10（warm-set で S=64 を作り同時実行を実測）は、`create.sh` 後に warm を直接
> `aws dynamodb update-table --warm-throughput WriteUnitsPerSecond=40000` で引き上げ、
> `drain-wait.mjs` と `conc-sample.mjs` を手順に沿って使って実測しました（results §10）。
> 専用ランナーは置かず、手動手順です（warm 引き上げの不可逆性を都度意識するため）。

## 消費者の処理時間 D を変える

`consumer/index.mjs` の `SLEEP_MS` を書き換えて `create.sh` を再実行すると、Lambda コードが更新されます。
- `SLEEP_MS = 3000` … E1〜E8（過負荷で S を観測する遅い消費者）
- `SLEEP_MS = 50` … E9〜E11（消化が追いつく現実的な速い消費者）

## 主要な結論（詳細は results.md）

- **S は warm throughput で決定論的に決まる**（負荷ピークでも warm を後天的に latch して同じ値に収束）。
- **同時実行の実力は「滞留ゼロなら ~S×P、滞留があると少数の同時消費シャード系列 × P で頭打ち」**。
  E8（D=3s, S=16, 滞留あり）~40、E9（D=50ms, S=18, 滞留あり）~81、
  E10（warm-set S=64, 滞留ゼロ）~600≈S×P、E11（負荷育成 S=20, 滞留ゼロ）199≈S×P。
- 律速は「S の作り方（warm-set か負荷育成か）」ではなく **「滞留の有無＝親シャードが消化済みか」**（E11 で分離）。
- 消化が追いつく緩やかな負荷なら IteratorAge は秒オーダーで安定し業務が回る（E9 補足）。
