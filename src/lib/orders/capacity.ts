/**
 * 消費能力と滞留の算術（design §2.1 / §2.4。要件 20.2〜20.4）。
 *
 * ## この層の役割
 *
 * 実行レコード（`GET /executions/{id}`）と検証パラメータ（`GET /config`）が持つ
 * 「投入レート」「消費能力」「`IteratorAge`」から、画面に出す値を算出する。
 *
 * | 算出値 | design §2.4 の式 | 要件 |
 * |-------|----------------|------|
 * | 滞留の増加率 | `dB/dt = A − C` | 20.2 |
 * | `IteratorAge` の増加速度 | `d(IteratorAge)/dt = 1 − C ÷ A` | 20.2 |
 * | データロスまでの猶予 | `T_loss = 86,400 ÷ (1 − C ÷ A)` | 20.3 |
 * | 回復時間 | `T_recover = B ÷ C = 停止時点の IteratorAge × A ÷ C` | 20.4 |
 * | 滞留件数 | `B = IteratorAge × A`（design 論点 9） | 20.1 / 20.2 |
 *
 * すべて純粋関数であり I/O を持たない。単体テストの対象（design §12）。
 *
 * ## `IteratorAge` の式は A2 の実測で訂正した
 *
 * **当初の実装は分母に消費能力 C を置いていた**（`A ÷ C − 1`、`B = IteratorAge × C`、
 * 回復時間は `IteratorAge` そのもの）。`IteratorAge` を「滞留を消化しきるのに要する時間」と
 * 読み替えていたためだが、これは「先頭の未処理レコードが書かれてからの経過時間」であり、
 * **分母は投入レート A である**（design §2.4 の訂正の記録）。
 *
 * | 量 | 当初（誤り） | 現在 | A2 の実測 |
 * |----|-----------|------|---------|
 * | 滞留件数 | `IteratorAge × C` → 661 件 | `IteratorAge × A` → 1,987 件 | 直接計測 **2,002 件** |
 * | 増加速度 | `A ÷ C − 1` → 2.008 | `1 − C ÷ A` → 0.668 | **0.673** |
 * | 回復時間 | `IteratorAge` → 9.97 分 | `IteratorAge × A ÷ C` → 30.0 分 | **30.2 分** |
 *
 * **増加速度は必ず `[0, 1)` に入る**（`IteratorAge` は経過時間であり、実時間 1 秒あたり
 * 1 秒より速く古くなりえない）。当初の式は上に有界でなく、この一点で誤りと分かる形だった。
 * 単体テストにこの不変条件を置いてある。
 *
 * ## Lambda 側の `capacity.ts` と意図的に重複させている
 *
 * `amplify/functions/shared/capacity.ts` に `S × P ÷ D`（design §2.1）の実装があるが、
 * **そこから import しない**（要件 18.6 / design §5.3）。`types.ts` の型を
 * Lambda 側と重複させているのと同じ理由である。`amplify/` は `tsconfig.json` の
 * `exclude` に入っており、フロントエンドの型検査の対象外でもある。
 *
 * **`S × P ÷ D` の定義を変えるときは両方を更新すること。**
 * 出典は `amplify/functions/shared/capacity.ts` である。
 *
 * 重複しているのは `estimateCapacityPerMinute` と `resolveRecordProcessingMs` の
 * 2 つだけで、滞留の算術（増加率・`IteratorAge` の増加速度・猶予時間・回復時間）は
 * Lambda 側に無い。Lambda が要るのは「見積もりを実行レコードに刻む」ことだけで、
 * 予測は画面側の仕事である（design §11.2 の比較表）。
 *
 * 逆にこちらへ持ち込まなかったものもある。
 *
 * | Lambda 側にあるもの | 持ち込まない理由 |
 * |------------------|----------------|
 * | `buildCapacityEstimate` | `CapacityEstimate` は `GET /config` の応答として届く。画面が組み立て直すと、根拠のない `shardCountSource` を名乗ることになる（design Property 10） |
 * | `ASSUMED_OPEN_SHARD_COUNT` | S の出典は API 応答のみ。画面側に暫定値を置くと出典が二重になる |
 * | `ASSUMED_STAGE_OVERHEAD_MS` | 同上。D のオーバーヘッド想定は `CapacityEstimate.assumedOverheadMs` から受け取る |
 */

import { type StageDelaysMs } from "./types";

// ─── 定数 ────────────────────────────────────────────────────────

/**
 * DynamoDB Streams の保持期限（秒）。24 時間（design §2.2 の #10 / §2.4）。
 *
 * `IteratorAge` がこの値に達した時点でレコードのトリムが始まる。
 * トリムは ESM の失敗ではないため DLQ には入らない（design §E-4）。
 */
export const STREAMS_RETENTION_SECONDS = 86_400;

/** 1 分のミリ秒数 */
const MS_PER_MINUTE = 60_000;

/** 1 分の秒数 */
const SECONDS_PER_MINUTE = 60;

// ─── 入力の検証 ───────────────────────────────────────────────────

/**
 * 有限かつ非負の数であることを確かめる。
 *
 * この層の入力は API 応答（外部入力）と画面の入力欄であり、`null` を
 * `Number()` に通した `0` や、桁あふれした `Infinity` が届きうる。
 * 負の投入レートや負の消費能力に意味を与えるより、その場で弾いたほうが
 * 「なぜ猶予時間が負なのか」を後から調べる手間を省ける。
 *
 * @throws {RangeError} 数値でない、非有限、または負の場合
 */
function requireNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} は 0 以上の有限な数でなければなりません: ${value}`);
  }
  return value;
}

// ─── 消費能力（design §2.1）────────────────────────────────────────

/**
 * 消費能力 C（件/分）を返す（design §2.1: `消費能力 = S × P ÷ D`）。
 *
 * `BatchSize` は式に現れない。バッチ内を直列処理する限り
 * `S × P × BatchSize ÷ (BatchSize × D)` は約分される（design §2.1）。
 *
 * 引数の形は Lambda 側の同名関数と揃えてある。片方だけ変えたことに
 * 気づけるようにするためで、見比べる以外の担保は無い（要件 18.6 により
 * import で縛れない）。
 *
 * @throws {RangeError} D が 0 以下、または非有限の場合（消費能力が定義できない）
 * @throws {RangeError} S・P が負、または非有限の場合
 */
export function estimateCapacityPerMinute(input: {
  /** S: オープンシャード数 */
  shardCount: number;
  /** P: 並列化係数 */
  parallelizationFactor: number;
  /** D: 1 レコードの処理時間（ミリ秒） */
  recordProcessingMs: number;
}): number {
  requireNonNegative(input.shardCount, "オープンシャード数 (S)");
  requireNonNegative(input.parallelizationFactor, "並列化係数 (P)");
  if (!Number.isFinite(input.recordProcessingMs) || input.recordProcessingMs <= 0) {
    throw new RangeError(
      `1 レコードの処理時間 (D) は正の有限な数でなければなりません: ${input.recordProcessingMs}`
    );
  }

  const concurrency = input.shardCount * input.parallelizationFactor;
  return (concurrency * MS_PER_MINUTE) / input.recordProcessingMs;
}

/**
 * 擬似待機の合計から D（ミリ秒）を求める。
 *
 * 待機を持つ段階は決済と通知の 2 つだけ（design §10.1）。引当とポイント付与は
 * 待機を挟まないため、その所要時間は `assumedOverheadMs` に含めて扱う。
 *
 * Lambda 側と違い `assumedOverheadMs` に既定値を持たない。オーバーヘッドの
 * 想定値はデプロイ済みの Lambda が返すもの（`CapacityEstimate.assumedOverheadMs`）
 * であって、画面側が独自に決めてよい値ではない（design §5.8 と同じ理由）。
 *
 * @throws {RangeError} いずれかの値が負、または非有限の場合
 */
export function resolveRecordProcessingMs(input: {
  stageDelaysMs: StageDelaysMs;
  /** 擬似待機以外のオーバーヘッドの想定値。出典は `GET /config` の応答 */
  assumedOverheadMs: number;
}): number {
  requireNonNegative(input.stageDelaysMs.payment, "決済の擬似処理時間");
  requireNonNegative(input.stageDelaysMs.notification, "通知の擬似処理時間");
  requireNonNegative(input.assumedOverheadMs, "オーバーヘッドの想定値");

  return input.stageDelaysMs.payment + input.stageDelaysMs.notification + input.assumedOverheadMs;
}

// ─── 滞留の算術（design §2.4）──────────────────────────────────────

/**
 * 滞留の状況。画面はまずこれで分岐する。
 *
 * | 種別 | 条件 | 意味 |
 * |------|------|------|
 * | `DRAINING` | `A < C` | 投入が消費能力を下回る。滞留は増えず、あれば消化されていく |
 * | `STEADY` | `A === C` | 均衡。滞留は増えないが、既存の滞留も減らない |
 * | `GROWING` | `A > C`（かつ `C > 0`） | design §2.3 の段階 1。滞留が線形に増加し、放置するとデータロスに至る |
 * | `STALLED` | `C === 0`（かつ `A > 0`） | 消費が完全に止まっている。`A ÷ C` は定義できないが、滞留の算術は `GROWING` と同じ式で通る |
 */
export type BacklogRegime = "DRAINING" | "STEADY" | "GROWING" | "STALLED";

/**
 * 滞留の予測（design §2.4）。
 *
 * `secondsUntilDataLoss` が `null` を取ることが、この型の設計上の要点である。
 * 詳細は当該フィールドのコメントを参照。
 */
export interface BacklogProjection {
  /** A: 投入レート（件/分） */
  arrivalPerMinute: number;
  /** C: 消費能力（件/分） */
  capacityPerMinute: number;
  regime: BacklogRegime;
  /**
   * `A ÷ C`（無次元）。「消費能力の何倍のバズか」。
   * `C = 0` では定義できないため `null`
   */
  loadRatio: number | null;
  /**
   * 滞留の増加率 `dB/dt = A − C`（件/分。要件 20.2）。
   *
   * 滞留しない場合（`A ≤ C`）は負の値ではなく `0` を返す。滞留件数は 0 を下回らず、
   * 「−600 件/分で増加している」は観測しうる量ではない。余力は
   * `surplusCapacityPerMinute` で別に持つ。
   */
  backlogGrowthPerMinute: number;
  /** 余力 `C − A`（件/分）。滞留している場合は `0` */
  surplusCapacityPerMinute: number;
  /**
   * `IteratorAge` の増加速度 `d(IteratorAge)/dt = 1 − C ÷ A`（無次元。要件 20.2）。
   *
   * 実時間 1 秒あたり `IteratorAge` が何秒増えるか。投入が消費能力の 3 倍なら 0.667。
   * 滞留しない場合は `0`（`IteratorAge` は増えない）。
   *
   * **値域は `[0, 1)` である。1 に達するのは `C = 0` のときだけ**（消費が止まれば
   * 滞留の先頭は実時間と 1:1 で古くなる）。1 を超える値は取りえない。
   */
  iteratorAgeGrowthRate: number;
  /**
   * データロスまでの猶予 `T_loss = 86,400 ÷ (1 − C ÷ A)`（秒。要件 20.3）。
   *
   * **滞留しない場合は `null` を返す。`0` でも `Infinity` でもない。**
   *
   * - `0` にすると画面が「猶予 0 時間」と表示しうる。それは
   *   「データロスは起きない」の正反対の意味になる
   * - `Infinity` は `JSON.stringify` で `null` に落ちる。計測結果は
   *   `localStorage` に JSON で永続化される（design §11.4）ため、
   *   保存して読み直した瞬間に値が変わってしまう。最初から `null` にしておく
   */
  secondsUntilDataLoss: number | null;
}

/**
 * 投入レートと消費能力から滞留の予測を組み立てる（design §2.4。要件 20.2 / 20.3）。
 *
 * **`C = 0`（`STALLED`）は式の例外ではなくなった。** 当初の式
 * `d(IteratorAge)/dt = A ÷ C − 1` は `C → 0` で発散するため、
 * 「消費が止まれば `IteratorAge` は実時間と 1:1 で増える」という定義上の事実を
 * 特例として書き込んでいた。訂正後の式 `1 − C ÷ A` は `C = 0` でちょうど `1` を返し、
 * 猶予も `86,400 ÷ 1` = 保持期限そのものになる。**特例が一般式の帰結になった。**
 * 分岐が残っているのは `A ÷ C`（`loadRatio`）と `regime` のためだけである。
 *
 * @throws {RangeError} いずれかの値が負、または非有限の場合
 */
export function projectBacklog(input: {
  /** A: 投入レート（件/分）。実測値を使う（Property 11） */
  arrivalPerMinute: number;
  /** C: 消費能力（件/分）。`S × P ÷ D` の算出値 */
  capacityPerMinute: number;
}): BacklogProjection {
  const arrivalPerMinute = requireNonNegative(input.arrivalPerMinute, "投入レート (A)");
  const capacityPerMinute = requireNonNegative(input.capacityPerMinute, "消費能力 (C)");

  const base = { arrivalPerMinute, capacityPerMinute };

  // 滞留しない領域。A === C（均衡）と A === C === 0 もここに入る
  if (arrivalPerMinute <= capacityPerMinute) {
    return {
      ...base,
      regime: arrivalPerMinute === capacityPerMinute ? "STEADY" : "DRAINING",
      loadRatio: capacityPerMinute === 0 ? null : arrivalPerMinute / capacityPerMinute,
      backlogGrowthPerMinute: 0,
      surplusCapacityPerMinute: capacityPerMinute - arrivalPerMinute,
      iteratorAgeGrowthRate: 0,
      secondsUntilDataLoss: null,
    };
  }

  // design §2.3 の段階 1。滞留が線形に増加する。
  //
  // ここに来る時点で A > C ≥ 0、したがって A > 0 であり 0 除算は起きない。
  // C = 0（STALLED）も同じ式で通り、増加速度はちょうど 1 になる。
  const iteratorAgeGrowthRate = 1 - capacityPerMinute / arrivalPerMinute;

  return {
    ...base,
    regime: capacityPerMinute === 0 ? "STALLED" : "GROWING",
    // A ÷ C は C = 0 で定義できない。増加速度と違って救えないため null
    loadRatio: capacityPerMinute === 0 ? null : arrivalPerMinute / capacityPerMinute,
    backlogGrowthPerMinute: arrivalPerMinute - capacityPerMinute,
    surplusCapacityPerMinute: 0,
    iteratorAgeGrowthRate,
    // IteratorAge は 0 から増加速度で伸び、86,400 秒でトリムが始まる。
    // 増加速度は (0, 1] なので、猶予が保持期限を下回ることはない
    secondsUntilDataLoss: STREAMS_RETENTION_SECONDS / iteratorAgeGrowthRate,
  };
}

/**
 * `IteratorAge` から滞留件数 B を導出する（design §2.4 の `B = IteratorAge × A` / 論点 9）。
 *
 * `IteratorAge` は CloudWatch が提供する唯一の滞留指標だが、単位は時間であって
 * 件数ではない。件数はこの関係式から導く（design 論点 9）。
 *
 * **掛けるのは投入レート A である。消費能力 C ではない。** 先頭の未処理レコードは
 * `IteratorAge` 前に書かれており、それ以降に A で書かれた分がすべて未処理で残っている。
 * 当初は C を掛けていたが、A2 では実測 2,002 件に対して 661 件（`A ÷ C` = 3.01 倍のずれ）
 * を返していた。訂正後は 1,987 件で誤差 0.7% である（ファイル冒頭の表）。
 *
 * `A = 0` なら 0 を返す。投入が無ければ滞留も無い（式からそのまま出る）。
 * C は要らない。滞留件数は消費能力に依存しない。
 *
 * @throws {RangeError} いずれかの値が負、または非有限の場合
 */
export function estimateBacklogCount(input: {
  /** 観測した `IteratorAge`（秒） */
  iteratorAgeSeconds: number;
  /** A: 投入レート（件/分）。実測値を使う（Property 11） */
  arrivalPerMinute: number;
}): number {
  const iteratorAgeSeconds = requireNonNegative(input.iteratorAgeSeconds, "IteratorAge");
  const arrivalPerMinute = requireNonNegative(input.arrivalPerMinute, "投入レート (A)");

  return (iteratorAgeSeconds / SECONDS_PER_MINUTE) * arrivalPerMinute;
}

/**
 * 滞留を消化しきるまでの回復時間（秒）を返す（design §2.4: `T_recover = B ÷ C`。要件 20.4）。
 *
 * 滞留が無ければ 0。`C = 0` で滞留が残っている場合は `null`（消化されないため
 * 回復時間が存在しない）。`Infinity` を返さないのは
 * `BacklogProjection.secondsUntilDataLoss` と同じ理由である。
 *
 * @throws {RangeError} いずれかの値が負、または非有限の場合
 */
export function estimateRecoverySeconds(input: {
  /** B: 投入を止めた時点の滞留件数 */
  backlogCount: number;
  /** C: 消費能力（件/分） */
  capacityPerMinute: number;
}): number | null {
  const backlogCount = requireNonNegative(input.backlogCount, "滞留件数 (B)");
  const capacityPerMinute = requireNonNegative(input.capacityPerMinute, "消費能力 (C)");

  if (backlogCount === 0) {
    return 0;
  }
  if (capacityPerMinute === 0) {
    return null;
  }
  return (backlogCount / capacityPerMinute) * SECONDS_PER_MINUTE;
}

/**
 * 投入を止めた時点の `IteratorAge`（秒）から回復時間（秒）を求める
 * （design §2.4: `T_recover = B ÷ C = 停止時点の IteratorAge × A ÷ C`。要件 20.4）。
 *
 * **`IteratorAge` をそのまま返してはならない。`A ÷ C` を掛ける。**
 * 当初この関数は恒等関数であり、「回復時間は `IteratorAge` のグラフから直接読める」
 * という design §2.4 の主張を体現していた。**その主張は誤りだった。**
 * A2 では停止時点の `IteratorAge` 598 秒 に対して実測の回復は 30.2 分 = 1,812 秒 で、
 * 比は `A ÷ C` = 3.008 だった（ファイル冒頭の表）。
 * 恒等が成り立つのは `A = C` のときだけである。
 *
 * 掛ける A は負荷生成の実行レコードに記録されている（design 論点 10）ので、
 * 「グラフ 1 枚で読める」という利点が失われただけで、算出は変わらず容易である。
 *
 * `C = 0` で滞留が残っている場合は `null`（消化されないため回復時間が存在しない）。
 * `estimateRecoverySeconds` と揃えてある。
 *
 * `estimateBacklogCount` → `estimateRecoverySeconds` の経路と一致することは
 * 単体テストで確認している（`(IteratorAge × A) ÷ C` と同じ式である）。
 *
 * @throws {RangeError} いずれかの値が負、または非有限の場合
 */
export function recoverySecondsFromIteratorAge(input: {
  /** 投入を止めた時点の `IteratorAge`（秒） */
  iteratorAgeSeconds: number;
  /** A: 投入レート（件/分）。実測値を使う（Property 11） */
  arrivalPerMinute: number;
  /** C: 消費能力（件/分） */
  capacityPerMinute: number;
}): number | null {
  const iteratorAgeSeconds = requireNonNegative(input.iteratorAgeSeconds, "IteratorAge");
  const arrivalPerMinute = requireNonNegative(input.arrivalPerMinute, "投入レート (A)");
  const capacityPerMinute = requireNonNegative(input.capacityPerMinute, "消費能力 (C)");

  return estimateRecoverySeconds({
    backlogCount: estimateBacklogCount({ iteratorAgeSeconds, arrivalPerMinute }),
    capacityPerMinute,
  });
}
