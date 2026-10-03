// 複数の子プロセス(fork)で e2-burst 相当の投入を並列実行し、
// 単一プロセスのスループット上限(~8MB/s)を越えて warm(40MB/s)超の過負荷を作る。
//
// 使い方（リポジトリルートから実行）:
//   node docs/poc/shard-autoscale-probe/overload.mjs --procs 8 --rounds 6 --round-items 150000 \
//           --concurrency 120 --item-bytes 1024 --table shard-autoscale-probe --region us-west-2

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const PROCS = parseInt(arg("procs", "8"), 10);
const burst = path.join(path.dirname(fileURLToPath(import.meta.url)), "e2-burst.mjs");

// e2-burst に渡す引数(procs 以外をそのまま委譲)
const pass = [];
for (const k of ["table", "region", "rounds", "round-items", "concurrency", "item-bytes", "round-gap-ms"]) {
  const v = arg(k, null);
  if (v != null) pass.push(`--${k}`, v);
}

console.log(`overload: forking ${PROCS} procs; args=${pass.join(" ")}`);
const start = Date.now();
let done = 0;
for (let i = 0; i < PROCS; i++) {
  const child = fork(burst, pass, { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.stdout.on("data", (d) => process.stdout.write(`[p${i}] ${d}`));
  child.on("exit", () => {
    done++;
    if (done === PROCS) {
      const sec = (Date.now() - start) / 1000;
      console.log(`overload: all ${PROCS} procs done in ${sec.toFixed(1)}s`);
    }
  });
}
