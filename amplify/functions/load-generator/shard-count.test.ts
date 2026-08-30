import {
  DescribeTableCommand,
  type DynamoDBClient,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import {
  DescribeStreamCommand,
  type DynamoDBStreamsClient,
  type Shard,
  type StreamDescription,
} from '@aws-sdk/client-dynamodb-streams';
import { describe, expect, it } from 'vitest';
import {
  MAX_DESCRIBE_STREAM_PAGES,
  MAX_SHARD_COUNT_ERROR_LENGTH,
  ORDERS_STREAM_ARN_ENV,
  countOpenShards,
  describeOpenShardCount,
  describeWarmThroughputWrite,
  isOpenShard,
  observeShardCount,
  requireOrdersStreamArn,
  toShardCountErrorReason,
} from './shard-count.js';

/**
 * シャード数観測の単体テスト（要件 19.1 / 19.2 / 19.5 / 19.6、design §5.7 / §E-8）。
 *
 * AWS へは接続しない。`send` だけを差し替えた代役を渡し
 * （`shared/order-status.test.ts` と同じ手法）、確かめるのは 3 点。
 *
 * 1. 終端シーケンス番号を持つシャードを数えないこと（要件 19.2）
 * 2. `LastEvaluatedShardId` を追って全ページを合算すること（design §5.7）
 * 3. 失敗が例外にならず理由として返ること（要件 19.5）
 */

const STREAM_ARN =
  'arn:aws:dynamodb:ap-northeast-1:123456789012:table/kiro-roasters-orders-test/stream/2025-01-01T00:00:00.000';
const TABLE_NAME = 'kiro-roasters-orders-test';

/** オープンシャード（終端シーケンス番号なし） */
function openShard(shardId: string): Shard {
  return {
    ShardId: shardId,
    SequenceNumberRange: { StartingSequenceNumber: '100000000000000000001' },
  };
}

/** 終端済みシャード（分割・統合で世代交代したもの） */
function closedShard(shardId: string): Shard {
  return {
    ShardId: shardId,
    SequenceNumberRange: {
      StartingSequenceNumber: '100000000000000000001',
      EndingSequenceNumber: '100000000000000000999',
    },
  };
}

interface FakeStreams {
  streamsClient: DynamoDBStreamsClient;
  /** 送信した `ExclusiveStartShardId` の履歴（未指定は null で記録する） */
  cursors: (string | null)[];
}

/**
 * `DescribeStream` の代役。ページを順に返す。
 *
 * `pages` を使い切った後に呼ばれたら例外にする（呼び過ぎを検知する）。
 */
function fakeStreamsClient(
  pages: readonly (StreamDescription | undefined)[],
  options: { failWith?: unknown; failOnCall?: number } = {}
): FakeStreams {
  const cursors: (string | null)[] = [];
  let call = 0;

  const client = {
    send(command: unknown) {
      if (!(command instanceof DescribeStreamCommand)) {
        throw new Error('DescribeStreamCommand を期待しています');
      }
      call += 1;
      cursors.push(command.input.ExclusiveStartShardId ?? null);

      if (options.failWith !== undefined && call === (options.failOnCall ?? 1)) {
        return Promise.reject(options.failWith);
      }
      if (call > pages.length) {
        throw new Error(`DescribeStream の呼び出し過多（${call} 回目）`);
      }
      return Promise.resolve({ StreamDescription: pages[call - 1] });
    },
  };

  return { streamsClient: client as unknown as DynamoDBStreamsClient, cursors };
}

/** `DescribeTable` の代役 */
function fakeDynamoClient(
  result: { writeUnitsPerSecond?: number } | { failWith: unknown }
): DynamoDBClient {
  const client = {
    send(command: unknown) {
      if (!(command instanceof DescribeTableCommand)) {
        throw new Error('DescribeTableCommand を期待しています');
      }
      if ('failWith' in result) {
        return Promise.reject(result.failWith);
      }
      return Promise.resolve({
        Table: {
          TableName: TABLE_NAME,
          WarmThroughput:
            result.writeUnitsPerSecond === undefined
              ? undefined
              : { WriteUnitsPerSecond: result.writeUnitsPerSecond },
        },
      });
    },
  };
  return client as unknown as DynamoDBClient;
}

function accessDenied(): Error {
  const error = new Error(
    'User: arn:aws:sts::123456789012:assumed-role/load-generator is not authorized to perform: dynamodb:DescribeStream'
  );
  error.name = 'AccessDeniedException';
  return error;
}

// ─── isOpenShard / countOpenShards（要件 19.2）─────────────────────

describe('isOpenShard', () => {
  it('終端シーケンス番号を持たないシャードはオープン', () => {
    expect(isOpenShard(openShard('shardId-000001'))).toBe(true);
  });

  it('終端シーケンス番号を持つシャードはオープンでない', () => {
    expect(isOpenShard(closedShard('shardId-000001'))).toBe(false);
  });

  it('SequenceNumberRange 自体が無い場合もオープンとして数える', () => {
    expect(isOpenShard({ ShardId: 'shardId-000001' })).toBe(true);
  });

  it('空文字の終端シーケンス番号は未設定として扱う（S を過小に見積もらない）', () => {
    expect(
      isOpenShard({
        ShardId: 'shardId-000001',
        SequenceNumberRange: { EndingSequenceNumber: '   ' },
      })
    ).toBe(true);
  });
});

describe('countOpenShards', () => {
  it('オープンなものだけを数える', () => {
    const shards = [
      closedShard('closed-1'),
      openShard('open-1'),
      closedShard('closed-2'),
      openShard('open-2'),
      openShard('open-3'),
    ];

    expect(countOpenShards(shards)).toBe(3);
  });

  it('全シャードが終端済みなら 0', () => {
    expect(countOpenShards([closedShard('closed-1'), closedShard('closed-2')])).toBe(0);
  });

  it('Shards が未設定なら 0（応答形状に依存して落ちない）', () => {
    expect(countOpenShards(undefined)).toBe(0);
    expect(countOpenShards([])).toBe(0);
  });
});

// ─── describeOpenShardCount: ページネーション（design §5.7）─────────

describe('describeOpenShardCount', () => {
  it('単一ページのオープンシャード数を返す', async () => {
    const { streamsClient, cursors } = fakeStreamsClient([
      { Shards: [openShard('a'), openShard('b'), closedShard('c'), openShard('d')] },
    ]);

    const result = await describeOpenShardCount({ streamArn: STREAM_ARN, streamsClient });

    expect(result).toEqual({ openShardCount: 3, pageCount: 1 });
    // 1 ページ目は ExclusiveStartShardId を付けない
    expect(cursors).toEqual([null]);
  });

  it('LastEvaluatedShardId を追って全ページを合算する（軸 B では複数ページ）', async () => {
    const { streamsClient, cursors } = fakeStreamsClient([
      { Shards: [openShard('a'), openShard('b')], LastEvaluatedShardId: 'b' },
      { Shards: [openShard('c'), closedShard('d')], LastEvaluatedShardId: 'd' },
      { Shards: [openShard('e')] },
    ]);

    const result = await describeOpenShardCount({ streamArn: STREAM_ARN, streamsClient });

    expect(result).toEqual({ openShardCount: 4, pageCount: 3 });
    // 2 ページ目以降は前ページの LastEvaluatedShardId をカーソルに使う
    expect(cursors).toEqual([null, 'b', 'd']);
  });

  it('LastEvaluatedShardId が空文字なら最終ページとして扱う', async () => {
    const { streamsClient } = fakeStreamsClient([
      { Shards: [openShard('a')], LastEvaluatedShardId: '' },
    ]);

    await expect(
      describeOpenShardCount({ streamArn: STREAM_ARN, streamsClient })
    ).resolves.toEqual({ openShardCount: 1, pageCount: 1 });
  });

  it('StreamDescription が無ければ例外（黙って 0 件にしない）', async () => {
    const { streamsClient } = fakeStreamsClient([undefined]);

    await expect(
      describeOpenShardCount({ streamArn: STREAM_ARN, streamsClient })
    ).rejects.toThrow(/StreamDescription/);
  });

  it('同じカーソルが返り続けたら例外（無限ループにしない）', async () => {
    const { streamsClient } = fakeStreamsClient([
      { Shards: [openShard('a')], LastEvaluatedShardId: 'a' },
      { Shards: [openShard('a')], LastEvaluatedShardId: 'a' },
    ]);

    await expect(
      describeOpenShardCount({ streamArn: STREAM_ARN, streamsClient })
    ).rejects.toThrow(/ページネーションが進みません/);
  });

  it('ページ数の上限に達したら例外（15 分のタイムアウトを使い切らせない）', async () => {
    // 常に新しいカーソルを返し続ける応答。上限で打ち切られることを確かめる
    let seq = 0;
    const client = {
      send() {
        seq += 1;
        return Promise.resolve({
          StreamDescription: {
            Shards: [openShard(`shard-${seq}`)],
            LastEvaluatedShardId: `shard-${seq}`,
          },
        });
      },
    };

    await expect(
      describeOpenShardCount({
        streamArn: STREAM_ARN,
        streamsClient: client as unknown as DynamoDBStreamsClient,
        maxPages: 3,
      })
    ).rejects.toThrow(/上限（3）/);
    expect(seq).toBe(3);
  });

  it('既定のページ数上限は MAX_DESCRIBE_STREAM_PAGES', () => {
    expect(MAX_DESCRIBE_STREAM_PAGES).toBe(100);
  });

  it('SDK の失敗はそのまま伝播する（判断は呼び出し側）', async () => {
    const { streamsClient } = fakeStreamsClient([], { failWith: accessDenied() });

    await expect(
      describeOpenShardCount({ streamArn: STREAM_ARN, streamsClient })
    ).rejects.toThrow(/AccessDenied|not authorized/);
  });
});

// ─── describeWarmThroughputWrite（design §5.7）─────────────────────

describe('describeWarmThroughputWrite', () => {
  it('設定されていれば書き込み側の値を返す', async () => {
    await expect(
      describeWarmThroughputWrite({
        tableName: TABLE_NAME,
        dynamoClient: fakeDynamoClient({ writeUnitsPerSecond: 40_000 }),
      })
    ).resolves.toBe(40_000);
  });

  it('未設定なら undefined（暗黙に既定値を埋めない）', async () => {
    await expect(
      describeWarmThroughputWrite({
        tableName: TABLE_NAME,
        dynamoClient: fakeDynamoClient({}),
      })
    ).resolves.toBeUndefined();
  });
});

// ─── observeShardCount: 失敗で止めない（要件 19.5 / design §E-8）────

describe('observeShardCount', () => {
  it('成功時はシャード数と warm throughput を返し、エラーを載せない', async () => {
    const { streamsClient } = fakeStreamsClient([
      { Shards: [openShard('a'), openShard('b')], LastEvaluatedShardId: 'b' },
      { Shards: [openShard('c'), closedShard('d')] },
    ]);

    const observation = await observeShardCount({
      streamArn: STREAM_ARN,
      tableName: TABLE_NAME,
      streamsClient,
      dynamoClient: fakeDynamoClient({ writeUnitsPerSecond: 40_000 }),
    });

    expect(observation).toEqual({
      openShardCount: 3,
      pageCount: 2,
      warmThroughputWrite: 40_000,
    });
    expect(observation.shardCountError).toBeUndefined();
  });

  it('シャード数の取得に失敗しても例外にせず理由を返す（要件 19.5）', async () => {
    const { streamsClient } = fakeStreamsClient([], { failWith: accessDenied() });
    const failures: string[] = [];

    const observation = await observeShardCount({
      streamArn: STREAM_ARN,
      tableName: TABLE_NAME,
      streamsClient,
      dynamoClient: fakeDynamoClient({ writeUnitsPerSecond: 40_000 }),
      onError: (context) => failures.push(context),
    });

    expect(observation.openShardCount).toBeUndefined();
    expect(observation.shardCountError).toContain('AccessDeniedException');
    expect(failures).toEqual(['DescribeStream']);
    // 失敗しても warm throughput の記録は残す（別の呼び出しなので独立している）
    expect(observation.warmThroughputWrite).toBe(40_000);
  });

  it('warm throughput の取得失敗は shardCountError にしない（S の算出に関与しない）', async () => {
    const { streamsClient } = fakeStreamsClient([{ Shards: [openShard('a')] }]);
    const failures: string[] = [];

    const observation = await observeShardCount({
      streamArn: STREAM_ARN,
      tableName: TABLE_NAME,
      streamsClient,
      dynamoClient: fakeDynamoClient({
        failWith: new ResourceNotFoundException({ $metadata: {}, message: 'no table' }),
      }),
      onError: (context) => failures.push(context),
    });

    expect(observation.openShardCount).toBe(1);
    expect(observation.shardCountError).toBeUndefined();
    expect(observation.warmThroughputWrite).toBeUndefined();
    expect(failures).toEqual(['DescribeTable']);
  });

  it('両方失敗しても解決する（負荷生成を止めない）', async () => {
    const { streamsClient } = fakeStreamsClient([], { failWith: accessDenied() });

    const observation = await observeShardCount({
      streamArn: STREAM_ARN,
      tableName: TABLE_NAME,
      streamsClient,
      dynamoClient: fakeDynamoClient({ failWith: accessDenied() }),
    });

    expect(observation.shardCountError).toBeTruthy();
    expect(observation.openShardCount).toBeUndefined();
    expect(observation.warmThroughputWrite).toBeUndefined();
  });

  it('openShardCount と shardCountError は排他である', async () => {
    const cases = [
      fakeStreamsClient([{ Shards: [openShard('a')] }]),
      fakeStreamsClient([], { failWith: accessDenied() }),
    ];

    for (const { streamsClient } of cases) {
      const observation = await observeShardCount({
        streamArn: STREAM_ARN,
        tableName: TABLE_NAME,
        streamsClient,
        dynamoClient: fakeDynamoClient({}),
      });

      expect(
        (observation.openShardCount === undefined) !==
          (observation.shardCountError === undefined)
      ).toBe(true);
    }
  });
});

// ─── toShardCountErrorReason ──────────────────────────────────────

describe('toShardCountErrorReason', () => {
  it('例外の名前を残す（権限漏れと ARN 取り違えを実行レコードで見分けるため）', () => {
    expect(toShardCountErrorReason(accessDenied())).toMatch(/^AccessDeniedException: /);
  });

  it('Error でない値も文字列化する', () => {
    expect(toShardCountErrorReason('壊れた')).toBe('UnknownError: 壊れた');
    expect(toShardCountErrorReason(undefined)).toBe('UnknownError: undefined');
  });

  it('改行を畳んで 1 行にする（実行レコードの可読性）', () => {
    const error = new Error('1 行目\n  2 行目');
    error.name = 'MultiLineError';

    expect(toShardCountErrorReason(error)).toBe('MultiLineError: 1 行目 2 行目');
  });

  it('長すぎる理由は打ち切る', () => {
    const error = new Error('あ'.repeat(2_000));

    const reason = toShardCountErrorReason(error);

    expect(reason).toHaveLength(MAX_SHARD_COUNT_ERROR_LENGTH);
    expect(reason.endsWith('…')).toBe(true);
  });
});

// ─── requireOrdersStreamArn ───────────────────────────────────────

describe('requireOrdersStreamArn（design §5.7。配線はタスク 20）', () => {
  it('環境変数からストリーム ARN を読む', () => {
    expect(requireOrdersStreamArn({ [ORDERS_STREAM_ARN_ENV]: STREAM_ARN })).toBe(
      STREAM_ARN
    );
  });

  it('前後の空白を落とす', () => {
    expect(requireOrdersStreamArn({ [ORDERS_STREAM_ARN_ENV]: ` ${STREAM_ARN} ` })).toBe(
      STREAM_ARN
    );
  });

  it.each([
    ['未設定', undefined],
    ['空文字', ''],
    ['空白のみ', '   '],
  ])('%s なら例外にする（空の ARN で DescribeStream を呼ばない）', (_label, value) => {
    expect(() => requireOrdersStreamArn({ [ORDERS_STREAM_ARN_ENV]: value })).toThrow(
      new RegExp(ORDERS_STREAM_ARN_ENV)
    );
  });
});
