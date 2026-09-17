import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { describe, expect, it } from 'vitest';
import {
  MEASURE_REQUEST_TIMEOUT_MS,
  MEASURE_SOCKET_HEADROOM,
  createMeasureAgent,
  resolveMaxSockets,
} from './query-client.js';

/**
 * 接続数上限の単体テスト（design 論点 3、要件 12.7）。
 *
 * ここが並行数を下回ると、リクエストは接続待ちのキューに積まれ、
 * その待ち時間がレイテンシに乗る。**指定した並行数が実際には出ない**ため、
 * 波及の測定（要件 12.6）の前提が崩れる。上限の算出だけを単体で確かめる
 * （HTTP を実際に飛ばすテストは行わない。design §12）。
 */

const HTTPS_URL = 'https://abc123.execute-api.ap-northeast-1.amazonaws.com/prod/orders';

describe('resolveMaxSockets', () => {
  it('並行数を必ず上回る（接続待ちを作らない）', () => {
    for (const concurrency of [1, 10, 60, 200, 1_000]) {
      expect(resolveMaxSockets(concurrency)).toBeGreaterThan(concurrency);
    }
  });

  it('並行数 + 余裕を返す', () => {
    expect(resolveMaxSockets(60)).toBe(60 + MEASURE_SOCKET_HEADROOM);
  });

  it('余裕は引数で変えられる', () => {
    expect(resolveMaxSockets(60, 0)).toBe(60);
  });

  it('0 以下の並行数でも 1 本以上は確保する', () => {
    expect(resolveMaxSockets(0, 0)).toBe(1);
    expect(resolveMaxSockets(-5, 0)).toBe(1);
  });
});

describe('createMeasureAgent', () => {
  it('https の URL には https エージェントを作る', () => {
    const agent = createMeasureAgent({ url: HTTPS_URL, concurrency: 10 });
    expect(agent).toBeInstanceOf(HttpsAgent);
    agent.destroy();
  });

  it('http の URL には http エージェントを作る', () => {
    const agent = createMeasureAgent({ url: 'http://localhost:3000/orders', concurrency: 10 });
    expect(agent).toBeInstanceOf(HttpAgent);
    expect(agent).not.toBeInstanceOf(HttpsAgent);
    agent.destroy();
  });

  it('接続数上限を明示的に引き上げる（design 論点 3）', () => {
    const agent = createMeasureAgent({ url: HTTPS_URL, concurrency: 60 });
    expect(agent.maxSockets).toBe(resolveMaxSockets(60));
    agent.destroy();
  });

  it('keep-alive を有効にし、空きソケットを閉じない（TLS の再確立を避ける）', () => {
    const agent = createMeasureAgent({ url: HTTPS_URL, concurrency: 60 });
    // `options` は @types/node の Agent に現れないため、実体を読むために絞り込む
    const { keepAlive } = (agent as unknown as { options: { keepAlive?: boolean } }).options;

    expect(agent.maxFreeSockets).toBe(agent.maxSockets);
    expect(keepAlive).toBe(true);
    agent.destroy();
  });
});

describe('MEASURE_REQUEST_TIMEOUT_MS', () => {
  it('API Gateway の統合タイムアウト上限（29 秒）を上回る（遅い応答を捨てない）', () => {
    expect(MEASURE_REQUEST_TIMEOUT_MS).toBeGreaterThan(29_000);
  });
});
