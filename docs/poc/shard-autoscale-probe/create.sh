#!/usr/bin/env bash
# create.sh — shard-autoscale-probe 検証スタックを作成する（使い捨て）。
#
# 作成物（すべて `shard-autoscale-probe` 接頭辞 = PoC 本体から分離, Property 1）:
#   3.1 DynamoDB テーブル shard-autoscale-probe
#         PAY_PER_REQUEST / pk(S) HASH / GSI なし / Streams NEW_AND_OLD_IMAGES
#   3.2 IAM ロール shard-autoscale-probe-consumer-role（最小権限）
#         - DynamoDB Streams 読み取り(GetRecords/GetShardIterator/DescribeStream/ListStreams)
#           を当該テーブルの Stream に対してのみ許可
#         - AWSLambdaBasicExecutionRole（CloudWatch Logs 出力のみ）
#   3.3 Lambda shard-autoscale-probe-consumer（Node.js 20 / 128MB / timeout 60s / consumer.zip）
#   3.4 ESM（ParallelizationFactor=10 / BatchSize=1 / MaxBatchingWindow=0 / StartingPosition=LATEST）
#
# 冪等性: 既に存在するリソースは作り直さず再利用する（再実行可能）。
#
# 使い方: bash tmp/shard-autoscale-probe/create.sh

set -euo pipefail
# node / npm / aws CLI が PATH 上にあること（Node.js 20+ 推奨）。
# シェルによっては明示が要る場合、下記をアンコメントして自環境のパスを足す:
#   export PATH="$PATH:/opt/homebrew/bin:$HOME/.nvm/versions/node/<version>/bin"

REGION="${REGION:-us-west-2}"   # 必要なら環境変数 REGION で上書き可
# アカウント ID は呼び出し元の資格情報から取得（ハードコードしない）
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
TABLE="shard-autoscale-probe"
FUNC="shard-autoscale-probe-consumer"
ROLE="shard-autoscale-probe-consumer-role"
POLICY_NAME="shard-autoscale-probe-streams-read"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZIP="$HERE/consumer.zip"

echo "== create.sh region=$REGION account=$ACCOUNT_ID =="

# ---------------------------------------------------------------------------
# 3.1 DynamoDB テーブル
# ---------------------------------------------------------------------------
if aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1; then
  echo "[3.1] table $TABLE already exists; reuse"
else
  echo "[3.1] creating table $TABLE"
  aws dynamodb create-table \
    --table-name "$TABLE" \
    --attribute-definitions AttributeName=pk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --stream-specification StreamEnabled=true,StreamViewType=NEW_AND_OLD_IMAGES \
    --region "$REGION" >/dev/null
fi

echo "[3.1] waiting for table ACTIVE..."
aws dynamodb wait table-exists --table-name "$TABLE" --region "$REGION"

STREAM_ARN="$(aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" \
  --query 'Table.LatestStreamArn' --output text)"
echo "[3.1] STREAM_ARN=$STREAM_ARN"
echo "$STREAM_ARN" > "$HERE/.stream_arn"

# ---------------------------------------------------------------------------
# 3.2 IAM 実行ロール（最小権限）
# ---------------------------------------------------------------------------
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  echo "[3.2] role $ROLE already exists; reuse"
else
  echo "[3.2] creating role $ROLE"
  aws iam create-role \
    --role-name "$ROLE" \
    --assume-role-policy-document "$TRUST" \
    --description "shard-autoscale-probe consumer (throwaway)" >/dev/null
fi

# BasicExecution（CloudWatch Logs のみ）
aws iam attach-role-policy \
  --role-name "$ROLE" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null
echo "[3.2] attached AWSLambdaBasicExecutionRole"

# Streams 読み取り（当該テーブルの Stream のみ。ListStreams は Resource 制約不可のため * ）
STREAM_READ_POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "StreamRead",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetRecords",
        "dynamodb:GetShardIterator",
        "dynamodb:DescribeStream"
      ],
      "Resource": "arn:aws:dynamodb:${REGION}:${ACCOUNT_ID}:table/${TABLE}/stream/*"
    },
    {
      "Sid": "ListStreams",
      "Effect": "Allow",
      "Action": "dynamodb:ListStreams",
      "Resource": "*"
    }
  ]
}
JSON
)
aws iam put-role-policy \
  --role-name "$ROLE" \
  --policy-name "$POLICY_NAME" \
  --policy-document "$STREAM_READ_POLICY" >/dev/null
echo "[3.2] put inline policy $POLICY_NAME (least privilege streams read)"

ROLE_ARN="$(aws iam get-role --role-name "$ROLE" --query 'Role.Arn' --output text)"
echo "[3.2] ROLE_ARN=$ROLE_ARN"

# IAM ロールの伝播待ち（新規作成直後は Lambda 作成が失敗しうる）
echo "[3.2] waiting ~10s for IAM role propagation..."
sleep 10

# ---------------------------------------------------------------------------
# 3.3 Lambda 関数
# ---------------------------------------------------------------------------
if [ ! -f "$ZIP" ]; then
  echo "[3.3] consumer.zip が無いので consumer/index.mjs からビルドします"
  if [ ! -f "$HERE/consumer/index.mjs" ]; then
    echo "ERROR: $HERE/consumer/index.mjs not found" >&2
    exit 1
  fi
  ( cd "$HERE/consumer" && zip -X -q "$ZIP" index.mjs )
fi

if aws lambda get-function --function-name "$FUNC" --region "$REGION" >/dev/null 2>&1; then
  echo "[3.3] function $FUNC already exists; updating code"
  aws lambda update-function-code \
    --function-name "$FUNC" \
    --zip-file "fileb://$ZIP" \
    --region "$REGION" >/dev/null
else
  echo "[3.3] creating function $FUNC"
  # ロール伝播のレースに備え数回リトライ
  for attempt in 1 2 3 4 5; do
    if aws lambda create-function \
      --function-name "$FUNC" \
      --runtime nodejs20.x \
      --role "$ROLE_ARN" \
      --handler index.handler \
      --timeout 60 \
      --memory-size 128 \
      --zip-file "fileb://$ZIP" \
      --region "$REGION" >/dev/null 2>/tmp/lambda_create_err; then
      break
    fi
    echo "[3.3] create attempt $attempt failed; retry in 8s..."
    cat /tmp/lambda_create_err >&2 || true
    sleep 8
    if [ "$attempt" = "5" ]; then
      echo "ERROR: lambda create-function failed after retries" >&2
      exit 1
    fi
  done
fi

echo "[3.3] waiting for function Active..."
aws lambda wait function-active-v2 --function-name "$FUNC" --region "$REGION"
FUNC_ARN="$(aws lambda get-function --function-name "$FUNC" --region "$REGION" \
  --query 'Configuration.FunctionArn' --output text)"
echo "[3.3] FUNC_ARN=$FUNC_ARN"

# ---------------------------------------------------------------------------
# 3.4 イベントソースマッピング（ESM）
# ---------------------------------------------------------------------------
EXISTING_ESM="$(aws lambda list-event-source-mappings \
  --function-name "$FUNC" --region "$REGION" \
  --query "EventSourceMappings[?EventSourceArn=='${STREAM_ARN}'].UUID | [0]" \
  --output text 2>/dev/null || echo "None")"

if [ "$EXISTING_ESM" != "None" ] && [ -n "$EXISTING_ESM" ]; then
  echo "[3.4] ESM already exists UUID=$EXISTING_ESM; reuse"
  ESM_UUID="$EXISTING_ESM"
else
  echo "[3.4] creating ESM (P=10 / BatchSize=1 / MaxBatchingWindow=0 / LATEST)"
  ESM_UUID="$(aws lambda create-event-source-mapping \
    --function-name "$FUNC" \
    --event-source-arn "$STREAM_ARN" \
    --starting-position LATEST \
    --batch-size 1 \
    --maximum-batching-window-in-seconds 0 \
    --parallelization-factor 10 \
    --region "$REGION" \
    --query 'UUID' --output text)"
fi
echo "[3.4] ESM_UUID=$ESM_UUID"
echo "$ESM_UUID" > "$HERE/.esm_uuid"

echo "[3.4] waiting for ESM Enabled..."
for i in $(seq 1 30); do
  STATE="$(aws lambda get-event-source-mapping --uuid "$ESM_UUID" --region "$REGION" \
    --query 'State' --output text)"
  PF="$(aws lambda get-event-source-mapping --uuid "$ESM_UUID" --region "$REGION" \
    --query 'ParallelizationFactor' --output text)"
  BS="$(aws lambda get-event-source-mapping --uuid "$ESM_UUID" --region "$REGION" \
    --query 'BatchSize' --output text)"
  echo "[3.4] state=$STATE P=$PF BatchSize=$BS"
  if [ "$STATE" = "Enabled" ]; then break; fi
  sleep 6
done

echo ""
echo "== create.sh DONE =="
echo "TABLE=$TABLE"
echo "STREAM_ARN=$STREAM_ARN"
echo "ROLE_ARN=$ROLE_ARN"
echo "FUNC_ARN=$FUNC_ARN"
echo "ESM_UUID=$ESM_UUID (P=10, BatchSize=1, LATEST)"
