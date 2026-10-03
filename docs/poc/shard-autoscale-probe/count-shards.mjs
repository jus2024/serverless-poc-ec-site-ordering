// オープンシャード数 S(= EndingSequenceNumber が null のシャード)を
// ページングしながら計数する。warm throughput の Status も併記する。
//
// 使い方（リポジトリルートから node_modules を解決して実行）:
//   node docs/poc/shard-autoscale-probe/count-shards.mjs --table shard-autoscale-probe --region us-west-2

import { DynamoDBClient, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBStreamsClient, DescribeStreamCommand } from "@aws-sdk/client-dynamodb-streams";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const TABLE = arg("table", "shard-autoscale-probe");
const REGION = arg("region", "us-west-2");

const ddb = new DynamoDBClient({ region: REGION });
const streams = new DynamoDBStreamsClient({ region: REGION });

const dt = await ddb.send(new DescribeTableCommand({ TableName: TABLE }));
const t = dt.Table;
const arn = t.LatestStreamArn;
const warm = t.WarmThroughput || {};
console.log(
  `table=${TABLE} warm=${warm.WriteUnitsPerSecond}w/${warm.ReadUnitsPerSecond}r status=${warm.Status} ` +
    `size=${t.TableSizeBytes}B items=${t.ItemCount}`
);
if (!arn) { console.log("no stream arn"); process.exit(0); }

let open = 0, total = 0, lastId;
do {
  const res = await streams.send(
    new DescribeStreamCommand({ StreamArn: arn, ExclusiveStartShardId: lastId })
  );
  const sd = res.StreamDescription;
  for (const s of sd.Shards) {
    total++;
    if (s.SequenceNumberRange && s.SequenceNumberRange.EndingSequenceNumber == null) open++;
  }
  lastId = sd.LastEvaluatedShardId;
} while (lastId);

console.log(`OPEN_SHARDS=${open} TOTAL_SHARDS=${total}`);
