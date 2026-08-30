import { describe, expect, it } from 'vitest';
import {
  MAX_CLASSIFIED_BODY_LENGTH,
  THROTTLE_STATUS_CODE,
  classifyOutcome,
  countOutcome,
  createOutcomeCounters,
  truncateBodyForClassification,
} from './request-outcome.js';

/**
 * エラー分類の単体テスト（要件 12.2）。
 *
 * この分類が本 Spec の結論を分ける。スロットル（波及が起きた証拠）と
 * その他のエラー（対象の指定ミスなど）が混ざると、
 * 「波及が発生しなかった」という軸 A の成果（要件 12.6）を主張できない。
 */

describe('classifyOutcome: 成功', () => {
  it.each([200, 201, 202, 204, 299])('%d は SUCCESS', (statusCode) => {
    expect(classifyOutcome({ statusCode, body: '{"orders":[]}' })).toBe('SUCCESS');
  });
});

describe('classifyOutcome: スロットル（要件 12.2）', () => {
  it('429 は THROTTLE', () => {
    expect(classifyOutcome({ statusCode: THROTTLE_STATUS_CODE })).toBe('THROTTLE');
  });

  it('429 は本文が無くても THROTTLE（API Gateway は本文を返さない場合がある）', () => {
    expect(classifyOutcome({ statusCode: 429, body: '' })).toBe('THROTTLE');
  });

  it('本文に TooManyRequestsException があれば THROTTLE（429 以外で返る経路）', () => {
    expect(
      classifyOutcome({
        statusCode: 500,
        body: '{"message":"TooManyRequestsException: Rate exceeded"}',
      })
    ).toBe('THROTTLE');
    expect(
      classifyOutcome({ statusCode: 502, body: 'TooManyRequestsException' })
    ).toBe('THROTTLE');
  });

  it('大小を無視して照合する', () => {
    expect(classifyOutcome({ statusCode: 500, body: 'toomanyrequestsexception' })).toBe(
      'THROTTLE'
    );
  });

  it('例外メッセージに含まれる場合も THROTTLE', () => {
    expect(
      classifyOutcome({ error: new Error('TooManyRequestsException from integration') })
    ).toBe('THROTTLE');
  });

  it('スロットルの判定を成功判定より先に行う（200 + 印を成功に数えない）', () => {
    expect(classifyOutcome({ statusCode: 200, body: 'TooManyRequestsException' })).toBe(
      'THROTTLE'
    );
  });
});

describe('classifyOutcome: その他のエラー（要件 12.2）', () => {
  it.each([
    ['400（対象の指定ミス）', 400],
    ['404（存在しない注文）', 404],
    ['500', 500],
    ['503', 503],
  ])('%s は OTHER_ERROR', (_label, statusCode) => {
    expect(classifyOutcome({ statusCode, body: '{"error":"ORDER_NOT_FOUND"}' })).toBe(
      'OTHER_ERROR'
    );
  });

  it('応答が返らなかった場合は OTHER_ERROR', () => {
    expect(classifyOutcome({})).toBe('OTHER_ERROR');
  });

  it('接続断・タイムアウトは OTHER_ERROR', () => {
    expect(classifyOutcome({ error: new Error('socket hang up') })).toBe('OTHER_ERROR');
    expect(classifyOutcome({ error: 'ETIMEDOUT' })).toBe('OTHER_ERROR');
  });

  it('スロットル以外の 5xx をスロットルに数えない（波及の誤判定を防ぐ）', () => {
    expect(classifyOutcome({ statusCode: 500, body: '{"error":"INTERNAL_ERROR"}' })).toBe(
      'OTHER_ERROR'
    );
  });
});

describe('truncateBodyForClassification', () => {
  it('上限までは切らない', () => {
    const body = 'a'.repeat(MAX_CLASSIFIED_BODY_LENGTH);
    expect(truncateBodyForClassification(body)).toBe(body);
  });

  it('上限を超えた分は捨てる（本文でメモリを埋めない）', () => {
    const truncated = truncateBodyForClassification(
      'a'.repeat(MAX_CLASSIFIED_BODY_LENGTH + 100)
    );
    expect(truncated).toHaveLength(MAX_CLASSIFIED_BODY_LENGTH);
  });
});

describe('countOutcome', () => {
  it('分類ごとに数え、総数は常に増える', () => {
    const counters = createOutcomeCounters();
    countOutcome(counters, 'SUCCESS');
    countOutcome(counters, 'SUCCESS');
    countOutcome(counters, 'THROTTLE');
    countOutcome(counters, 'OTHER_ERROR');

    expect(counters).toEqual({
      requestCount: 4,
      successCount: 2,
      throttleCount: 1,
      otherErrorCount: 1,
    });
  });

  it('内訳の合計が総数と一致する（エラー率を算出できる）', () => {
    const counters = createOutcomeCounters();
    for (const outcome of ['SUCCESS', 'THROTTLE', 'OTHER_ERROR', 'SUCCESS'] as const) {
      countOutcome(counters, outcome);
    }
    expect(
      counters.successCount + counters.throttleCount + counters.otherErrorCount
    ).toBe(counters.requestCount);
  });

  it('空の内訳は全て 0（波及が無かったことを 0 で示せる。要件 12.6）', () => {
    expect(createOutcomeCounters()).toEqual({
      requestCount: 0,
      successCount: 0,
      throttleCount: 0,
      otherErrorCount: 0,
    });
  });
});
