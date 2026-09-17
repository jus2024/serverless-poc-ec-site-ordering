/**
 * X-Ray のサブセグメントと注文 ID の注釈（要件 13.4、design §6.3）。
 *
 * ## なぜ共有モジュールに置くのか
 *
 * API 側（`order-accept` / `order-query`）と Streams 側（`order-processor`）の
 * トレースは自動では連結されない。DynamoDB Streams がトレースコンテキストを
 * 伝播しないためである（design §6.3）。連結は 3 つの関数が**同じキーで**
 * `order_id` を注釈することだけに依存している。キーと注釈の付け方を
 * 1 か所に集めておかないと、片方だけ直したときに突き合わせが静かに壊れる。
 *
 * ## サブセグメントを開かないと注釈は消える
 *
 * Lambda 実行環境の主セグメント（ファサードセグメント）には注釈を付けられない。
 * `tracer.putAnnotation()` はそれを検知すると警告を出して**黙って捨てる**
 * （Powertools v2 の `ProviderService.putAnnotation`）。
 * ミドルウェア（`captureLambdaHandler`）を使わない構成では、
 * 自分でサブセグメントを開き、その中で注釈しなければ何も残らない。
 *
 * ## 計装は業務処理の可用性に影響してはならない
 *
 * サブセグメントを開けない場合（トレース無効、セグメント文脈なし、X-Ray SDK の
 * 例外）は、計装なしで業務処理をそのまま実行する。観測のための仕組みが
 * リクエストの成否を左右するのは筋が通らない。
 * 逆に `execute` が投げた例外は握り潰さず、サブセグメントに記録して再送出する。
 */

/** サブセグメントを開ける対象。`Segment` と `Subsegment` の共通部分 */
type TracingSegment = {
  addNewSubsegment(name: string): TracingSubsegment;
};

/** 開いたサブセグメント。閉じるまで現在のセグメントとして使う */
type TracingSubsegment = TracingSegment & {
  addError(error: Error): void;
  close(): void;
};

/**
 * この計装が使う `Tracer` の機能だけを表した型。
 *
 * Powertools の `Tracer` は構造的にこれを満たす。実体に依存しないことで
 * AWS へ接続せずに単体テストできる（`tracing.test.ts`）。
 */
export interface OrderTracer {
  getSegment(): TracingSegment | undefined;
  setSegment(segment: TracingSegment): void;
  putAnnotation(key: string, value: string): void;
}

/**
 * 注文 ID の注釈キー。3 つの関数で必ず同じ値を使う（design §6.3）。
 *
 * フィルタ式（`annotation.order_id = "ORD#..."`）で検索できるように、
 * メタデータではなくアノテーションにしている。
 */
export const ORDER_ID_ANNOTATION = 'order_id';

/** `withOrderSubsegment` の計装側の指定 */
export interface OrderSubsegmentOptions {
  tracer: OrderTracer;
  /**
   * サブセグメント名。`##` 接頭辞は Powertools が
   * 関数の処理を表すサブセグメントに使う慣習を踏襲したもの。
   */
  name: string;
  /** 注釈する注文 ID */
  orderId: string;
}

/** 開いたサブセグメントと、閉じたあとに戻す親セグメント */
interface OpenedSubsegment {
  parent: TracingSegment;
  subsegment: TracingSubsegment;
}

/**
 * 処理を X-Ray のサブセグメントで囲み、その中で `order_id` を注釈する（要件 13.4）。
 *
 * サブセグメントを開けなかったときは、囲まずに `execute` を実行する。
 * 呼び出し側から見た戻り値と例外は、計装の有無で変わらない。
 */
export async function withOrderSubsegment<T>(
  options: OrderSubsegmentOptions,
  execute: () => Promise<T>
): Promise<T> {
  const opened = openOrderSubsegment(options);
  if (opened === undefined) {
    return execute();
  }

  try {
    return await execute();
  } catch (error) {
    // 失敗したトレースも注文 ID で引けるように、エラーはサブセグメントに残す
    recordSubsegmentError(opened.subsegment, error);
    throw error;
  } finally {
    closeOrderSubsegment(options.tracer, opened);
  }
}

/**
 * サブセグメントを開き、現在のセグメントとして設定して注釈する。
 *
 * @returns 開けなかったときは `undefined`（計装なしで続行する合図）
 */
function openOrderSubsegment({
  tracer,
  name,
  orderId,
}: OrderSubsegmentOptions): OpenedSubsegment | undefined {
  let parent: TracingSegment | undefined;
  let subsegment: TracingSubsegment | undefined;

  try {
    parent = tracer.getSegment();
    if (parent === undefined) {
      // トレースが無効、または Lambda 実行環境の外
      return undefined;
    }

    subsegment = parent.addNewSubsegment(name);
    tracer.setSegment(subsegment);
    tracer.putAnnotation(ORDER_ID_ANNOTATION, orderId);
    return { parent, subsegment };
  } catch {
    // 開きかけを片付けてから計装なしで続行する。
    // 現在のセグメントを差し替えたまま放置すると、後続の計装が
    // 閉じられないサブセグメントに載ってしまう
    if (parent !== undefined && subsegment !== undefined) {
      closeOrderSubsegment(tracer, { parent, subsegment });
    }
    return undefined;
  }
}

/** サブセグメントを閉じ、現在のセグメントを親に戻す */
function closeOrderSubsegment(tracer: OrderTracer, opened: OpenedSubsegment): void {
  try {
    opened.subsegment.close();
    tracer.setSegment(opened.parent);
  } catch {
    // 計装の失敗で業務処理の結果を変えない（X-Ray SDK 自身が警告を出す）
  }
}

/** 例外をサブセグメントに記録する。記録できなくても元の例外を優先する */
function recordSubsegmentError(subsegment: TracingSubsegment, error: unknown): void {
  if (!(error instanceof Error)) {
    return;
  }

  try {
    subsegment.addError(error);
  } catch {
    // 元の例外を握り潰さないことが最優先
  }
}
