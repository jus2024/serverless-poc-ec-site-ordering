/**
 * 消費能力と滞留の算術の単体テスト（design §2.1 / §2.4。要件 20.2〜20.4）。
 *
 * **検算の基準は 2 系統ある。混ぜないこと。**
 *
 * ## 系統 1: 想定 D = 3,600ms（設計時の前提。design が現在載せている値ではない）
 *
 * 擬似待機 3,500ms + オーバーヘッド想定 100ms。S = 4 で P = 1 → 67/分、
 * P = 10 → 667/分（実値 666.67）。投入 2,000/分 はちょうど 3 倍になり
 * `IteratorAge` の増加速度は `1 − 1/3 = 0.667`、猶予は 129,600 秒 = 36 時間。
 *
 * この系統の値は **D = 3,600ms を入力として与えたときに式が返す値**であり、
 * 手計算で追える丸い数であることに意味がある。式の算術をここで固定する。
 * design 本文の現在の数字ではないため、design に合わせて書き換えてはならない。
 *
 * ## 系統 2: 実測 D = 3,652.57ms（タスク 14。design §2.2 / §2.4 / §13 の #2）
 *
 * ウォーム時の Lambda `Duration` の平均。標本 25 件（コールドスタート 5 件を除外）、
 * サンドボックス `us-west-2`、実行日 2026-08-29。擬似待機 3,500ms に対する
 * オーバーヘッドの実測は 152.57ms（想定 100ms）。
 *
 * - S = 4 で P = 1 → **65.7/分**、P = 10 → **657/分**（design §2.2 の #7 の式の値）
 *   - **実測の壁の位置は P = 10 では式と一致しない**（design §2.2 の 7'）。
 *     P = 1 は **66.30/分**（式どおり）だが、**P = 10 は 557.5〜569.6/分 = 式の 0.84〜0.85 倍**である。
 *     **ここで検証しているのは式であり、期待値に 0.84 を掛けてはならない。**
 * - 投入 2,000/分 に対して `A ÷ C ≒ 3.044`、猶予 **約 128,700 秒 ≒ 35.7 時間**（§2.4）
 * - シナリオ A6（決済 100ms → D = 752.57ms、P = 10）→ **約 3,189/分**（§10.2）
 *
 * **design 本文が掲げているのはこちらの数字である。** design の実測値が
 * 更新されたら追随するのはこの系統だけで、系統 1 は 3,600ms 固定のままにする。
 *
 * 系統 1 と系統 2 は入力 D が違うだけで、検証している式は同一である。
 * 数字が食い違って見えても、片方を他方に合わせて「修正」しないこと。
 *
 * ## 系統 3: シナリオ A2 の実測（滞留の算術そのものの実測）
 *
 * 系統 1 / 2 は「D を入力にして式が返す値」の確認であり、滞留の算術それ自体は
 * 実測と突き合わせていなかった。**A2 で突き合わせた結果、§2.4 の式は誤っていた**
 * （`IteratorAge` の分母が消費能力 C になっていた。正しくは投入レート A）。
 * 訂正の経緯は design §2.4 の「訂正の記録」と `capacity.ts` の冒頭に、
 * 実測の内訳は `docs/poc/verification-results.md` の §2.4 にある。
 *
 * 系統 3 は「シナリオ A2 の実測との突き合わせ」の describe に閉じてある。
 * **この系統だけが式の形（`× A` か `× C` か）を固定している。**
 * 系統 1 / 2 の丸い数は、式の形を間違えたままでも自己整合してしまい、
 * 誤りを検出できなかった。増加速度が `[0, 1)` に入るという不変条件も併せて置いてある。
 */

import { describe, expect, it } from "vitest";
import {
  STREAMS_RETENTION_SECONDS,
  estimateBacklogCount,
  estimateCapacityPerMinute,
  estimateRecoverySeconds,
  projectBacklog,
  recoverySecondsFromIteratorAge,
  resolveRecordProcessingMs,
} from "./capacity";

// ─── 系統 1: 設計時の想定 D ────────────────────────────────────────

/** 設計時に想定した D（ミリ秒）。擬似待機 3,500ms + オーバーヘッド想定 100ms */
const ASSUMED_RECORD_PROCESSING_MS = 3_600;

/** 想定 D での消費能力（S = 4, P = 10）。666.67 件/分（表示上は 667） */
const CAPACITY_S4_P10 = estimateCapacityPerMinute({
  shardCount: 4,
  parallelizationFactor: 10,
  recordProcessingMs: ASSUMED_RECORD_PROCESSING_MS,
});

// ─── 系統 2: タスク 14 の実測 D ─────────────────────────────────────

/** 擬似待機以外のオーバーヘッドの実測値（ミリ秒。段階内 138.44 + 段階外 14.13） */
const MEASURED_STAGE_OVERHEAD_MS = 152.57;

/** 実測 D（ミリ秒）。ウォーム時の Lambda `Duration` 平均（n = 25） */
const MEASURED_RECORD_PROCESSING_MS = 3_652.57;

/** 実測 D での消費能力（S = 4, P = 1）。design §2.2 の 65.7 件/分 */
const MEASURED_CAPACITY_S4_P1 = estimateCapacityPerMinute({
  shardCount: 4,
  parallelizationFactor: 1,
  recordProcessingMs: MEASURED_RECORD_PROCESSING_MS,
});

/** 実測 D での消費能力（S = 4, P = 10）。design §2.2 の 657 件/分 */
const MEASURED_CAPACITY_S4_P10 = estimateCapacityPerMinute({
  shardCount: 4,
  parallelizationFactor: 10,
  recordProcessingMs: MEASURED_RECORD_PROCESSING_MS,
});

/** 小数第 1 位までで比較する（design が 1 桁で引用している値に合わせる） */
const roundTo1 = (value: number): number => Math.round(value * 10) / 10;

describe("estimateCapacityPerMinute（design §2.1: S × P ÷ D）", () => {
  it("【想定 D】S=4, P=1, D=3.6 秒 なら約 67/分（設計時の前提。手計算の基準）", () => {
    const capacity = estimateCapacityPerMinute({
      shardCount: 4,
      parallelizationFactor: 1,
      recordProcessingMs: ASSUMED_RECORD_PROCESSING_MS,
    });

    expect(Math.round(capacity)).toBe(67);
  });

  it("【想定 D】S=4, P=10, D=3.6 秒 なら約 667/分（設計時の前提。手計算の基準）", () => {
    expect(Math.round(CAPACITY_S4_P10)).toBe(667);
  });

  it("【実測 D】S=4, P=1, D=3,652.57ms で 65.7/分（design §2.2 の #7）", () => {
    expect(roundTo1(MEASURED_CAPACITY_S4_P1)).toBe(65.7);
  });

  it("【実測 D】S=4, P=10, D=3,652.57ms で 657/分（design §2.2 の #7）", () => {
    expect(Math.round(MEASURED_CAPACITY_S4_P10)).toBe(657);
    expect(roundTo1(MEASURED_CAPACITY_S4_P10)).toBe(657.1);
  });

  it("【実測 D】P で比例するのは実測 D でも同じ（65.7 × 10 = 657）", () => {
    expect(MEASURED_CAPACITY_S4_P10).toBeCloseTo(MEASURED_CAPACITY_S4_P1 * 10, 6);
  });

  it("【実測 D】想定 D からの壁の移動は約 2%（design §2.2 の所見）", () => {
    // 「オーバーヘッドが D を膨らませて壁の位置をずらす」という §13 #2 の懸念は外れた。
    // D の誤差 1.4%（3,600 → 3,652.57）が能力の 1.4% 低下として現れるだけである
    const shift = 1 - MEASURED_CAPACITY_S4_P10 / CAPACITY_S4_P10;

    expect(shift).toBeGreaterThan(0);
    expect(shift).toBeLessThan(0.02);
  });

  it("【実測 D】シナリオ A6（決済 100ms）は約 3,189/分（design §10.2）", () => {
    // D = 決済 100 + 通知 500 + 実測オーバーヘッド 152.57 = 752.57ms
    const recordProcessingMs = resolveRecordProcessingMs({
      stageDelaysMs: { payment: 100, notification: 500 },
      assumedOverheadMs: MEASURED_STAGE_OVERHEAD_MS,
    });
    expect(recordProcessingMs).toBeCloseTo(752.57, 6);

    const capacity = estimateCapacityPerMinute({
      shardCount: 4,
      parallelizationFactor: 10,
      recordProcessingMs,
    });

    expect(Math.round(capacity)).toBe(3_189);

    // A6 の意図（A4 と同じ投入 1,000/分 で滞留が消える）は実測 D でも保たれる
    expect(capacity).toBeGreaterThan(1_000);
  });

  it("S を 100 に増やすと同時実行 1,000（Lambda の枠）に届く（design §2.5 の軸 B）", () => {
    const capacity = estimateCapacityPerMinute({
      shardCount: 100,
      parallelizationFactor: 10,
      recordProcessingMs: 3_600,
    });

    expect(Math.round(capacity)).toBe(16_667);
  });

  it("BatchSize は式に現れない（design §2.1: 直列処理なら約分される）", () => {
    // BatchSize = 10 は「1 呼び出しで 10 件・所要時間 10 × D」であり、
    // S × P × 10 ÷ (10 × D) は S × P ÷ D と等しい
    const single = estimateCapacityPerMinute({
      shardCount: 4,
      parallelizationFactor: 10,
      recordProcessingMs: 3_600,
    });
    const batched =
      estimateCapacityPerMinute({
        shardCount: 4,
        parallelizationFactor: 10,
        recordProcessingMs: 3_600 * 10,
      }) * 10;

    expect(batched).toBeCloseTo(single, 6);
  });

  it("D が 0 以下・非有限なら例外にする（消費能力が定義できない）", () => {
    const base = { shardCount: 4, parallelizationFactor: 1 };

    expect(() => estimateCapacityPerMinute({ ...base, recordProcessingMs: 0 })).toThrow(RangeError);
    expect(() => estimateCapacityPerMinute({ ...base, recordProcessingMs: -1 })).toThrow(RangeError);
    expect(() => estimateCapacityPerMinute({ ...base, recordProcessingMs: Number.NaN })).toThrow(
      RangeError
    );
    expect(() =>
      estimateCapacityPerMinute({ ...base, recordProcessingMs: Number.POSITIVE_INFINITY })
    ).toThrow(RangeError);
  });

  it("S・P が負や非有限なら例外にする（API 応答が壊れていた場合）", () => {
    expect(() =>
      estimateCapacityPerMinute({
        shardCount: -1,
        parallelizationFactor: 1,
        recordProcessingMs: 3_600,
      })
    ).toThrow(RangeError);
    expect(() =>
      estimateCapacityPerMinute({
        shardCount: 4,
        parallelizationFactor: Number.NaN,
        recordProcessingMs: 3_600,
      })
    ).toThrow(RangeError);
  });
});

describe("resolveRecordProcessingMs", () => {
  it("【想定 D】擬似待機（決済 + 通知）にオーバーヘッド想定 100ms を足す", () => {
    const recordProcessingMs = resolveRecordProcessingMs({
      stageDelaysMs: { payment: 3_000, notification: 500 },
      assumedOverheadMs: 100,
    });

    // 設計時の前提 D = 3.6 秒
    expect(recordProcessingMs).toBe(ASSUMED_RECORD_PROCESSING_MS);
  });

  it("【実測 D】オーバーヘッド 152.57ms で D = 3,652.57ms を再現する（タスク 14 / design §2.2）", () => {
    const recordProcessingMs = resolveRecordProcessingMs({
      stageDelaysMs: { payment: 3_000, notification: 500 },
      assumedOverheadMs: MEASURED_STAGE_OVERHEAD_MS,
    });

    expect(recordProcessingMs).toBeCloseTo(MEASURED_RECORD_PROCESSING_MS, 6);
  });

  it("実測したオーバーヘッドで D を置き換えられる（タスク 14 / design §13 の #2）", () => {
    expect(
      resolveRecordProcessingMs({
        stageDelaysMs: { payment: 3_000, notification: 500 },
        assumedOverheadMs: 900,
      })
    ).toBe(4_400);
  });

  it("負や非有限の値を弾く", () => {
    expect(() =>
      resolveRecordProcessingMs({
        stageDelaysMs: { payment: -1, notification: 500 },
        assumedOverheadMs: 100,
      })
    ).toThrow(RangeError);
    expect(() =>
      resolveRecordProcessingMs({
        stageDelaysMs: { payment: 3_000, notification: 500 },
        assumedOverheadMs: Number.NaN,
      })
    ).toThrow(RangeError);
  });
});

describe("projectBacklog【想定 D】設計時の数値例（投入 2,000 / 能力 666.67 → 猶予 36 時間）", () => {
  it("消費能力の 3 倍の投入で IteratorAge は 0.667 倍速、猶予は 36 時間", () => {
    // 667 は表示上の丸めであり、S × P ÷ D の実値は 2,000 ÷ 3 = 666.67 である。
    // したがって投入 2,000/分 はちょうど 3 倍になる
    const projection = projectBacklog({
      arrivalPerMinute: 2_000,
      capacityPerMinute: CAPACITY_S4_P10,
    });

    expect(projection.regime).toBe("GROWING");
    expect(projection.loadRatio).toBeCloseTo(3, 9);
    // 1 − C ÷ A = 1 − 1/3。当初の式 `A ÷ C − 1` は 2.0 を返していた（design §2.4 の訂正）
    expect(projection.iteratorAgeGrowthRate).toBeCloseTo(2 / 3, 9);
    expect(projection.secondsUntilDataLoss).toBeCloseTo(129_600, 6);

    // 129,600 秒 = 36 時間。消費能力の 3 倍のバズが 36 時間続くとデータを失い始める。
    // 当初の式では 12 時間（= 36 ÷ A ÷ C）だった
    expect((projection.secondsUntilDataLoss as number) / 3_600).toBeCloseTo(36, 9);
    expect(projection.secondsUntilDataLoss).toBeCloseTo(43_200 * 3, 6);
  });

  it("丸めた能力 667 を使っても猶予は 36 時間に読める", () => {
    const projection = projectBacklog({ arrivalPerMinute: 2_000, capacityPerMinute: 667 });

    expect((projection.secondsUntilDataLoss as number) / 3_600).toBeCloseTo(36, 1);
  });

  it("滞留の増加率は A − C（件/分。要件 20.2）", () => {
    const projection = projectBacklog({ arrivalPerMinute: 2_000, capacityPerMinute: 667 });

    expect(projection.backlogGrowthPerMinute).toBe(1_333);
    expect(projection.surplusCapacityPerMinute).toBe(0);
  });

  it("シナリオ A2（投入 200 / 能力 66.67）も同じ 3 倍で猶予 36 時間", () => {
    const capacity = estimateCapacityPerMinute({
      shardCount: 4,
      parallelizationFactor: 1,
      recordProcessingMs: ASSUMED_RECORD_PROCESSING_MS,
    });
    const projection = projectBacklog({ arrivalPerMinute: 200, capacityPerMinute: capacity });

    expect(projection.loadRatio).toBeCloseTo(3, 9);
    expect((projection.secondsUntilDataLoss as number) / 3_600).toBeCloseTo(36, 9);
  });

  it("投入が増えるほど猶予は短くなる", () => {
    const times = [800, 1_000, 2_000, 4_000].map(
      (arrivalPerMinute) =>
        projectBacklog({ arrivalPerMinute, capacityPerMinute: CAPACITY_S4_P10 })
          .secondsUntilDataLoss as number
    );

    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]).toBeLessThan(times[i - 1]);
    }
  });

  it("投入が能力ちょうどの 2 倍なら増加速度 0.5、猶予は保持期限の 2 倍", () => {
    const projection = projectBacklog({
      arrivalPerMinute: CAPACITY_S4_P10 * 2,
      capacityPerMinute: CAPACITY_S4_P10,
    });

    // 当初の式 `A ÷ C − 1` はここで 1.0 を返し、猶予を保持期限そのものとしていた
    expect(projection.iteratorAgeGrowthRate).toBeCloseTo(0.5, 9);
    expect(projection.secondsUntilDataLoss).toBeCloseTo(STREAMS_RETENTION_SECONDS * 2, 6);
  });
});

describe("iteratorAgeGrowthRate の不変条件（design §2.4。この訂正の本質）", () => {
  // `IteratorAge` は「先頭の未処理レコードが書かれてからの経過時間」であり、
  // 実時間 1 秒あたり 1 秒より速く古くなることは原理的にありえない。
  // 当初の式 `A ÷ C − 1` は上に有界でなく（A = 3C で 2.0）、この不変条件を破っていた。
  // 訂正後の式 `1 − C ÷ A` は常に [0, 1) に入る。
  it("A > C のどんな組み合わせでも増加速度は 1 を下回る", () => {
    const capacities = [0.5, 1, 65.7, 66.3, 657, 3_189, 16_667];
    const multipliers = [1.000_1, 1.01, 1.5, 3, 10, 100, 10_000, 1_000_000];

    for (const capacityPerMinute of capacities) {
      for (const multiplier of multipliers) {
        const projection = projectBacklog({
          arrivalPerMinute: capacityPerMinute * multiplier,
          capacityPerMinute,
        });

        expect(projection.iteratorAgeGrowthRate).toBeGreaterThan(0);
        expect(projection.iteratorAgeGrowthRate).toBeLessThan(1);

        // 猶予が保持期限を下回ることもない（増加速度が 1 を超えないことの裏返し）
        expect(projection.secondsUntilDataLoss).toBeGreaterThan(STREAMS_RETENTION_SECONDS);
      }
    }
  });

  it("A ≤ C では 0。投入と能力が等しいときだけ両式が一致する", () => {
    for (const capacityPerMinute of [1, 65.7, 657]) {
      // 均衡点では当初の式 `A ÷ C − 1` も 0 を返す。A1（比 0.91）で
      // 誤りが露出しなかったのはこのためである（design §2.4 の訂正の記録）
      expect(
        projectBacklog({ arrivalPerMinute: capacityPerMinute, capacityPerMinute })
          .iteratorAgeGrowthRate
      ).toBe(0);
      expect(
        projectBacklog({ arrivalPerMinute: capacityPerMinute / 2, capacityPerMinute })
          .iteratorAgeGrowthRate
      ).toBe(0);
    }
  });

  it("増加速度が 1 に達するのは C = 0 のときだけ（上限）", () => {
    expect(projectBacklog({ arrivalPerMinute: 200, capacityPerMinute: 0 }).iteratorAgeGrowthRate).toBe(
      1
    );

    // C を 0 に近づけると 1 へ漸近する。飛び越えない
    const nearZero = projectBacklog({ arrivalPerMinute: 200, capacityPerMinute: 0.000_1 });
    expect(nearZero.iteratorAgeGrowthRate).toBeLessThan(1);
    expect(nearZero.iteratorAgeGrowthRate).toBeGreaterThan(0.999);
  });
});

describe("projectBacklog【実測 D】design §2.4 の数値例（投入 2,000 / 能力 657 → 猶予 35.7 時間）", () => {
  it("A ÷ C ≒ 3.044、IteratorAge は 0.672 倍速、猶予は約 128,700 秒 ≒ 35.7 時間", () => {
    const projection = projectBacklog({
      arrivalPerMinute: 2_000,
      capacityPerMinute: MEASURED_CAPACITY_S4_P10,
    });

    expect(projection.regime).toBe("GROWING");
    expect(projection.loadRatio).toBeCloseTo(3.044, 3);
    // 1 − C ÷ A = 1 − 0.3285。当初の式は 2.044 を返していた（design §2.4 の訂正）
    expect(projection.iteratorAgeGrowthRate).toBeCloseTo(0.6715, 4);

    // design が「約 128,700 秒」と 100 秒単位で丸めているため、同じ粒度で見る
    const seconds = projection.secondsUntilDataLoss as number;
    expect(seconds).toBeGreaterThan(128_400);
    expect(seconds).toBeLessThan(129_000);
    expect(roundTo1(seconds / 3_600)).toBe(35.7);

    // 想定 D の 36 時間より短い。実測は設計時の見立てより厳しい側に出た
    expect(seconds).toBeLessThan(129_600);

    // 訂正前の猶予（86,400 ÷ (A ÷ C − 1) = 42,300 秒 ≒ 11.7 時間）との比は
    // A ÷ C そのものである（design §2.4 の訂正の記録）
    const loadRatio = projection.loadRatio as number;
    const beforeCorrection = STREAMS_RETENTION_SECONDS / (loadRatio - 1);
    expect(roundTo1(beforeCorrection / 3_600)).toBe(11.7);
    expect(seconds / beforeCorrection).toBeCloseTo(loadRatio, 6);
  });

  it("design 本文の丸めた能力 657 を直接与えても猶予は 35.7 時間に読める", () => {
    const projection = projectBacklog({ arrivalPerMinute: 2_000, capacityPerMinute: 657 });

    expect(projection.loadRatio).toBeCloseTo(3.044, 3);
    expect(roundTo1((projection.secondsUntilDataLoss as number) / 3_600)).toBe(35.7);
  });

  it("シナリオ A2（投入 200 / 能力 65.7）も同じ 3.044 倍で猶予 35.7 時間", () => {
    const projection = projectBacklog({
      arrivalPerMinute: 200,
      capacityPerMinute: MEASURED_CAPACITY_S4_P1,
    });

    expect(projection.loadRatio).toBeCloseTo(3.044, 3);
    expect(roundTo1((projection.secondsUntilDataLoss as number) / 3_600)).toBe(35.7);
  });

  it("シナリオ A4（投入 1,000 / 能力 657）は実測 D でも壁を超える（比 1.52）", () => {
    const projection = projectBacklog({
      arrivalPerMinute: 1_000,
      capacityPerMinute: MEASURED_CAPACITY_S4_P10,
    });

    expect(projection.regime).toBe("GROWING");
    expect(roundTo1(projection.loadRatio as number)).toBe(1.5);
    expect(projection.loadRatio).toBeCloseTo(1.522, 3);
  });

  it("シナリオ A1（投入 60 / 能力 65.7）は滞留しないが余裕は 8.7%（design §10.2 の注意）", () => {
    const projection = projectBacklog({
      arrivalPerMinute: 60,
      capacityPerMinute: MEASURED_CAPACITY_S4_P1,
    });

    expect(projection.regime).toBe("DRAINING");
    expect(projection.secondsUntilDataLoss).toBeNull();

    // 想定 D では余裕 10.4% だった。実測 D では 8.7% に縮む
    const margin = 1 - 60 / MEASURED_CAPACITY_S4_P1;
    expect(roundTo1(margin * 100)).toBe(8.7);
  });
});

describe("projectBacklog: 滞留しない場合の扱い", () => {
  it("投入が能力を下回れば DRAINING。猶予は null（0 ではない）", () => {
    // シナリオ A1（投入 60 / 能力 67）: 壁の直前
    const projection = projectBacklog({ arrivalPerMinute: 60, capacityPerMinute: 66.67 });

    expect(projection.regime).toBe("DRAINING");
    expect(projection.backlogGrowthPerMinute).toBe(0);
    expect(projection.surplusCapacityPerMinute).toBeCloseTo(6.67, 6);
    expect(projection.iteratorAgeGrowthRate).toBe(0);

    // 0 だと画面が「猶予 0 時間」と表示しうる。データロスは起きないのだから null
    expect(projection.secondsUntilDataLoss).toBeNull();
  });

  it("滞留の増加率は負にならない（余力は別のフィールドで持つ）", () => {
    const projection = projectBacklog({ arrivalPerMinute: 100, capacityPerMinute: 700 });

    expect(projection.backlogGrowthPerMinute).toBe(0);
    expect(projection.surplusCapacityPerMinute).toBe(600);
    expect(projection.loadRatio).toBeCloseTo(100 / 700, 9);
  });

  it("投入と能力が等しければ STEADY。増えも減りもしない", () => {
    const projection = projectBacklog({ arrivalPerMinute: 667, capacityPerMinute: 667 });

    expect(projection.regime).toBe("STEADY");
    expect(projection.loadRatio).toBe(1);
    expect(projection.backlogGrowthPerMinute).toBe(0);
    expect(projection.surplusCapacityPerMinute).toBe(0);
    expect(projection.iteratorAgeGrowthRate).toBe(0);
    expect(projection.secondsUntilDataLoss).toBeNull();
  });

  it("投入 0 なら滞留しない", () => {
    const projection = projectBacklog({ arrivalPerMinute: 0, capacityPerMinute: 667 });

    expect(projection.regime).toBe("DRAINING");
    expect(projection.secondsUntilDataLoss).toBeNull();
  });
});

describe("projectBacklog: 消費能力が 0 の場合（STALLED）", () => {
  it("消費が止まっていれば IteratorAge は実時間と同じ速さで増え、猶予は保持期限そのもの", () => {
    const projection = projectBacklog({ arrivalPerMinute: 2_000, capacityPerMinute: 0 });

    expect(projection.regime).toBe("STALLED");
    // A ÷ C は定義できない
    expect(projection.loadRatio).toBeNull();
    expect(projection.backlogGrowthPerMinute).toBe(2_000);
    expect(projection.iteratorAgeGrowthRate).toBe(1);
    expect(projection.secondsUntilDataLoss).toBe(STREAMS_RETENTION_SECONDS);
    expect(STREAMS_RETENTION_SECONDS / 3_600).toBe(24);
  });

  it("この値は特例ではなく一般式 1 − C ÷ A の帰結である（design §2.4 の訂正）", () => {
    // 当初の式 `A ÷ C − 1` は C → 0 で発散するため、「消費が止まれば IteratorAge は
    // 実時間と 1:1 で増える」を特例として書き込む必要があった。
    // 訂正後の式は C = 0 でちょうど 1 を返し、特例が一般式に吸収された
    const arrivalPerMinute = 2_000;
    const projection = projectBacklog({ arrivalPerMinute, capacityPerMinute: 0 });

    expect(projection.iteratorAgeGrowthRate).toBe(1 - 0 / arrivalPerMinute);
    expect(projection.secondsUntilDataLoss).toBe(
      STREAMS_RETENTION_SECONDS / (1 - 0 / arrivalPerMinute)
    );

    // 投入レートによらず 1。滞留の先頭が古くなる速さは投入量に依存しない
    for (const rate of [1, 60, 199.4, 16_000]) {
      expect(projectBacklog({ arrivalPerMinute: rate, capacityPerMinute: 0 }).iteratorAgeGrowthRate).toBe(
        1
      );
    }
  });

  it("投入も能力も 0 なら STEADY。データロスは起きない", () => {
    const projection = projectBacklog({ arrivalPerMinute: 0, capacityPerMinute: 0 });

    expect(projection.regime).toBe("STEADY");
    expect(projection.loadRatio).toBeNull();
    expect(projection.backlogGrowthPerMinute).toBe(0);
    expect(projection.secondsUntilDataLoss).toBeNull();
  });
});

describe("projectBacklog: 入力の検証", () => {
  it("負の値・非有限の値を弾く", () => {
    expect(() => projectBacklog({ arrivalPerMinute: -1, capacityPerMinute: 667 })).toThrow(
      RangeError
    );
    expect(() => projectBacklog({ arrivalPerMinute: 2_000, capacityPerMinute: -1 })).toThrow(
      RangeError
    );
    expect(() => projectBacklog({ arrivalPerMinute: Number.NaN, capacityPerMinute: 667 })).toThrow(
      RangeError
    );
    expect(() =>
      projectBacklog({
        arrivalPerMinute: Number.POSITIVE_INFINITY,
        capacityPerMinute: 667,
      })
    ).toThrow(RangeError);
  });
});

describe("JSON への往復（design §11.4 の localStorage 永続化）", () => {
  it("猶予時間の有無が JSON 往復で変わらない", () => {
    const growing = projectBacklog({ arrivalPerMinute: 2_000, capacityPerMinute: 667 });
    const draining = projectBacklog({ arrivalPerMinute: 60, capacityPerMinute: 667 });

    const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

    // Infinity を使っていると JSON.stringify で null に落ち、
    // 保存して読み直した実行だけ意味が変わってしまう
    expect(roundTrip(growing)).toEqual(growing);
    expect(roundTrip(draining)).toEqual(draining);
    expect(roundTrip(draining).secondsUntilDataLoss).toBeNull();
  });
});

describe("滞留件数と回復時間（design §2.4 / 論点 9。要件 20.4）", () => {
  it("滞留件数は IteratorAge × 投入レート（論点 9。当初は × 消費能力で誤っていた）", () => {
    // IteratorAge 1 時間、投入 2,000/分 → 2,000 × 60 = 120,000 件
    expect(estimateBacklogCount({ iteratorAgeSeconds: 3_600, arrivalPerMinute: 2_000 })).toBe(
      120_000
    );
  });

  it("滞留件数は消費能力に依存しない（式に C が現れない）", () => {
    // 当初の式では能力を変えると件数が変わっていた。滞留は「書かれた件数」であり、
    // どれだけ捌けるかとは無関係である
    const count = estimateBacklogCount({ iteratorAgeSeconds: 598, arrivalPerMinute: 199.4 });
    expect(count).toBeCloseTo(1_987.35, 2);
  });

  it("回復時間は B ÷ C", () => {
    // 40,020 件を 667/分 で消化 → 60 分 = 3,600 秒
    expect(estimateRecoverySeconds({ backlogCount: 40_020, capacityPerMinute: 667 })).toBe(3_600);
  });

  it("回復時間は停止時点の IteratorAge × A ÷ C（design §2.4 の訂正）", () => {
    for (const iteratorAgeSeconds of [0, 60, 3_600, 43_200, STREAMS_RETENTION_SECONDS]) {
      for (const capacityPerMinute of [67, 667, CAPACITY_S4_P10]) {
        for (const multiplier of [1, 1.5, 3, 10]) {
          const arrivalPerMinute = capacityPerMinute * multiplier;
          const backlogCount = estimateBacklogCount({ iteratorAgeSeconds, arrivalPerMinute });
          const viaBacklog = estimateRecoverySeconds({ backlogCount, capacityPerMinute });

          // IteratorAge そのものではなく A ÷ C 倍。恒等になるのは A = C のときだけ
          expect(viaBacklog).toBeCloseTo(iteratorAgeSeconds * multiplier, 6);
          expect(
            recoverySecondsFromIteratorAge({
              iteratorAgeSeconds,
              arrivalPerMinute,
              capacityPerMinute,
            })
          ).toBeCloseTo(iteratorAgeSeconds * multiplier, 6);
        }
      }
    }
  });

  it("A = C のときだけ回復時間が IteratorAge に等しくなる（当初の式が成立する唯一の点）", () => {
    for (const rate of [67, 657, CAPACITY_S4_P10]) {
      expect(
        recoverySecondsFromIteratorAge({
          iteratorAgeSeconds: 3_600,
          arrivalPerMinute: rate,
          capacityPerMinute: rate,
        })
      ).toBeCloseTo(3_600, 6);
    }
  });

  it("滞留が無ければ回復時間は 0", () => {
    expect(estimateBacklogCount({ iteratorAgeSeconds: 0, arrivalPerMinute: 2_000 })).toBe(0);
    expect(estimateRecoverySeconds({ backlogCount: 0, capacityPerMinute: 667 })).toBe(0);
    // 能力 0 でも滞留が無ければ回復時間は 0
    expect(estimateRecoverySeconds({ backlogCount: 0, capacityPerMinute: 0 })).toBe(0);
    expect(
      recoverySecondsFromIteratorAge({
        iteratorAgeSeconds: 0,
        arrivalPerMinute: 2_000,
        capacityPerMinute: 0,
      })
    ).toBe(0);
  });

  it("能力 0 で滞留が残っていれば回復時間は null（消化されない）", () => {
    expect(estimateRecoverySeconds({ backlogCount: 10_000, capacityPerMinute: 0 })).toBeNull();
    expect(
      recoverySecondsFromIteratorAge({
        iteratorAgeSeconds: 3_600,
        arrivalPerMinute: 2_000,
        capacityPerMinute: 0,
      })
    ).toBeNull();
  });

  it("投入 0 なら IteratorAge がいくつでも滞留は 0", () => {
    expect(estimateBacklogCount({ iteratorAgeSeconds: 3_600, arrivalPerMinute: 0 })).toBe(0);
  });

  it("負の値・非有限の値を弾く", () => {
    expect(() => estimateBacklogCount({ iteratorAgeSeconds: -1, arrivalPerMinute: 2_000 })).toThrow(
      RangeError
    );
    expect(() => estimateBacklogCount({ iteratorAgeSeconds: 3_600, arrivalPerMinute: -1 })).toThrow(
      RangeError
    );
    expect(() => estimateRecoverySeconds({ backlogCount: -1, capacityPerMinute: 667 })).toThrow(
      RangeError
    );
    expect(() =>
      recoverySecondsFromIteratorAge({
        iteratorAgeSeconds: -1,
        arrivalPerMinute: 2_000,
        capacityPerMinute: 657,
      })
    ).toThrow(RangeError);
    expect(() =>
      recoverySecondsFromIteratorAge({
        iteratorAgeSeconds: Number.NaN,
        arrivalPerMinute: 2_000,
        capacityPerMinute: 657,
      })
    ).toThrow(RangeError);
    expect(() =>
      recoverySecondsFromIteratorAge({
        iteratorAgeSeconds: 598,
        arrivalPerMinute: Number.NaN,
        capacityPerMinute: 657,
      })
    ).toThrow(RangeError);
  });
});

describe("シナリオ A2 の実測との突き合わせ（回帰。docs/poc/verification-results.md §2.4）", () => {
  /**
   * A2 の実測値。この 5 つが本ファイル唯一の「実測された滞留の算術」であり、
   * §2.4 の式の誤りを露出させた根拠でもある。
   *
   * - 投入 A: 199.4 件/分（実行レコードの `actual_orders_per_minute`）
   * - 能力 C: 66.30 件/分（投入停止後の消化レートの実測。算出値 65.7 と +0.9%）
   * - 停止時点の `IteratorAge`: 598 秒（00:06 の 1 分平均）
   * - 停止時点の滞留件数: 2,002 件（直接計測。投入 2,993 − 処理済み 991）
   * - `IteratorAge` の増加速度: 0.673（定常区間 13 区間の平均 40,441ms/分）
   * - 回復時間: 30.2 分（外挿。`2,002 ÷ 66.30`）
   */
  const A2_ARRIVAL_PER_MINUTE = 199.4;
  const A2_CAPACITY_PER_MINUTE = 66.3;
  const A2_ITERATOR_AGE_AT_STOP_SECONDS = 598;
  const A2_BACKLOG_COUNT = 2_002;
  const A2_OBSERVED_GROWTH_RATE = 0.673;
  const A2_RECOVERY_MINUTES = 30.2;

  const projection = projectBacklog({
    arrivalPerMinute: A2_ARRIVAL_PER_MINUTE,
    capacityPerMinute: A2_CAPACITY_PER_MINUTE,
  });

  /** 実測に対する相対誤差 */
  const relativeError = (predicted: number, measured: number): number =>
    Math.abs(predicted - measured) / measured;

  it("増加速度 0.673 を 1% 以内で再現する（当初の式は 2.008 を返していた）", () => {
    expect(projection.iteratorAgeGrowthRate).toBeCloseTo(0.6675, 4);
    expect(relativeError(projection.iteratorAgeGrowthRate, A2_OBSERVED_GROWTH_RATE)).toBeLessThan(
      0.01
    );

    // 当初の式が返していた値。実測の 3 倍で、しかも 1 を超えている
    const beforeCorrection = (projection.loadRatio as number) - 1;
    expect(beforeCorrection).toBeCloseTo(2.008, 3);
    expect(beforeCorrection).toBeGreaterThan(1);
    expect(relativeError(beforeCorrection, A2_OBSERVED_GROWTH_RATE)).toBeGreaterThan(1.9);
  });

  it("滞留件数 2,002 件を 1% 以内で再現する（当初の式は 661 件を返していた）", () => {
    const predicted = estimateBacklogCount({
      iteratorAgeSeconds: A2_ITERATOR_AGE_AT_STOP_SECONDS,
      arrivalPerMinute: A2_ARRIVAL_PER_MINUTE,
    });

    expect(Math.round(predicted)).toBe(1_987);
    expect(relativeError(predicted, A2_BACKLOG_COUNT)).toBeLessThan(0.01);

    // 当初の式（× C）。ずれの倍率は A ÷ C そのものである
    const beforeCorrection =
      (A2_ITERATOR_AGE_AT_STOP_SECONDS / 60) * A2_CAPACITY_PER_MINUTE;
    expect(Math.round(beforeCorrection)).toBe(661);
    expect(predicted / beforeCorrection).toBeCloseTo(projection.loadRatio as number, 6);
  });

  it("回復時間 30.2 分 を 1% 以内で再現する（当初の式は 9.97 分を返していた）", () => {
    const predicted = recoverySecondsFromIteratorAge({
      iteratorAgeSeconds: A2_ITERATOR_AGE_AT_STOP_SECONDS,
      arrivalPerMinute: A2_ARRIVAL_PER_MINUTE,
      capacityPerMinute: A2_CAPACITY_PER_MINUTE,
    }) as number;

    expect(roundTo1(predicted / 60)).toBe(30);
    expect(relativeError(predicted / 60, A2_RECOVERY_MINUTES)).toBeLessThan(0.01);

    // 当初の式は IteratorAge をそのまま返していた（9.97 分）。実測との比は A ÷ C
    expect(roundTo1(A2_ITERATOR_AGE_AT_STOP_SECONDS / 60)).toBe(10);
    expect(predicted / A2_ITERATOR_AGE_AT_STOP_SECONDS).toBeCloseTo(
      projection.loadRatio as number,
      6
    );
    expect(projection.loadRatio).toBeCloseTo(3.008, 3);
  });

  it("滞留の増加率 133.1 件/分 と一致する（訂正前から正しかった式）", () => {
    expect(projection.backlogGrowthPerMinute).toBeCloseTo(133.1, 1);
  });

  it("猶予時間は約 36.0 時間（実測の傾きから求めた 35.7 時間と 1% 以内）", () => {
    const seconds = projection.secondsUntilDataLoss as number;
    expect(roundTo1(seconds / 3_600)).toBe(36);

    const fromObservedSlope = STREAMS_RETENTION_SECONDS / A2_OBSERVED_GROWTH_RATE;
    expect(roundTo1(fromObservedSlope / 3_600)).toBe(35.7);
    expect(relativeError(seconds, fromObservedSlope)).toBeLessThan(0.01);

    // 当初の式では 11.95 時間（verification-results §2.4 の「11.9 時間」）。
    // A2 は「半日で失い始める」ではなく「1 日半で失い始める」だった
    expect(
      STREAMS_RETENTION_SECONDS / ((projection.loadRatio as number) - 1) / 3_600
    ).toBeCloseTo(11.95, 2);
  });
});
