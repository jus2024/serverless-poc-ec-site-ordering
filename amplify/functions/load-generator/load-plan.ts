/**
 * 投入ペースの算術と自己再帰の判定（要件 11.1〜11.3 / 11.9 / 11.11、design 論点 2 / 論点 10）。
 *
 * 時間と AWS 呼び出しを扱わない純粋関数だけを置く。ワーカー（`handler.ts`）は
 * ここが返した計画に従って `BatchWriteItem` を送り、待つ。
 * 投入レートは計測結果の解釈に直結する（要件 11.11。目標と実測が乖離すると
 * design §2.4 の全ての算出が狂う）ため、レートを決める算術は
 * AWS 抜きで検証できる形にしておく（design §12）。
 */

import {
  PEAK_FRACTION,
  RAMP_DOWN_FRACTION,
  RAMP_UP_FRACTION,
  loadFactorAt,
} from '../shared/load-curve.js';

/** 1 分のミリ秒数 */
const MS_PER_MINUTE = 60_000;

/**
 * 投入ループの 1 刻みの長さ（ミリ秒）。
 *
 * 1 秒にしているのは、目標レート（件/分）を 60 で割った値がそのまま
 * 1 刻みの投入件数になり、ログと実行レコードの読み解きが単純になるからである。
 * 16,000 件/分（= 267 件/秒 = `BatchWriteItem` 11 回）でも 1 刻みに収まる規模で、
 * これ以上刻みを細かくすると 1 回あたりの送信件数が減って往復のオーバーヘッドが増える。
 */
export const TICK_INTERVAL_MS = 1_000;

/**
 * 自己再帰へ切り替える残り実行時間の閾値（ミリ秒）。
 *
 * ワーカーの残り時間がこれを切ったら、次の刻みを始めずに引き継ぐ。
 * 30 秒あれば 1 刻み（1 秒）・実行レコードの更新・自己 invoke は十分に終わる。
 * 余裕を大きめに取っているのは、タイムアウトで強制終了されると
 * **引き継ぎが行われず投入が静かに止まる**（実行レコードは `RUNNING` のまま残り、
 * 検証者は投入が続いていると誤解する）ためである。
 * 早めに引き継いで空白を作る方が、気づけない停止より害が小さい。
 */
export const HANDOFF_THRESHOLD_MS = 30_000;

/**
 * 自己 invoke の世代数の上限。
 *
 * 継続時間の上限 7,200 秒（`ORDER_MAX_DURATION_SECONDS` の最大値）を
 * 1 世代あたり約 14.5 分（Lambda タイムアウト 15 分 − 閾値 30 秒）で刻むと
 * 9 世代で足りる。この桁を大きく超えるのは引き継ぎ条件の判定が壊れている場合なので、
 * 上限で打ち切って `FAILED` にする。無限に invoke を続けて課金を伸ばさないための保険。
 */
export const MAX_WORKER_GENERATIONS = 64;

/**
 * 実行レコードへ進捗（投入件数）を書き出す間隔（ミリ秒）。
 *
 * 5 秒。要件 11.6 は投入件数の照会を求めるが、1 刻みごとに書くと
 * 投入レートと同じ頻度で実行管理テーブルへ書き込むことになる。
 * 実行管理テーブルは注文テーブルと別なので測定を直接は歪めないが、
 * ワーカーの時間を投入以外に使う分だけ到達レートが落ちる。
 * 検証者が画面をポーリングする間隔（数秒）に対して 5 秒あれば十分である。
 */
export const PROGRESS_FLUSH_INTERVAL_MS = 5_000;

/**
 * 目標レートと実測レートの乖離を警告と見なす閾値（比率。要件 11.11、design 論点 10）。
 *
 * 10% にしている。投入は 1 秒刻みで端数を繰り越すため、
 * 数パーセントのずれは刻みの丸めと Lambda の起動間隔から常に生じる。
 * それを毎回警告にすると警告が意味を失う。一方、消費能力との比較で
 * 壁の位置を語るには 1 割のずれは無視できない（design §2.4 の算術が
 * 投入レートを分子に持つため、10% のずれは猶予時間の見積もりを 10% 動かす）。
 */
export const RATE_DEVIATION_THRESHOLD = 0.1;

/**
 * 負荷カーブを使った場合の平均係数（design 論点 2 の区間表から導出）。
 *
 * 漸増区間は平均 0.5、ピーク区間は 1、漸減区間は平均 0.5 なので
 * `0.3 × 0.5 + 0.4 × 1 + 0.3 × 0.5 = 0.7`。
 *
 * **この係数を掛けずに目標レートと実測レートを比べてはならない。**
 * カーブ実行では実測の平均が目標（ピーク値）の 7 割になるのが正常であり、
 * 素の目標と比べると必ず 30% の乖離として警告が立つ（要件 11.11 の警告が
 * 常時点灯して使えなくなる）。区間の割合は `shared/load-curve.ts` から
 * 読み込んで導出しており、カーブの定義を変えればここも追随する。
 */
export const AVERAGE_RAMP_FACTOR =
  RAMP_UP_FRACTION / 2 + PEAK_FRACTION + RAMP_DOWN_FRACTION / 2;

/**
 * 切り捨ての境界を跨がせるための許容誤差（件）。
 *
 * 端数の繰り越しは二進小数で厳密に表せない（2 件/分 = 1 刻みあたり 1/30 件）。
 * 30 刻み後の累積は 1 ではなく 0.9999999999999999 になり、素朴に切り捨てると
 * **投入が 1 刻み分遅れ続ける**。1e-9 件は投入件数として意味を持たない大きさなので、
 * これを足して境界を跨がせる。
 */
const FLOOR_EPSILON = 1e-9;

/** ワーカーが 1 刻みで何をするか */
export type TickAction =
  /** 投入を続ける */
  | 'TICK'
  /** 残り時間が足りない。自身を非同期 invoke して引き継ぐ（要件 11.9） */
  | 'HANDOFF'
  /** 継続時間に達した。実行を完了させる */
  | 'FINISH';

export interface ResolveTickActionInput {
  /** 実行開始からの累積経過時間（ミリ秒。自己再帰を跨いで累積する） */
  elapsedMs: number;
  /** 実行の継続時間（秒） */
  durationSeconds: number;
  /** この invoke の残り実行時間（ミリ秒。`context.getRemainingTimeInMillis()`） */
  remainingInvokeMs: number;
  /** 引き継ぎの閾値（ミリ秒）。既定は `HANDOFF_THRESHOLD_MS` */
  handoffThresholdMs?: number;
}

/**
 * 次に取る行動を決める。
 *
 * 継続時間の判定を残り時間の判定より**先**に行う。順序を逆にすると、
 * 実行の最後の刻みがちょうど閾値に掛かったときに
 * 「もう投入するものが無いのに引き継ぐ」空の世代が生まれる。
 */
export function resolveTickAction(input: ResolveTickActionInput): TickAction {
  const thresholdMs = input.handoffThresholdMs ?? HANDOFF_THRESHOLD_MS;

  if (input.elapsedMs >= input.durationSeconds * 1_000) {
    return 'FINISH';
  }
  if (input.remainingInvokeMs <= thresholdMs) {
    return 'HANDOFF';
  }
  return 'TICK';
}

export interface PlanTickInput {
  /** 目標投入レート（件/分） */
  targetOrdersPerMinute: number;
  /** 実行開始からの累積経過時間（ミリ秒） */
  elapsedMs: number;
  /** 実行の継続時間（秒） */
  durationSeconds: number;
  /** 負荷カーブを使うか（要件 11.2 / 11.3） */
  useRampCurve: boolean;
  /** 前の刻みから繰り越した端数（0 以上 1 未満） */
  carry: number;
  /**
   * この刻みが対象とする時間の長さ（ミリ秒）。既定は `TICK_INTERVAL_MS`。
   *
   * ワーカーは**前の刻みからの実経過時間**を渡す。`BatchWriteItem` が遅れて
   * 1 刻みが 1 秒を超えたとき、固定値を渡していると投入件数が実時間に追いつかず、
   * 遅れが累積して実測レートが目標を下回り続ける（要件 11.11 の警告が立つ）。
   * 実経過時間で計画すれば、遅れた分だけ次の刻みで多く投入して自己補正する。
   */
  tickMs?: number;
}

export interface TickPlan {
  /** この刻みで投入する件数 */
  orders: number;
  /** 次の刻みへ繰り越す端数 */
  carry: number;
  /** この刻みに適用した負荷係数（ログ用。要件 11.2 の確認に使う） */
  factor: number;
}

/**
 * 1 刻みの投入件数を決める。
 *
 * ## 端数を繰り越す理由
 *
 * 目標 2 件/分（要件 11.7 の下限）は 1 秒あたり 0.033 件である。
 * 刻みごとに四捨五入すると毎回 0 件になり、**実測レートが 0 になる**。
 * 端数を次の刻みへ繰り越すことで、30 秒に 1 件という低レートも表現できる。
 * 逆に高レート側でも、繰り越しがあるため長時間の累積が目標に収束する
 * （切り捨ての誤差が積み上がらない）。
 */
export function planTick(input: PlanTickInput): TickPlan {
  const tickMs = input.tickMs ?? TICK_INTERVAL_MS;
  const factor = loadFactorAt({
    elapsedSeconds: input.elapsedMs / 1_000,
    durationSeconds: input.durationSeconds,
    useRampCurve: input.useRampCurve,
  });

  const exact =
    input.carry + (input.targetOrdersPerMinute * factor * tickMs) / MS_PER_MINUTE;
  const orders = Math.floor(exact + FLOOR_EPSILON);

  // 誤差の補正で `exact` をわずかに超えることがあるため 0 で下限を切る
  return { orders, carry: Math.max(0, exact - orders), factor };
}

export interface PlanBackfillInput {
  /** 目標投入レート（件/分。カーブ実行ではピーク値） */
  targetOrdersPerMinute: number;
  /** 実行の継続時間（秒） */
  durationSeconds: number;
  /** 負荷カーブを使うか（要件 11.2 / 11.3） */
  useRampCurve: boolean;
  /** この実行全体でこれまでに計画（投入試行）した件数の累計（世代を跨いで累積する） */
  plannedTotal: number;
}

export interface BackfillPlan {
  /** FINISH 時に最後にまとめて投入する補填件数（0 以上） */
  orders: number;
}

/**
 * この実行で投入されるべき理論総数を返す。
 *
 * - 定常負荷（`useRampCurve=false`）: `floor(rate * duration / 60)`。
 *   2 件/分 × 60 秒 = 2、60 件/分 × 60 秒 = 60、2000 件/分 × 60 秒 = 2000。
 * - カーブ（`useRampCurve=true`）: 各刻みの係数を積分する代わりに、
 *   評価と同じ平均係数（`AVERAGE_RAMP_FACTOR` = 0.7）を掛けた
 *   `floor(rate * duration / 60 * 0.7)` で近似する。`evaluateRate` の
 *   期待レート（`expectedOrdersPerMinute`）と同じ根拠なので整合する。
 *
 * `FLOOR_EPSILON` を足すのは二進小数の切り捨て境界を跨がせるため（`planTick` と同じ）。
 */
export function theoreticalTotalOrders(input: {
  targetOrdersPerMinute: number;
  durationSeconds: number;
  useRampCurve: boolean;
}): number {
  const peakTotal = (input.targetOrdersPerMinute * input.durationSeconds) / 60;
  const total = input.useRampCurve ? peakTotal * AVERAGE_RAMP_FACTOR : peakTotal;
  return Math.floor(total + FLOOR_EPSILON);
}

/**
 * FINISH 時に「理論総数と実計画数の差」をまとめて確定する（末尾の取りこぼし修正）。
 *
 * ## なぜ理論総数ベースなのか（末尾 1 刻みでは足りない）
 *
 * ワーカーは 1 秒刻みで投入し、端数を `carry` に繰り越す。FINISH（継続時間到達）は
 * ループ先頭で判定されるため、継続時間ちょうどの最後の刻みで確定するはずだった
 * 投入が落ちる。前回は「末尾の 1 刻み分（`tickMs = durationMs − 直前の elapsedMs`、
 * 通常数百 ms）＋残 carry」だけを埋め戻したが、**末尾 1 刻みの端数では carry が
 * 1.0 に届かず 0 件のまま**で、実機で 2 件/分 × 60 秒 が依然 1 件だった
 * （CloudWatch で `submittedCount:1` を確認済み）。そこで末尾 1 刻みではなく、
 * この実行全体の**理論総数と実計画数の帳尻**を合わせる。
 *
 * ## 過剰投入しない仕組み
 *
 * 補填件数は `max(0, 理論総数 − plannedTotal)`。差が負（既に理論総数以上を
 * 計画済み）なら 0 を返すため、総投入数が理論総数を超えることはない。
 *
 * ## 基準を submittedCount ではなく plannedTotal にする理由
 *
 * 補填は「計画どおり投入する」のが目的であって、書き込みエラーの穴埋めではない。
 * そのため基準は「これまで `planTick` が計画した件数の累計（`plannedTotal`）」とし、
 * 書き込みに失敗した分（`submitErrorCount`）を埋め直したりはしない。
 *
 * ## 大量・長時間の実行に影響しない理由
 *
 * 大量・長時間では `plannedTotal` が刻みの積み上げでほぼ理論総数に一致するため、
 * 補填は 0〜1 件に収まり、既存の実測結果（`docs/poc/verification-results.md`）は
 * 変わらない。効くのは低レート（端数が 1 件に満たないまま実行が終わる）だけである。
 */
export function planBackfill(input: PlanBackfillInput): BackfillPlan {
  const theoretical = theoreticalTotalOrders({
    targetOrdersPerMinute: input.targetOrdersPerMinute,
    durationSeconds: input.durationSeconds,
    useRampCurve: input.useRampCurve,
  });
  return { orders: Math.max(0, theoretical - input.plannedTotal) };
}

export interface RateEvaluationInput {
  /** 目標投入レート（件/分。カーブ実行ではピーク値） */
  targetOrdersPerMinute: number;
  /** 負荷カーブを使ったか */
  useRampCurve: boolean;
  /** 実際に書き込めた件数 */
  submittedCount: number;
  /** 実行開始からの累積経過時間（ミリ秒） */
  elapsedMs: number;
  /** 乖離の閾値（比率）。既定は `RATE_DEVIATION_THRESHOLD` */
  threshold?: number;
}

/** 実測レートの評価結果（実行レコードの `actual_orders_per_minute` などに対応） */
export interface RateEvaluation {
  /** 実測投入レート（件/分。要件 11.11） */
  actualOrdersPerMinute: number;
  /** この実行条件で期待される平均レート（件/分） */
  expectedOrdersPerMinute: number;
  /** 期待レートに対する乖離（比率。0.12 なら 12% ずれている） */
  deviationRatio: number;
  /** 乖離が閾値を超えた（design 論点 10。この実行は §2.4 の算術に使わない） */
  rateDeviationWarning: boolean;
}

/**
 * 期待される平均投入レート（件/分）を返す。
 *
 * 定常負荷なら目標そのまま、カーブなら目標 × 0.7（`AVERAGE_RAMP_FACTOR`）。
 */
export function expectedOrdersPerMinute(input: {
  targetOrdersPerMinute: number;
  useRampCurve: boolean;
}): number {
  return input.useRampCurve
    ? input.targetOrdersPerMinute * AVERAGE_RAMP_FACTOR
    : input.targetOrdersPerMinute;
}

/**
 * 実測投入レートと目標との乖離を評価する（要件 11.11、design 論点 10）。
 *
 * 経過時間が 0 以下の場合はレートを定義できないため 0 件/分として扱い、
 * 警告も立てない（判定材料が無い状態で警告を出すと、実行レコードを
 * 見た検証者が「投入が失敗した」と誤読する）。
 */
export function evaluateRate(input: RateEvaluationInput): RateEvaluation {
  const threshold = input.threshold ?? RATE_DEVIATION_THRESHOLD;
  const expected = expectedOrdersPerMinute(input);

  if (input.elapsedMs <= 0) {
    return {
      actualOrdersPerMinute: 0,
      expectedOrdersPerMinute: expected,
      deviationRatio: 0,
      rateDeviationWarning: false,
    };
  }

  const actual = roundRate((input.submittedCount * MS_PER_MINUTE) / input.elapsedMs);
  const deviationRatio = expected > 0 ? Math.abs(actual - expected) / expected : 0;

  return {
    actualOrdersPerMinute: actual,
    expectedOrdersPerMinute: roundRate(expected),
    deviationRatio,
    rateDeviationWarning: deviationRatio > threshold,
  };
}

/**
 * レートを小数第 1 位に丸める。
 *
 * 低レート（2 件/分）では整数に丸めると意味のある差が消え、
 * 高レート（16,000 件/分）では小数を残しても情報にならない。
 * 実行レコードを人が読む値なので、両方に耐える桁で止める。
 */
function roundRate(value: number): number {
  return Math.round(value * 10) / 10;
}
