/**
 * 注文 API の失敗を画面の案内文に変換する（純粋関数）。
 *
 * ## なぜ生のエラーを出さないか
 *
 * `api.ts` は失敗を `kind`（CONFIG / REQUEST / NETWORK / HTTP）と
 * `code`（design §E-1）で分類して投げる。画面がこれを素の文字列として
 * 出すと、検証者は「自分の入力が悪いのか、API が落ちているのか、
 * まだデプロイしていないのか」を区別できない。ここで分類ごとに
 * 「何が起きたか」と「次に何をするか」に分けて言い換える。
 *
 * とくに `CONFIG`（要件 14.10）は、他の失敗と違って再試行では直らず
 * `.env.local` の設定が必要になる。`isConfigError` で区別し、
 * 画面はセットアップ案内として扱う。
 *
 * DOM に触らないため単体テストの対象にできる（`vitest.config.ts` の
 * `src/components/orders/**`）。
 */

import {
  INVALID_RESPONSE_CODE,
  OrderApiConfigError,
  OrderApiError,
  OrderApiFailure,
  OrderApiNetworkError,
  OrderApiRequestError,
} from "../../lib/orders/api";
import { API_ERROR_CODES } from "../../lib/orders/types";

/** 失敗した操作。同じコードでも操作によって案内が変わるため受け取る */
export type OrderApiOperation =
  | "createOrder"
  | "seedInventory"
  | "loadCatalog"
  | "getOrder"
  | "loadConfig"
  | "startLoadTest"
  | "startQueryImpact"
  | "getExecution";

/** 操作の日本語表示 */
const OPERATION_LABELS: Record<OrderApiOperation, string> = {
  createOrder: "注文の投入",
  seedInventory: "初期在庫の投入",
  loadCatalog: "商品マスタの取得",
  getOrder: "注文の照会",
  loadConfig: "検証パラメータの取得",
  startLoadTest: "負荷生成の開始",
  startQueryImpact: "並行計測の開始",
  getExecution: "実行状態の照会",
};

/** 画面に出す案内 */
export interface FailureNotice {
  /** 見出し。何が起きたか */
  title: string;
  /** 本文。原因の説明 */
  message: string;
  /** 次にやること。無ければ null */
  hint: string | null;
  /**
   * 設定不備（ベース URL 未設定）かどうか（要件 14.10）。
   * true の場合、画面は再試行ボタンではなくセットアップ手順を出す。
   */
  isConfigError: boolean;
  /** そのまま再試行して直る見込みがあるか */
  retryable: boolean;
  /** 出典（例: `HTTP 404 / ORDER_NOT_FOUND`）。分類できなければ null */
  reference: string | null;
}

/**
 * 失敗を案内文に変換する。
 *
 * @param error `api.ts` が投げた例外、または想定外の値
 * @param operation どの操作で失敗したか
 */
export function describeOrderApiFailure(
  error: unknown,
  operation: OrderApiOperation
): FailureNotice {
  const operationLabel = OPERATION_LABELS[operation];

  // ベース URL 未設定。メッセージ自体が手順を含んでいる（api.ts の案内文）
  if (error instanceof OrderApiConfigError) {
    return {
      title: "注文 API の接続先が設定されていません",
      message: error.message,
      hint: null,
      isConfigError: true,
      retryable: false,
      reference: null,
    };
  }

  // 送信前に弾いた引数不備。入力欄の誤りとして扱う
  if (error instanceof OrderApiRequestError) {
    return {
      title: "入力を確認してください",
      message: error.message,
      hint: null,
      isConfigError: false,
      retryable: false,
      reference: null,
    };
  }

  if (error instanceof OrderApiNetworkError) {
    return {
      title: `${operationLabel}に失敗しました（通信エラー）`,
      message:
        "注文 API に接続できませんでした。オフライン、CORS、または API が未デプロイの可能性があります。",
      hint: "`npx ampx sandbox` が動いていること、`NEXT_PUBLIC_ORDER_API_URL` がその出力の URL と一致していることを確認してから再試行してください。",
      isConfigError: false,
      retryable: true,
      reference: null,
    };
  }

  if (error instanceof OrderApiError) {
    return describeHttpFailure(error, operation, operationLabel);
  }

  // `api.ts` の分類に載っていない `OrderApiFailure`（将来の追加分）
  if (error instanceof OrderApiFailure) {
    return {
      title: `${operationLabel}に失敗しました`,
      message: error.message,
      hint: null,
      isConfigError: false,
      retryable: false,
      reference: error.kind,
    };
  }

  // API クライアント以外の例外（描画中のバグなど）。原因を隠さず出す
  return {
    title: `${operationLabel}に失敗しました`,
    message: error instanceof Error ? error.message : String(error),
    hint: "同じ操作で繰り返し発生する場合はブラウザのコンソールを確認してください。",
    isConfigError: false,
    retryable: false,
    reference: null,
  };
}

/** HTTP エラー応答（design §E-1）をコードごとに言い換える */
function describeHttpFailure(
  error: OrderApiError,
  operation: OrderApiOperation,
  operationLabel: string
): FailureNotice {
  const reference = `HTTP ${error.status} / ${error.code}`;
  const base = {
    isConfigError: false,
    reference,
  };

  switch (error.code) {
    case API_ERROR_CODES.ORDER_NOT_FOUND:
      return {
        ...base,
        title: "注文が見つかりません",
        message: error.message,
        hint: "注文 ID を確認してください。TTL で失効している可能性もあります（設定タブの保持日数を参照）。",
        retryable: false,
      };

    case API_ERROR_CODES.UNKNOWN_SKU:
      return {
        ...base,
        title: "商品マスタに無い SKU が含まれています",
        message: error.message,
        hint: "商品マスタを再読み込みして、選択し直してください。",
        retryable: false,
      };

    case API_ERROR_CODES.INVALID_REQUEST:
      return {
        ...base,
        title: "リクエストの内容に誤りがあります",
        message: error.message,
        hint: null,
        retryable: false,
      };

    case API_ERROR_CODES.PARAMETER_OUT_OF_RANGE:
      return {
        ...base,
        title: "指定できる範囲を超えています",
        message: error.message,
        hint: "設定タブに表示されている上限の範囲で指定してください。",
        retryable: false,
      };

    case API_ERROR_CODES.EXECUTION_NOT_FOUND:
      return {
        ...base,
        title: "実行が見つかりません",
        message: error.message,
        hint: "実行 ID を確認してください。TTL で失効している可能性もあります（設定タブの保持日数を参照）。",
        retryable: false,
      };

    case API_ERROR_CODES.INTERNAL_ERROR:
      return {
        ...base,
        title: `${operationLabel}中に API 側でエラーが発生しました`,
        message: error.message,
        hint: "詳細は CloudWatch Logs に出ています。時間をおいて再試行してください。",
        retryable: true,
      };

    case INVALID_RESPONSE_CODE:
      // API がエラーの形（design §E-1）で答えなかった場合。
      // API Gateway 自身の応答（スロットル、ルート不一致）がここに来る
      return {
        ...base,
        title: `${operationLabel}に失敗しました（HTTP ${error.status}）`,
        message: error.message,
        hint: describeGatewayHint(error.status, operation),
        retryable: isRetryableStatus(error.status),
      };

    default:
      return {
        ...base,
        title: `${operationLabel}に失敗しました`,
        message: error.message,
        hint: null,
        retryable: isRetryableStatus(error.status),
      };
  }
}

/** 5xx とスロットルは時間をおけば直る見込みがある */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * API Gateway 自身が返した応答の案内。
 *
 * 本文が design §E-1 の形でないため、ステータスから読めるだけの情報で
 * 「どこを見るか」を示す。
 */
function describeGatewayHint(status: number, operation: OrderApiOperation): string | null {
  if (status === 403 || status === 404) {
    return `${OPERATION_LABELS[operation]}のルートに届いていない可能性があります。\`NEXT_PUBLIC_ORDER_API_URL\` にステージまで含めた URL が設定されているか確認してください。`;
  }
  if (status === 429) {
    return "API Gateway のスロットルに当たっています。並行計測を止めるか、時間をおいて再試行してください。";
  }
  if (status >= 500) {
    return "詳細は CloudWatch Logs に出ています。時間をおいて再試行してください。";
  }
  return null;
}
