// E2: 高レートバースト書き込みで DynamoDB のパーティション分割を積み上げ、
// オープンシャード数 S が warm 単独の値(E1)からさらに増えるかを検証する使い捨てスクリプト。
//
// 使い方（リポジトリルートから実行）:
//   node docs/poc/shard-autoscale-probe/e2-burst.mjs \
//     --table shard-autoscale-probe --region us-west-2 \
//     --rounds 6 --round-items 50000 --concurrency 40 \
//     --item-bytes 1024 --round-gap-ms 20000
//
// 注意:
//   - キーは乱数プレフィックス + ULID で全キースペースに分散(ホットパーティション回避)。
//   - PAY_PER_REQUEST なので投入分の WCU 課金が発生する(件数×サイズに比例)。
//   - 検証用テーブル専用。アプリのテーブルには向けないこと。

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { randomBytes } from "node:crypto";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const TABLE = arg("table", "shard-autoscale-probe");
const REGION = arg("region", "us-west-2");
const ROUNDS = parseInt(arg("rounds", "6"), 10);
const ROUND_ITEMS = parseInt(arg("round-items", "50000"), 10);
const CONCURRENCY = parseInt(arg("concurrency", "40"), 10);
const ITEM_BYTES = parseInt(arg("item-bytes", "1024"), 10);
const ROUND_GAP_MS = parseInt(arg("round-gap-ms", "20000"), 10);

const BATCH = 25; // BatchWriteItem の上限

const base = new DynamoDBClient({ region: REGION, maxAttempts: 10 });
const doc = DynamoDBDocumentClient.from(base, {
  marshallOptions: { removeUndefinedValues: true },
});

// 固定サイズのダミーペイロード(1アイテムあたり ITEM_BYTES 程度)
const PAD = "x".repeat(Math.max(0, ITEM_BYTES - 64));

function makeItem() {
  // 乱数4バイト(=8hex)を先頭に置き、ULID と連結してキーを全空間に散らす
  const prefix = randomBytes(4).toString("hex");
  return { pk: `${prefix}-${ulid()}`, payload: PAD, ts: Date.now() };
}

async function writeBatch() {
  const items = [];
  for (let i = 0; i < BATCH; i++) items.push({ PutRequest: { Item: makeItem() } });
  let req = { [TABLE]: items };
  // UnprocessedItems を使い切るまでリトライ
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = await doc.send(new BatchWriteCommand({ RequestItems: req }));
    const un = res.UnprocessedItems && res.UnprocessedItems[TABLE];
    if (!un || un.length === 0) return BATCH;
    req = { [TABLE]: un };
    await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
  }
  return BATCH; // 最善努力
}

async function runRound(roundIdx) {
  const target = ROUND_ITEMS;
  let written = 0;
  const start = Date.now();
  // CONCURRENCY 本のワーカーが、合計 target 件に達するまで BatchWrite を回し続ける
  let remainingBatches = Math.ceil(target / BATCH);
  async function worker() {
    while (true) {
      if (remainingBatches <= 0) return;
      remainingBatches--;
      const n = await writeBatch();
      written += n;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const sec = (Date.now() - start) / 1000;
  console.log(
    `[round ${roundIdx + 1}/${ROUNDS}] wrote=${written} in ${sec.toFixed(1)}s ` +
      `rate=${Math.round(written / sec)}/s (~${Math.round((written * ITEM_BYTES) / sec / 1024)} KB/s)`
  );
}

(async () => {
  console.log(
    `E2 burst -> table=${TABLE} region=${REGION} rounds=${ROUNDS} ` +
      `roundItems=${ROUND_ITEMS} conc=${CONCURRENCY} itemBytes=${ITEM_BYTES} gap=${ROUND_GAP_MS}ms`
  );
  for (let r = 0; r < ROUNDS; r++) {
    await runRound(r);
    if (r < ROUNDS - 1) await new Promise((res) => setTimeout(res, ROUND_GAP_MS));
  }
  console.log("E2 burst done. Now re-count open shards (allow a few minutes for splits).");
})();
