// shard-autoscale-probe の消費 Lambda（使い捨て検証装置）。
//
// 役割: DynamoDB Streams イベントソースマッピング(ESM)から受け取ったレコードを
//       1 レコードあたり厳密に D = 50 ミリ秒 sleep して「消費」する。業務処理は行わない。
//
// ★E9 変更: D を 3.0 秒 → 50 ミリ秒 に変更（現実的な業務処理相当の速い消費者）。
//   E1〜E8 は過負荷で S を観測するため D=3.0s（極端に遅い消費者）だった。E9 は
//   「緩やかな負荷上昇で S も緩やかに増え、滞留が秒オーダーで業務が回る」感覚を見るため、
//   消化が投入に追いつく速い消費者にする。消化レート = S×P÷D = S×10÷0.05 = S×200 件/s。
//
// D 不変（Property 2 / 要件 1.3, 4.5）:
//   ESM は BatchSize=1 で構成する。したがって
//     1 呼び出し = 1 バッチ = 1 レコード = await sleep(50) = 50 ミリ秒
//   となり、「1 レコードあたりの処理時間 D」が厳密に 50 ミリ秒で定義される。
//   仮に BatchSize>1 でも、各レコードごとに順次 50 ミリ秒 sleep するため
//   D(レコード単位) は 50 ミリ秒のまま保たれる（呼び出し時間は 0.05 × レコード数になる）。
//
// ランタイム前提: Node.js 20 / メモリ 128MB / タイムアウト 60s。
//   sleep のみで CPU/メモリをほぼ使わないため 128MB で十分。
//   外部依存なし（標準ライブラリのみ）。

const SLEEP_MS = 50; // D = 50 ミリ秒（E9 で変更。E8 までは 3000）

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const handler = async (event) => {
  const records = event?.Records ?? [];
  // 各レコードごとに D 秒 sleep する。BatchSize=1 なので通常 records.length===1。
  for (const _record of records) {
    await sleep(SLEEP_MS);
  }
  // ESM にバッチ成功を返す（部分失敗レポートは使わない）。
  return { processed: records.length, sleptMsPerRecord: SLEEP_MS };
};
