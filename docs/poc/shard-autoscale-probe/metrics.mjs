// metrics.mjs — CloudWatch から各段(stage)の計測値を採取する（要件 4.1, 4.2）。
//
// 取得メトリクス（Namespace=AWS/Lambda, Dimension FunctionName）:
//   - IteratorAge        : Maximum と Average（滞留遅延 = GetRecords.IteratorAgeMilliseconds）
//   - ConcurrentExecutions : Maximum（S×P の理論上限と対比）
//
// メトリクス名の注意: イベントソース由来の IteratorAge は CloudWatch 上では
//   短縮名 `IteratorAge`（Namespace AWS/Lambda）で発行される。コンソール表示の
//   「GetRecords.IteratorAgeMilliseconds」と同一指標（単位ミリ秒）。
//
// 取得方式: CloudWatch GetMetricData, period=60s, ウィンドウ [t0, t1]。
//   （@aws-sdk/client-cloudwatch を増やさないため AWS CLI にシェルアウトする。
//     CLI は実行環境に存在。認証情報は環境の AWS 資格情報を使用=ハードコードしない。）
//
// 出力: 1 段につき 1 行。段・目標・実効・S・IteratorAge(Max/Avg)・Concurrency(Max) を整形。
//   引数で段のメタ情報(stage/target/effective/shards)も渡せる（run.sh から呼ぶ想定）。
//   単体でも [t0,t1] を与えれば採取できる。
//
// 使い方（単体）:
//   node tmp/shard-autoscale-probe/metrics.mjs \
//     --function shard-autoscale-probe-consumer --region us-west-2 \
//     --t0 2026-10-02T23:40:00Z --t1 2026-10-02T23:46:00Z \
//     --stage 1 --target 2000 --effective 1900 --shards 4
//
// 使い方（JSON 行で出力し run.sh から集計に回す）:
//   ... --json

import { execFileSync } from "node:child_process";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const FUNCTION = arg("function", "shard-autoscale-probe-consumer");
const REGION = arg("region", "us-west-2");
const PERIOD = parseInt(arg("period", "60"), 10); // 秒
const AS_JSON = hasFlag("json");

// ウィンドウ: 明示指定が無ければ「直近 10 分」をデフォルトにする（sanity 用途）。
const now = Date.now();
const T1 = arg("t1", new Date(now).toISOString());
const T0 = arg("t0", new Date(now - 10 * 60 * 1000).toISOString());

// 段メタ（任意）
const STAGE = arg("stage", "-");
const TARGET = arg("target", "-");
const EFFECTIVE = arg("effective", "-");
const SHARDS = arg("shards", "-");

// GetMetricData のクエリ定義。IteratorAge は Max と Avg、Concurrency は Max。
const queries = [
  {
    Id: "iterAgeMax",
    MetricStat: {
      Metric: {
        Namespace: "AWS/Lambda",
        MetricName: "IteratorAge",
        Dimensions: [{ Name: "FunctionName", Value: FUNCTION }],
      },
      Period: PERIOD,
      Stat: "Maximum",
    },
    ReturnData: true,
  },
  {
    Id: "iterAgeAvg",
    MetricStat: {
      Metric: {
        Namespace: "AWS/Lambda",
        MetricName: "IteratorAge",
        Dimensions: [{ Name: "FunctionName", Value: FUNCTION }],
      },
      Period: PERIOD,
      Stat: "Average",
    },
    ReturnData: true,
  },
  {
    Id: "concMax",
    MetricStat: {
      Metric: {
        Namespace: "AWS/Lambda",
        MetricName: "ConcurrentExecutions",
        Dimensions: [{ Name: "FunctionName", Value: FUNCTION }],
      },
      Period: PERIOD,
      Stat: "Maximum",
    },
    ReturnData: true,
  },
];

function getMetricData() {
  const out = execFileSync(
    "aws",
    [
      "cloudwatch",
      "get-metric-data",
      "--region",
      REGION,
      "--start-time",
      T0,
      "--end-time",
      T1,
      "--metric-data-queries",
      JSON.stringify(queries),
      "--output",
      "json",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  return JSON.parse(out);
}

// 系列の値配列から代表値を取り出す。Max 系は最大、Avg 系は平均。
function reduceSeries(results, id, mode) {
  const r = (results || []).find((x) => x.Id === id);
  const vals = (r && r.Values) || [];
  if (vals.length === 0) return null;
  if (mode === "max") return Math.max(...vals);
  if (mode === "avg") return vals.reduce((a, b) => a + b, 0) / vals.length;
  return null;
}

const resp = getMetricData();
const results = resp.MetricDataResults || [];

const iterAgeMaxMs = reduceSeries(results, "iterAgeMax", "max");
const iterAgeAvgMs = reduceSeries(results, "iterAgeAvg", "avg");
const concurrentExecMax = reduceSeries(results, "concMax", "max");

// どのメトリクスが「出た」か（sanity 判定に使う）
const appeared = {
  iteratorAge: iterAgeMaxMs != null,
  concurrentExecutions: concurrentExecMax != null,
};

const row = {
  stage: STAGE,
  targetRate: TARGET,
  effectiveRate: EFFECTIVE,
  openShards: SHARDS,
  iteratorAgeMaxMs: iterAgeMaxMs,
  iteratorAgeAvgMs: iterAgeAvgMs,
  concurrentExecMax,
  t0: T0,
  t1: T1,
  appeared,
};

if (AS_JSON) {
  console.log(JSON.stringify(row));
} else {
  const f = (v) => (v == null ? "n/a" : typeof v === "number" ? v.toFixed(1) : v);
  console.log(
    `stage=${row.stage} target=${row.targetRate} effective=${row.effectiveRate} ` +
      `S=${row.openShards} iterAgeMaxMs=${f(iterAgeMaxMs)} iterAgeAvgMs=${f(iterAgeAvgMs)} ` +
      `concMax=${f(concurrentExecMax)} window=[${T0}..${T1}]`
  );
  console.log(
    `metrics appeared: IteratorAge=${appeared.iteratorAge} ConcurrentExecutions=${appeared.concurrentExecutions}`
  );
}
