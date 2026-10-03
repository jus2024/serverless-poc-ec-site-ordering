// drain-wait.mjs — 投入停止後、滞留(IteratorAge)が低位に戻るまで待つ（E8 フェーズ2）。
//
// 目的（E8 の核心）: E7 は前段の滞留を抱えたまま次段を積んだため、消費が古い4シャードの
//   バックログに張り付き、同時実行が ~40 で律速された（§7.4）。E8 は各段で投入を止め、
//   IteratorAge が明確に下降して低位(既定 2,000ms 以下)に戻るのを待ってから同時実行を測る。
//
// 方式: CloudWatch GetMetricData を period=60s で「直近 window 分」に対して繰り返し引き、
//   直近サンプルの IteratorAge(Max) が floor 以下になるか、下降が頭打ちして低位安定したら完了。
//   暴走防止に cap 分で打ち切る。
//
// 判定:
//   - 直近サンプル(IterAgeMax) <= floorMs            → DRAINED
//   - cap に到達                                      → CAP（その時点の値を返す）
//
// 使い方:
//   node tmp/shard-autoscale-probe/drain-wait.mjs \
//     --function shard-autoscale-probe-consumer --region us-west-2 \
//     --floor-ms 2000 --cap-min 20 --interval-sec 30

import { execFileSync } from "node:child_process";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const FUNCTION = arg("function", "shard-autoscale-probe-consumer");
const REGION = arg("region", "us-west-2");
const FLOOR_MS = parseInt(arg("floor-ms", "2000"), 10);
const CAP_MIN = parseInt(arg("cap-min", "20"), 10);
const INTERVAL_SEC = parseInt(arg("interval-sec", "30"), 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function latestIterAge() {
  // 直近 5 分を period=60s で引き、最新の値(Max/Avg)を返す。
  const t1 = new Date().toISOString();
  const t0 = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const queries = [
    {
      Id: "iterMax",
      MetricStat: {
        Metric: {
          Namespace: "AWS/Lambda",
          MetricName: "IteratorAge",
          Dimensions: [{ Name: "FunctionName", Value: FUNCTION }],
        },
        Period: 60,
        Stat: "Maximum",
      },
      ReturnData: true,
    },
  ];
  const out = execFileSync(
    "aws",
    [
      "cloudwatch",
      "get-metric-data",
      "--region",
      REGION,
      "--start-time",
      t0,
      "--end-time",
      t1,
      "--metric-data-queries",
      JSON.stringify(queries),
      "--output",
      "json",
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  const resp = JSON.parse(out);
  const r = (resp.MetricDataResults || []).find((x) => x.Id === "iterMax");
  if (!r || !r.Timestamps || r.Timestamps.length === 0) return null;
  // 最新(=降順の先頭)
  const pairs = r.Timestamps.map((t, i) => ({ t, v: r.Values[i] }));
  pairs.sort((a, b) => new Date(b.t) - new Date(a.t));
  return pairs[0];
}

(async () => {
  const start = Date.now();
  const capMs = CAP_MIN * 60 * 1000;
  console.log(
    `drain-wait: fn=${FUNCTION} floor=${FLOOR_MS}ms cap=${CAP_MIN}min interval=${INTERVAL_SEC}s`
  );
  let last = null;
  while (true) {
    const s = latestIterAge();
    const nowiso = new Date().toISOString();
    if (s == null) {
      console.log(`${nowiso} iterAgeMax=n/a (no datapoint yet)`);
    } else {
      last = s;
      console.log(`${nowiso} iterAgeMax=${Math.round(s.v)}ms (sampleAt=${s.t})`);
      if (s.v <= FLOOR_MS) {
        console.log(`RESULT verdict=DRAINED iterAgeMax=${Math.round(s.v)}ms`);
        return;
      }
    }
    if (Date.now() - start >= capMs) {
      console.log(
        `RESULT verdict=CAP iterAgeMax=${last ? Math.round(last.v) : "n/a"}ms elapsedMin=${CAP_MIN}`
      );
      return;
    }
    await sleep(INTERVAL_SEC * 1000);
  }
})();
