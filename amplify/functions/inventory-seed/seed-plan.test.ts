import { describe, expect, it } from 'vitest';
import { CATALOG, findProduct } from '../shared/catalog.js';
import { API_ERROR_CODES, ApiError } from '../shared/http.js';
import { DEFAULT_WAREHOUSE_ID } from '../shared/inventory-keys.js';
import {
  BATCH_WRITE_MAX_ITEMS,
  DEFAULT_INITIAL_QUANTITY,
  MAX_INITIAL_QUANTITY,
  buildInventoryRecords,
  chunkIntoBatchWriteInputs,
  countBatchWriteItems,
  parseSeedInventoryRequest,
  retryDelayMs,
  toRetryInput,
} from './seed-plan.js';

/**
 * 初期在庫投入の投入計画の単体テスト（要件 5.7 / 5.9 / 5.3、design 論点 6 / §4.4）。
 *
 * AWS への接続は行わない。確かめるのは
 * 「商品マスタ全 SKU × 単一倉庫のレコードができるか」
 * 「25 件ずつに分割されるか」「範囲外の在庫数を弾くか」の 3 点。
 */

const TABLE_NAME = 'order-inventory';

describe('parseSeedInventoryRequest', () => {
  it('本文が空なら既定の在庫数と固定倉庫で投入する（design 論点 6）', () => {
    expect(parseSeedInventoryRequest({})).toEqual({
      initialQuantity: DEFAULT_INITIAL_QUANTITY,
      warehouseId: DEFAULT_WAREHOUSE_ID,
    });
  });

  it('initialQuantity を指定できる（在庫不足の検証用。要件 5.3）', () => {
    expect(parseSeedInventoryRequest({ initialQuantity: 3 }).initialQuantity).toBe(3);
  });

  it('0 を既定値へ読み替えない（全件在庫不足を作れるようにする）', () => {
    expect(parseSeedInventoryRequest({ initialQuantity: 0 }).initialQuantity).toBe(0);
  });

  it('倉庫 ID は指定できず常に固定値になる（要件 5.9）', () => {
    const params = parseSeedInventoryRequest({ warehouseId: 'WH-OSAKA' });
    expect(params.warehouseId).toBe(DEFAULT_WAREHOUSE_ID);
  });

  it.each([
    ['文字列', '100'],
    ['真偽値', true],
    ['オブジェクト', {}],
    ['NaN', Number.NaN],
  ])('initialQuantity が数値でなければ 400 INVALID_REQUEST（%s）', (_label, value) => {
    expect(() => parseSeedInventoryRequest({ initialQuantity: value })).toThrowError(
      expect.objectContaining({ code: API_ERROR_CODES.INVALID_REQUEST, statusCode: 400 })
    );
  });

  it('initialQuantity が小数なら 400 INVALID_REQUEST', () => {
    expect(() => parseSeedInventoryRequest({ initialQuantity: 1.5 })).toThrowError(
      expect.objectContaining({ code: API_ERROR_CODES.INVALID_REQUEST })
    );
  });

  it.each([
    ['負数', -1],
    ['上限超過', MAX_INITIAL_QUANTITY + 1],
  ])('範囲外なら 400 PARAMETER_OUT_OF_RANGE（%s）', (_label, value) => {
    let thrown: unknown;
    try {
      parseSeedInventoryRequest({ initialQuantity: value });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    const error = thrown as ApiError;
    expect(error.code).toBe(API_ERROR_CODES.PARAMETER_OUT_OF_RANGE);
    expect(error.statusCode).toBe(400);
    expect(error.details).toEqual({
      initialQuantity: value,
      maxInitialQuantity: MAX_INITIAL_QUANTITY,
    });
  });

  it('上限値そのものは受け付ける（境界）', () => {
    expect(
      parseSeedInventoryRequest({ initialQuantity: MAX_INITIAL_QUANTITY }).initialQuantity
    ).toBe(MAX_INITIAL_QUANTITY);
  });
});

describe('buildInventoryRecords（design §4.4）', () => {
  const nowMs = Date.parse('2025-01-01T00:00:00.000Z');
  const records = buildInventoryRecords(
    { initialQuantity: 12_345, warehouseId: DEFAULT_WAREHOUSE_ID },
    nowMs
  );

  it('商品マスタ全 SKU × 単一倉庫の件数になる（要件 5.7 / 5.9）', () => {
    expect(records).toHaveLength(CATALOG.length);
    expect(new Set(records.map((record) => record.warehouseId))).toEqual(
      new Set([DEFAULT_WAREHOUSE_ID])
    );
  });

  it('itemId は SKU そのもので、重複しない', () => {
    const itemIds = records.map((record) => record.itemId);
    expect(new Set(itemIds).size).toBe(CATALOG.length);
    for (const itemId of itemIds) {
      expect(findProduct(itemId)).toBeDefined();
    }
  });

  it('商品名と単価は商品マスタの値を写す', () => {
    for (const record of records) {
      const product = findProduct(record.itemId);
      expect(record.itemName).toBe(product?.name);
      expect(record.unitPrice).toBe(product?.price);
    }
  });

  it('全レコードに指定した在庫数と同一の更新時刻が入る', () => {
    for (const record of records) {
      expect(record.quantity).toBe(12_345);
      expect(record.lastUpdated).toBe('2025-01-01T00:00:00.000Z');
    }
  });

  it('在庫数 0 でもレコードは作る（引当は在庫不足として扱う。要件 5.3 / 5.6）', () => {
    const zeroed = buildInventoryRecords(
      { initialQuantity: 0, warehouseId: DEFAULT_WAREHOUSE_ID },
      nowMs
    );
    expect(zeroed).toHaveLength(CATALOG.length);
    expect(zeroed.every((record) => record.quantity === 0)).toBe(true);
  });
});

describe('chunkIntoBatchWriteInputs', () => {
  const records = buildInventoryRecords({
    initialQuantity: DEFAULT_INITIAL_QUANTITY,
    warehouseId: DEFAULT_WAREHOUSE_ID,
  });
  const batches = chunkIntoBatchWriteInputs(TABLE_NAME, records);

  it('1 バッチが BatchWriteItem の上限（25 件）を超えない', () => {
    for (const batch of batches) {
      expect(countBatchWriteItems(batch)).toBeLessThanOrEqual(BATCH_WRITE_MAX_ITEMS);
    }
  });

  it('分割しても投入件数の合計は変わらない（取りこぼしを作らない）', () => {
    const total = batches.reduce((sum, batch) => sum + countBatchWriteItems(batch), 0);
    expect(total).toBe(records.length);
    expect(batches).toHaveLength(Math.ceil(records.length / BATCH_WRITE_MAX_ITEMS));
  });

  it('全バッチが指定テーブル宛の PutRequest である', () => {
    for (const batch of batches) {
      expect(Object.keys(batch.RequestItems ?? {})).toEqual([TABLE_NAME]);
      for (const request of batch.RequestItems?.[TABLE_NAME] ?? []) {
        expect(request.PutRequest?.Item).toMatchObject({
          warehouseId: DEFAULT_WAREHOUSE_ID,
          quantity: DEFAULT_INITIAL_QUANTITY,
        });
        expect(request.DeleteRequest).toBeUndefined();
      }
    }
  });

  it('分割後のキーの集合が元の SKU の集合と一致する', () => {
    const chunkedItemIds = batches.flatMap((batch) =>
      (batch.RequestItems?.[TABLE_NAME] ?? []).map(
        (request) => request.PutRequest?.Item?.itemId as string
      )
    );
    expect(new Set(chunkedItemIds)).toEqual(new Set(records.map((r) => r.itemId)));
  });

  it('件数が上限の倍数ちょうどなら空のバッチを作らない（境界）', () => {
    const exact = chunkIntoBatchWriteInputs(TABLE_NAME, records.slice(0, 50));
    expect(exact).toHaveLength(2);
    expect(exact.map(countBatchWriteItems)).toEqual([25, 25]);
  });

  it('レコードが 0 件ならバッチを作らない（空の RequestItems を送らない）', () => {
    expect(chunkIntoBatchWriteInputs(TABLE_NAME, [])).toEqual([]);
  });
});

describe('toRetryInput（UnprocessedItems を落とさない）', () => {
  const writeRequest = { PutRequest: { Item: { itemId: CATALOG[0].sku } } };

  it('未処理が無ければ undefined（ループを抜ける合図）', () => {
    expect(toRetryInput(undefined)).toBeUndefined();
    expect(toRetryInput({})).toBeUndefined();
    expect(toRetryInput({ [TABLE_NAME]: [] })).toBeUndefined();
  });

  it('未処理が残っていれば再送入力にする', () => {
    const retry = toRetryInput({ [TABLE_NAME]: [writeRequest] });
    expect(retry).toEqual({ RequestItems: { [TABLE_NAME]: [writeRequest] } });
    expect(countBatchWriteItems(retry!)).toBe(1);
  });

  it('空配列のテーブルは再送入力から落とす', () => {
    const retry = toRetryInput({ [TABLE_NAME]: [writeRequest], other: [] });
    expect(Object.keys(retry?.RequestItems ?? {})).toEqual([TABLE_NAME]);
  });
});

describe('retryDelayMs', () => {
  it('指数バックオフで増え、上限で止まる', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(retryDelayMs)).toEqual([
      50, 100, 200, 400, 800, 1_000, 1_000,
    ]);
  });

  it('0 以下の指定でも初回と同じ待ち時間を返す', () => {
    expect(retryDelayMs(0)).toBe(50);
  });
});
