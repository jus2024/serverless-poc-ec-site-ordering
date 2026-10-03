#!/usr/bin/env bash
# teardown.sh — shard-autoscale-probe 検証スタックを削除し課金源をゼロにする（Property 5）。
#
# 削除順: ESM → Lambda → IAM ロール(インライン/アタッチ剥がし) → DynamoDB テーブル。
# 冪等: 存在しないリソースはスキップする。最後に残存ゼロをリスト照会で確認する。
#
# 使い方: bash tmp/shard-autoscale-probe/teardown.sh

set -uo pipefail
# node / npm / aws CLI が PATH 上にあること（Node.js 20+ 推奨）。

REGION="${REGION:-us-west-2}"
TABLE="shard-autoscale-probe"
FUNC="shard-autoscale-probe-consumer"
ROLE="shard-autoscale-probe-consumer-role"
POLICY_NAME="shard-autoscale-probe-streams-read"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== teardown.sh region=$REGION =="

# ---------------------------------------------------------------------------
# 1. ESM 削除（この関数に紐づく全 ESM）
# ---------------------------------------------------------------------------
UUIDS="$(aws lambda list-event-source-mappings --function-name "$FUNC" --region "$REGION" \
  --query 'EventSourceMappings[].UUID' --output text 2>/dev/null || echo "")"
if [ -n "$UUIDS" ] && [ "$UUIDS" != "None" ]; then
  for u in $UUIDS; do
    echo "[1] deleting ESM $u"
    aws lambda delete-event-source-mapping --uuid "$u" --region "$REGION" >/dev/null 2>&1 || true
  done
  # ESM の削除完了を少し待つ
  echo "[1] waiting for ESM deletion..."
  sleep 10
else
  echo "[1] no ESM found; skip"
fi

# ---------------------------------------------------------------------------
# 2. Lambda 削除
# ---------------------------------------------------------------------------
if aws lambda get-function --function-name "$FUNC" --region "$REGION" >/dev/null 2>&1; then
  echo "[2] deleting function $FUNC"
  aws lambda delete-function --function-name "$FUNC" --region "$REGION" >/dev/null 2>&1 || true
else
  echo "[2] function not found; skip"
fi

# ---------------------------------------------------------------------------
# 3. IAM ロール削除（インラインポリシー削除 + アタッチ剥がし → ロール削除）
# ---------------------------------------------------------------------------
if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  echo "[3] detaching managed policies"
  aws iam detach-role-policy --role-name "$ROLE" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null 2>&1 || true
  echo "[3] deleting inline policy $POLICY_NAME"
  aws iam delete-role-policy --role-name "$ROLE" --policy-name "$POLICY_NAME" >/dev/null 2>&1 || true
  echo "[3] deleting role $ROLE"
  aws iam delete-role --role-name "$ROLE" >/dev/null 2>&1 || true
else
  echo "[3] role not found; skip"
fi

# ---------------------------------------------------------------------------
# 4. DynamoDB テーブル削除（warm は不可逆のため必ず削除。要件 5.2）
# ---------------------------------------------------------------------------
if aws dynamodb describe-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1; then
  echo "[4] deleting table $TABLE"
  aws dynamodb delete-table --table-name "$TABLE" --region "$REGION" >/dev/null 2>&1 || true
  echo "[4] waiting for table deletion..."
  aws dynamodb wait table-not-exists --table-name "$TABLE" --region "$REGION" || true
else
  echo "[4] table not found; skip"
fi

# 状態ファイルの掃除
rm -f "$HERE/.stream_arn" "$HERE/.esm_uuid" 2>/dev/null || true

# ---------------------------------------------------------------------------
# 5. 残存ゼロ確認
# ---------------------------------------------------------------------------
echo ""
echo "== residual check =="
TBL_LEFT="$(aws dynamodb list-tables --region "$REGION" \
  --query "TableNames[?@=='${TABLE}']" --output text 2>/dev/null || echo "")"
echo "table residual: ${TBL_LEFT:-<none>}"

FN_LEFT="$(aws lambda get-function --function-name "$FUNC" --region "$REGION" \
  --query 'Configuration.FunctionArn' --output text 2>/dev/null || echo "")"
echo "function residual: ${FN_LEFT:-<none>}"

ROLE_LEFT="$(aws iam get-role --role-name "$ROLE" --query 'Role.Arn' --output text 2>/dev/null || echo "")"
echo "role residual: ${ROLE_LEFT:-<none>}"

echo ""
if [ -z "$TBL_LEFT" ] && [ -z "$FN_LEFT" ] && [ -z "$ROLE_LEFT" ]; then
  echo "== teardown.sh DONE: all residual zero =="
else
  echo "== teardown.sh WARNING: some resources may still exist (re-run) =="
fi
