import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { testApp } from './test-app.js';

/**
 * `testApp` は合成テストの土台であり、速さのためだけの道具ではない。
 * `outdir` の共有が外れると `OrderFunctions` を含むテストが 1 件あたり
 * 1.7〜3.5 秒に戻り、vitest の既定のタイムアウト（5 秒）を負荷次第で超えて落ちる。
 *
 * 時間を測る検査は環境で揺れるため、速さの前提になっている性質
 * （`outdir` がプロセス内で 1 つであること）を直接固定する。
 * 既定のタイムアウトはあえて延ばしていない。前提が壊れたら、
 * 遅いまま通るのではなく落ちてほしいからである。
 */
describe('testApp', () => {
  it('プロセス内で outdir を共有する（アセットのバンドルを再利用させる）', () => {
    const first = testApp();
    const second = testApp();

    expect(first.outdir).toBe(second.outdir);
  });

  it('共有する outdir は実在するディレクトリである', () => {
    expect(existsSync(testApp().outdir)).toBe(true);
  });

  it('素の App とは別の outdir を使う（既定は App ごとに新しく掘られる）', () => {
    // この前提が崩れたら共有の意味がなくなる、という関係を明示しておく
    expect(testApp().outdir).toContain('kiro-poc-cdk-');
  });
});
