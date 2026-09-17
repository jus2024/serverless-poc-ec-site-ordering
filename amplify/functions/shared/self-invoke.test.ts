import { InvokeCommand, type LambdaClient } from '@aws-sdk/client-lambda';
import { describe, expect, it } from 'vitest';
import {
  ASYNC_INVOKE_STATUS_CODE,
  SELF_FUNCTION_NAME_ENV,
  SelfInvokeError,
  invokeSelfAsync,
  resolveSelfFunctionName,
} from './self-invoke.js';

/**
 * 自己 invoke の単体テスト（要件 11.9 / 12.1、design §E-6）。
 *
 * AWS へは接続しない。`send` だけを差し替えた代役を渡す
 * （`load-generator/shard-count.test.ts` と同じ手法）。確かめるのは 3 点。
 *
 * 1. 非同期（`InvocationType: 'Event'`）で呼ぶこと
 *    （同期にすると世代の数だけ同時実行枠を占有し、要件 11.10 に反する）
 * 2. 受付されなかった invoke を成功として扱わないこと（design §E-6）
 * 3. 失敗が `SelfInvokeError` として呼び出し側に届くこと（実行レコードを `FAILED` にするため）
 */

const FUNCTION_NAME = 'kiro-load-generator-test';

interface FakeLambda {
  client: LambdaClient;
  commands: InvokeCommand[];
}

function fakeLambdaClient(
  result: { statusCode?: number } | { failWith: unknown }
): FakeLambda {
  const commands: InvokeCommand[] = [];
  const client = {
    send(command: unknown) {
      if (!(command instanceof InvokeCommand)) {
        throw new Error('InvokeCommand を期待しています');
      }
      commands.push(command);
      if ('failWith' in result) {
        return Promise.reject(result.failWith);
      }
      return Promise.resolve({ StatusCode: result.statusCode });
    },
  };
  return { client: client as unknown as LambdaClient, commands };
}

/** 送信したペイロードを JSON として読み直す */
function readPayload(command: InvokeCommand): unknown {
  const payload = command.input.Payload;
  return JSON.parse(Buffer.from(payload as Uint8Array).toString('utf8'));
}

describe('resolveSelfFunctionName', () => {
  it('環境変数から関数名を読む', () => {
    expect(resolveSelfFunctionName({ [SELF_FUNCTION_NAME_ENV]: FUNCTION_NAME })).toBe(
      FUNCTION_NAME
    );
  });

  it('未設定なら例外にする（関数名を推測しない）', () => {
    expect(() => resolveSelfFunctionName({})).toThrow(SelfInvokeError);
  });

  it('空文字も未設定として扱う', () => {
    expect(() => resolveSelfFunctionName({ [SELF_FUNCTION_NAME_ENV]: '  ' })).toThrow(
      SelfInvokeError
    );
  });
});

describe('invokeSelfAsync（要件 11.9）', () => {
  it('非同期でペイロードを渡す', async () => {
    const { client, commands } = fakeLambdaClient({
      statusCode: ASYNC_INVOKE_STATUS_CODE,
    });
    const payload = { mode: 'LOAD_WORKER', generation: 2 };

    await invokeSelfAsync({ payload, functionName: FUNCTION_NAME, client });

    expect(commands).toHaveLength(1);
    expect(commands[0].input.FunctionName).toBe(FUNCTION_NAME);
    expect(commands[0].input.InvocationType).toBe('Event');
    expect(readPayload(commands[0])).toEqual(payload);
  });

  it('202 以外は失敗として扱う（キューに乗った保証がない）', async () => {
    const { client } = fakeLambdaClient({ statusCode: 200 });
    await expect(
      invokeSelfAsync({ payload: {}, functionName: FUNCTION_NAME, client })
    ).rejects.toThrow(SelfInvokeError);
  });

  it('SDK の失敗を SelfInvokeError に包んで投げる（原因は cause に残す）', async () => {
    const cause = new Error('AccessDeniedException');
    const { client } = fakeLambdaClient({ failWith: cause });

    await expect(
      invokeSelfAsync({ payload: {}, functionName: FUNCTION_NAME, client })
    ).rejects.toMatchObject({ name: 'SelfInvokeError', cause });
  });

  it('関数名を省略すると環境変数から解決する', async () => {
    const { client, commands } = fakeLambdaClient({
      statusCode: ASYNC_INVOKE_STATUS_CODE,
    });
    const previous = process.env[SELF_FUNCTION_NAME_ENV];
    process.env[SELF_FUNCTION_NAME_ENV] = FUNCTION_NAME;

    try {
      await invokeSelfAsync({ payload: { ok: true }, client });
      expect(commands[0].input.FunctionName).toBe(FUNCTION_NAME);
    } finally {
      if (previous === undefined) {
        delete process.env[SELF_FUNCTION_NAME_ENV];
      } else {
        process.env[SELF_FUNCTION_NAME_ENV] = previous;
      }
    }
  });
});
