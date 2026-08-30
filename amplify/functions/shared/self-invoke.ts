/**
 * 自身への非同期 invoke（design 論点 2 / 論点 3 / §E-6）。
 *
 * ## なぜ必要なのか
 *
 * 負荷生成（要件 11.9）と並行計測（要件 12.1）は、開始要求に即座に応答して
 * 処理を非同期に継続しなければならない。API Gateway の統合タイムアウトは
 * **上限 29 秒**であり、数分〜1 時間の継続時間を同期処理で待つことはできない。
 *
 * さらに Lambda 自身のタイムアウト上限は 15 分なので、
 * 継続時間が 15 分を超える実行は 1 回の invoke では終わらない。
 * 残り実行時間が閾値を切ったところで**自身を非同期 invoke して引き継ぐ**。
 *
 * ## 非同期（`InvocationType: 'Event'`）である理由
 *
 * 同期 invoke（`RequestResponse`）にすると、呼び出し元のワーカーが
 * 引き継ぎ先の完了を待って生き続ける。15 分の壁を越えられないうえ、
 * 世代の数だけ同時実行枠を占有して**計測対象の枠を奪う**（要件 11.10 に反する）。
 * 非同期なら呼び出し元は即座に終了でき、常に 1 世代だけが動く。
 *
 * ## 呼び出し元（開始 API / ワーカー）が失敗を握りつぶさないこと
 *
 * invoke の失敗は「実行が始まらなかった / 途中で止まった」ことを意味する。
 * 検証者にはそれが実行レコードの `FAILED` としてしか見えない（design §E-6）ため、
 * この層では例外にして必ず呼び出し側へ渡す。
 *
 * 必要な IAM 権限は自身への `lambda:InvokeFunction`（design §5.9）。
 * 配線は `amplify/custom/order-functions.ts` の `grantSelfInvoke`。
 */

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

/** Lambda 実行環境が自動で設定する関数名の環境変数（自己 invoke の宛先） */
export const SELF_FUNCTION_NAME_ENV = 'AWS_LAMBDA_FUNCTION_NAME';

/** 非同期 invoke が成功したときのステータスコード（Lambda の仕様） */
export const ASYNC_INVOKE_STATUS_CODE = 202;

/** 自己 invoke に失敗したときの例外（design §E-6） */
export class SelfInvokeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SelfInvokeError';
  }
}

export interface InvokeSelfAsyncInput {
  /** 引き継ぎ先に渡すペイロード（JSON 直列化できる値） */
  payload: unknown;
  /** 宛先の関数名。既定は `AWS_LAMBDA_FUNCTION_NAME` */
  functionName?: string;
  /** Lambda クライアント。既定はモジュールスコープの共有インスタンス */
  client?: LambdaClient;
}

/**
 * 自身の関数名を解決する。
 *
 * `AWS_LAMBDA_FUNCTION_NAME` は Lambda 実行環境が必ず設定する予約変数であり、
 * これが無いのは Lambda 以外で動いている（= 設計の前提が崩れている）ことを意味する。
 * 関数名を推測すると存在しない関数を叩いて `ResourceNotFoundException` になり、
 * 本当の原因が見えなくなるため、ここで明示的に失敗させる。
 *
 * @throws {SelfInvokeError} 環境変数が未設定の場合
 */
export function resolveSelfFunctionName(
  env: Record<string, string | undefined> = process.env
): string {
  const functionName = env[SELF_FUNCTION_NAME_ENV]?.trim();
  if (!functionName) {
    throw new SelfInvokeError(
      `${SELF_FUNCTION_NAME_ENV} が未設定です（Lambda 実行環境の予約変数。自己 invoke の宛先を決められません）`
    );
  }
  return functionName;
}

/**
 * 自身を非同期に invoke する。
 *
 * ステータスコードを検査するのは、`Invoke` API が**キューへの受付に失敗しても
 * 例外にならない**場合があるためである。202 以外はキューに乗った保証がないので
 * 失敗として扱い、呼び出し側に実行レコードを `FAILED` にさせる。
 *
 * @throws {SelfInvokeError} 関数名が解決できない場合、SDK が失敗した場合、
 *   応答が 202 以外の場合
 */
export async function invokeSelfAsync(input: InvokeSelfAsyncInput): Promise<void> {
  const functionName = input.functionName ?? resolveSelfFunctionName();
  const client = input.client ?? getLambdaClient();

  let statusCode: number | undefined;
  try {
    const output = await client.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(input.payload), 'utf8'),
      })
    );
    statusCode = output.StatusCode;
  } catch (error) {
    throw new SelfInvokeError(`自己 invoke に失敗しました（${functionName}）`, {
      cause: error,
    });
  }

  if (statusCode !== ASYNC_INVOKE_STATUS_CODE) {
    throw new SelfInvokeError(
      `自己 invoke が受け付けられませんでした（${functionName}、StatusCode=${String(statusCode)}）`
    );
  }
}

let lambdaClient: LambdaClient | undefined;

/**
 * Lambda クライアント（モジュールスコープで再利用。`shared/ddb.ts` と同じ方針）。
 */
export function getLambdaClient(): LambdaClient {
  lambdaClient ??= new LambdaClient({});
  return lambdaClient;
}

/** テスト用。生成済みのクライアントを破棄する */
export function resetLambdaClient(): void {
  lambdaClient = undefined;
}
