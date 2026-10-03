// conc-sample.mjs — ConcurrentExecutions のピークを高解像度(period=1s)で採取する（E8 専用）。
//
// 背景（E7 §7.4 / E8 の計測注意）:
//   E7 の metrics.mjs は period=60s で集計するため、同時実行の「瞬間ピーク」を取りこぼす。
//   D=3.0s で短時間バーストを消化する E8 のフェーズ3では、同時実行ピークは数秒〜十数秒しか
//   立たない。これを捉えるには period=1s の高解像度採取が要る。
//
// 方式: CloudWatch GetMetricData を period=1 で [t0,t1] に対して引き、
//   ConcurrentExecutions(Maximum) の 1 秒刻み系列の最大値を返す。
//   IteratorAge(Maximum/Average) も同窓で併取して、バースト消化中に滞留が低位だったことを示す。
//
// 注意: period=1 の GetMetricData は「終了時刻が過去 3 時間以内」のときのみ有効
//   （CloudWatch の高解像度データ保持と period<60 の制約）。E8 はバースト直後に引くので満たす。
//   1 リクエストの points 上限(100,800)に収まるよう、窓は長くても ~20 分に収める。
//
// 使い方:
//   node tmp/shard-autoscale-probe/conc-sample.mjs \
//     --function shard-autoscale-probe-consumer --region us-west-2 \
//     --t0 2026-10-03T01:10:00Z --t1 2026-10-03T01:15:00Z [--json]

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
const PERIOD = parseInt(arg("period", "1"), 10); // 秒（高解像度）
const AS_JSON = hasFlag("json");

const now = Date.now();
const T1 = arg("t1", new Date(now).toISOString());
const T0 = arg("t0", new Date(now - 10 * 60 * 1000).toISOString());

const queries = [
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
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  return JSON.parse(out);
}

function series(results, id) {
  const r = (results || []).find((x) => x.Id === id);
  if (!r) return [];
  // GetMetricData は Timestamps と Values を降順(新しい順)で返す。ペアにして昇順へ。
  const pairs = (r.Timestamps || []).map((t, i) => ({ t, v: (r.Values || [])[i] }));
  pairs.sort((a, b) => new Date(a.t) - new Date(b.t));
  return pairs;
}

const resp = getMetricData();
const results = resp.MetricDataResults || [];

const conc = series(results, "concMax");
const iterMax = series(results, "iterAgeMax");
const iterAvg = series(results, "iterAgeAvg");

const concPeak = conc.length ? Math.max(...conc.map((p) => p.v)) : null;
const concPeakAt = conc.length
  ? conc.reduce((a, b) => (b.v > a.v ? b : a)).t
  : null;
const iterMaxMs = iterMax.length ? Math.max(...iterMax.map((p) => p.v)) : null;
const iterAvgMs = iterAvg.length
  ? iterAvg.reduce((s, p) => s + p.v, 0) / iterAvg.length
  : null;

const row = {
  function: FUNCTION,
  period: PERIOD,
  t0: T0,
  t1: T1,
  concPeak,
  concPeakAt,
  concSamples: conc.length,
  iteratorAgeMaxMs: iterMaxMs,
  iteratorAgeAvgMs: iterAvgMs,
  // ピーク近傍の 1 秒系列（上位数点）を参考に出す
  concTop: [...conc].sort((a, b) => b.v - a.v).slice(0, 8),
};

if (AS_JSON) {
  console.log(JSON.stringify(row));
} else {
  const f = (v) => (v == null ? "n/a" : typeof v === "number" ? v.toFixed(1) : v);
  console.log(
    `fn=${FUNCTION} period=${PERIOD}s window=[${T0}..${T1}] samples=${conc.length}`
  );
  console.log(
    `ConcurrentExecutions PEAK=${f(concPeak)} at=${concPeakAt ?? "n/a"}`
  );
  console.log(
    `IteratorAge during window: Max=${f(iterMaxMs)}ms Avg=${f(iterAvgMs)}ms`
  );
  console.log(
    `conc top-8 (1s): ` +
      row.concTop.map((p) => `${p.v}@${p.t.replace(/\.\d+Z$/, "Z")}`).join(" ")
  );
}
