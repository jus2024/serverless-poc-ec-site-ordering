/**
 * 負荷カーブの係数計算（design 論点 2、要件 11.2 / 11.3）。
 *
 * 負荷生成ワーカーは「いま何件/分で投入するか」を毎ループ決める必要がある。
 * その係数だけをここに切り出しているのは、投入レートの時間変化が
 * 計測結果の解釈に直結するため、AWS 呼び出しから独立に検証できる形にしておきたいからである。
 *
 * ## 係数の定義（design 論点 2 の区間表）
 *
 * | 区間 | 係数 |
 * |------|------|
 * | 前半 30% | 0 → 1 に線形上昇 |
 * | 中盤 40% | 1（ピーク維持） |
 * | 後半 30% | 1 → 0 に線形下降 |
 *
 * `useRampCurve = false` なら常に 1（定常負荷）。
 * **壁の位置を測るシナリオでは定常負荷を使う。** カーブでは投入レートが時間変化するため、
 * 消費能力との交点が動いて解釈が難しくなる（design §10.2）。
 *
 * ワーカーは自己再帰で複数回の invoke に跨がるため、経過時間は
 * 「実行開始からの累積」であることを前提にしている（invoke 内の経過ではない）。
 */

/** 漸増区間が占める割合 */
export const RAMP_UP_FRACTION = 0.3;

/** ピーク維持区間が占める割合 */
export const PEAK_FRACTION = 0.4;

/** 漸減区間が占める割合 */
export const RAMP_DOWN_FRACTION = 0.3;

/** 定常負荷モードの係数（要件 11.3） */
export const CONSTANT_LOAD_FACTOR = 1;

/** 漸増区間の終わり = ピーク区間の始まり（進捗率） */
const RAMP_UP_END_PROGRESS = RAMP_UP_FRACTION;

/** ピーク区間の終わり = 漸減区間の始まり（進捗率） */
const PEAK_END_PROGRESS = RAMP_UP_FRACTION + PEAK_FRACTION;

/**
 * 進捗率（0〜1）から負荷カーブの係数を返す。
 *
 * 区間の境目（0.3 と 0.7）はどちらの区間から見ても 1 になるため、
 * 境界での不連続は生じない。範囲外の進捗率は 0〜1 に丸める
 * （開始前は 0%、終了後は 100% として扱う）。
 */
export function rampCurveFactor(progress: number): number {
  const clamped = Math.min(Math.max(progress, 0), 1);

  if (clamped < RAMP_UP_END_PROGRESS) {
    // 0 → 1 に線形上昇。progress = 0 で 0
    return clamped / RAMP_UP_FRACTION;
  }

  if (clamped <= PEAK_END_PROGRESS) {
    return 1;
  }

  // 1 → 0 に線形下降。progress = 1 で 0
  return (1 - clamped) / RAMP_DOWN_FRACTION;
}

/** 係数を求める時点の指定 */
export interface LoadFactorInput {
  /** 実行開始からの累積経過時間（秒） */
  elapsedSeconds: number;
  /** 実行の継続時間（秒） */
  durationSeconds: number;
  /** true なら負荷カーブ、false なら定常負荷（要件 11.2 / 11.3） */
  useRampCurve: boolean;
}

/**
 * 指定時点の負荷係数を返す。目標投入レートに掛けて使う。
 *
 * 継続時間が 0 以下の場合は進捗率を定義できないため、
 * 実行が終わっている（係数 0）ものとして扱う。継続時間の妥当性は
 * 開始 API 側で検証する（要件 11.9）ので、ここは保険である。
 */
export function loadFactorAt({
  elapsedSeconds,
  durationSeconds,
  useRampCurve,
}: LoadFactorInput): number {
  if (!useRampCurve) {
    return CONSTANT_LOAD_FACTOR;
  }

  if (durationSeconds <= 0) {
    return 0;
  }

  return rampCurveFactor(elapsedSeconds / durationSeconds);
}
