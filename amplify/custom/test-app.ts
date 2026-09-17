import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App } from 'aws-cdk-lib';

/**
 * 合成テスト用の `App` を作る（テストからのみ使う。本番の合成経路には出てこない）。
 *
 * ## なぜ素の `new App()` を使わないのか
 *
 * `OrderFunctions` は `NodejsFunction` を 7 つ持ち、`Template.fromStack` の時点で
 * ローカルの esbuild が 7 回走る（1 合成あたり約 1.7 秒）。CDK は同じ内容の
 * アセットを二重にバンドルしないようステージング結果をキャッシュするが、
 * **キャッシュのキーに `outdir` が含まれる**。素の `new App()` は
 * `os.tmpdir()` の下に毎回新しい `cdk.out` を掘るため、`App` を作り直すたびに
 * キャッシュが外れて全アセットを再バンドルしていた。
 *
 * その結果、テスト本体の中で `App` を作り直すテスト（物理関数名がスタックごとに
 * 変わることの確認など）が 1 件で 1.7〜3.5 秒かかり、
 * vitest の既定のタイムアウト（5 秒）を負荷次第で超えて落ちていた。
 *
 * `outdir` をプロセス内で共有すると 2 回目以降の合成が約 10 ミリ秒で済む。
 * テスト側の検査内容は変えずに（本物の合成のまま）不安定さだけが消える。
 *
 * ## 後片付けについて
 *
 * 素の `new App()` も `os.tmpdir()` に作業ディレクトリを掘って放置する。
 * ここではワーカープロセスあたり 1 つに減るため、放置される量は素の場合より少ない。
 */
let sharedOutdir: string | undefined;

export function testApp(): App {
  sharedOutdir ??= mkdtempSync(join(tmpdir(), 'kiro-poc-cdk-'));
  return new App({ outdir: sharedOutdir });
}
