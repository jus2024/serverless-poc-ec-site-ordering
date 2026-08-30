/**
 * Streams レコードの読み取りと部分バッチ応答の組み立て（design §5.5、要件 9.8）。
 *
 * ハンドラから純粋関数として切り出しているのは、AWS への接続を伴わずに
 * 「レコードから何を取り出すか」「どのレコードを再試行対象として返すか」を
 * 単体テストするためである（design §12）。
 *
 * ## 注文テーブルを読み直さない（要件 4.1 / design §5.5）
 *
 * ストリームの `NewImage` には `items` / `total_amount` / `customer_id` が含まれる
 * （`StreamViewType = NEW_AND_OLD_IMAGES`。design §4.2）。したがって後続処理は
 * **注文レコードを読み直さない**。RCU を節約できるうえ、高負荷時に照会系
 * （`order-query`）と同じテーブルで読み取りを競合させないための判断でもある。
 *
 * この選択の代償は、`NewImage` に無い属性を後続処理が使えないことである。
 * 段階を増やして新しい属性が必要になったときは、注文受付側（`order-accept` /
 * 負荷生成）が `PutItem` の時点でその属性を書いていなければならない。
 *
 * ## `INSERT` 以外を処理しない（Property 8 / 要件 9.7）
 *
 * 本来は ESM のイベントフィルタ（`eventName = INSERT`。design §5.6）が
 * `MODIFY` を届けない。それでもここで弾くのは、フィルタの設定漏れが
 * **1 周ごとに 4 倍でイベントが増える無限ループ**として現れるためである
 * （後続処理は 1 注文につき注文レコードを 4 回更新する）。
 * 静かに増幅させず、警告ログを残して止める。フィルタの設定漏れ自体は
 * ログの警告件数で気づける。
 */

import type { AttributeValue as SdkAttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type {
  AttributeValue as StreamAttributeValue,
  DynamoDBBatchItemFailure,
  DynamoDBRecord,
} from 'aws-lambda';
import type { OrderItem } from '../shared/types.js';

/** 後続処理が対象にするイベント種別（要件 9.7） */
export const PROCESSED_EVENT_NAME = 'INSERT';

/**
 * 後続処理が必要とする注文情報。
 *
 * `OrderRecord` そのままではなく必要な項目に絞っているのは、
 * 「ストリームから何を受け取れば 4 段階が回るのか」を型で明示するためである。
 * 段階が追加のフィールドを要求し始めたら、この型を広げる前に
 * それが `NewImage` に必ず存在するか（受付側が必ず書いているか）を確かめること。
 */
export interface StreamOrder {
  /** PK: `ORD#{ULID}` */
  orderId: string;
  /** SK: `CUST#{customer-id}` */
  customerId: string;
  /** 注文明細。引当と通知の双方が使う */
  items: OrderItem[];
  /** 注文合計（税込）。ポイント算出の元になる（要件 7.1） */
  totalAmount: number;
  /** 負荷テスト実行 ID。ログの相関に使う。手動投入の注文には無い */
  loadTestId: string | null;
}

/**
 * 処理できないストリームレコード（属性の欠落・型違い）。
 *
 * **技術的な失敗として扱わない**（`batchItemFailures` に積まない）。
 * 再試行しても同じレコードが同じ理由で失敗するだけで、
 * 業務的な失敗を再試行しない理由（design §E-2）とまったく同じ構図になる。
 * 3 回の再試行と DLQ 送信でシャードを塞ぎ、滞留の観測を汚す方が有害である。
 *
 * 起きるのは注文レコードの形が変わったとき（= 実装の不整合）なので、
 * ハンドラは ERROR ログにシーケンス番号を添えて残す。
 */
export class InvalidStreamRecordError extends Error {
  readonly sequenceNumber: string | null;

  constructor(message: string, sequenceNumber: string | null) {
    super(message);
    this.name = 'InvalidStreamRecordError';
    this.sequenceNumber = sequenceNumber;
  }
}

/** レコードのシーケンス番号（部分バッチ応答の識別子。無ければ `null`） */
export function sequenceNumberOf(record: DynamoDBRecord): string | null {
  return record.dynamodb?.SequenceNumber ?? null;
}

/** 後続処理の対象か（`INSERT` のみ。要件 9.7） */
export function isProcessedEvent(record: DynamoDBRecord): boolean {
  return record.eventName === PROCESSED_EVENT_NAME;
}

/**
 * `NewImage` から注文情報を取り出す。
 *
 * @throws {InvalidStreamRecordError} `NewImage` が無い、または必須属性が欠けている場合
 */
export function toStreamOrder(record: DynamoDBRecord): StreamOrder {
  const sequenceNumber = sequenceNumberOf(record);
  const image = record.dynamodb?.NewImage;
  if (image === undefined) {
    throw new InvalidStreamRecordError(
      'ストリームレコードに NewImage がありません（StreamViewType の設定を確認してください）',
      sequenceNumber
    );
  }

  const item = unmarshallImage(image);

  return {
    orderId: readString(item, 'order_id', sequenceNumber),
    customerId: readString(item, 'customer_id', sequenceNumber),
    items: readItems(item.items, sequenceNumber),
    totalAmount: readNumber(item, 'total_amount', sequenceNumber),
    loadTestId: typeof item.load_test_id === 'string' ? item.load_test_id : null,
  };
}

/**
 * 部分バッチ応答を組み立てる（design §5.5、要件 9.8）。
 *
 * DynamoDB Streams は順序を保証するため、**最初に失敗したレコードとそれ以降を
 * まとめて再試行対象にする**。先頭の 1 件を飛ばして後続だけ成功させると
 * 注文の処理順が入れ替わるうえ、飛ばしたレコードは二度と処理されない。
 *
 * @param records 受け取ったレコード（ストリームの順序のまま）
 * @param firstFailedIndex 最初に技術的な失敗が出たレコードの位置
 * @returns 再試行対象の識別子。シーケンス番号を持たないレコードが含まれる場合は `null`
 *   （呼び出し側は例外を再送出し、バッチ全体を再試行させる。一部だけ報告すると
 *   報告できなかったレコードが成功扱いで失われる）
 */
export function buildBatchItemFailures(
  records: readonly DynamoDBRecord[],
  firstFailedIndex: number
): DynamoDBBatchItemFailure[] | null {
  const failures: DynamoDBBatchItemFailure[] = [];

  for (const record of records.slice(Math.max(firstFailedIndex, 0))) {
    const sequenceNumber = sequenceNumberOf(record);
    if (sequenceNumber === null) {
      return null;
    }
    failures.push({ itemIdentifier: sequenceNumber });
  }

  return failures;
}

/**
 * DynamoDB の属性値表現を素の JavaScript の値へ変換する。
 *
 * `aws-lambda` の `AttributeValue` と AWS SDK の `AttributeValue` は
 * バイナリ属性の表現が異なる（ストリームは base64 文字列、SDK は `Uint8Array`）ため
 * 構造的に代入できず、二段キャストが必要になる。
 * 注文レコードはバイナリ属性を持たない（design §4.2）ので実害はない。
 */
function unmarshallImage(
  image: Record<string, StreamAttributeValue>
): Record<string, unknown> {
  return unmarshall(image as unknown as Record<string, SdkAttributeValue>);
}

function readString(
  item: Record<string, unknown>,
  key: string,
  sequenceNumber: string | null
): string {
  const value = item[key];
  if (typeof value !== 'string' || value === '') {
    throw new InvalidStreamRecordError(
      `注文レコードの ${key} が文字列ではありません（受け取った型: ${typeName(value)}）`,
      sequenceNumber
    );
  }
  return value;
}

function readNumber(
  item: Record<string, unknown>,
  key: string,
  sequenceNumber: string | null
): number {
  const value = item[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidStreamRecordError(
      `注文レコードの ${key} が数値ではありません（受け取った型: ${typeName(value)}）`,
      sequenceNumber
    );
  }
  return value;
}

/**
 * 明細を検証する。
 *
 * 空の明細を通さないのは、引当が**アクションを 1 つも持たない
 * `TransactWriteItems`** になり `ValidationException` で落ちるためである。
 * 受付側（`order-accept`）は空配列を弾くが、負荷生成は注文テーブルへ
 * 直接書き込む（design 論点 2）ので、こちらでも確かめる。
 */
function readItems(value: unknown, sequenceNumber: string | null): OrderItem[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidStreamRecordError(
      `注文レコードの items が空でない配列ではありません（受け取った型: ${typeName(value)}）`,
      sequenceNumber
    );
  }

  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new InvalidStreamRecordError(
        `注文レコードの items[${index}] がオブジェクトではありません`,
        sequenceNumber
      );
    }
    const { sku, qty, price } = entry as Record<string, unknown>;
    if (typeof sku !== 'string' || sku === '') {
      throw new InvalidStreamRecordError(
        `注文レコードの items[${index}].sku が文字列ではありません`,
        sequenceNumber
      );
    }
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1) {
      throw new InvalidStreamRecordError(
        `注文レコードの items[${index}].qty が 1 以上の整数ではありません`,
        sequenceNumber
      );
    }
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
      throw new InvalidStreamRecordError(
        `注文レコードの items[${index}].price が 0 以上の数値ではありません`,
        sequenceNumber
      );
    }
    return { sku, qty, price };
  });
}

/** エラーメッセージ用。`null` と配列を `typeof` より具体的に表す */
function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
