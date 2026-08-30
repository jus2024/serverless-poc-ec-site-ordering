"use client";

/**
 * 注文の手動投入と初期在庫の投入（要件 14.1 / 14.2 / 3.5）。
 *
 * ## SKU の出典は `GET /catalog` だけ
 *
 * 選択肢は API から取得した商品マスタで組み立てる（要件 3.5）。
 * フロントエンドに商品一覧を複製すると、Lambda 側の商品マスタを変えたときに
 * 画面だけ古い SKU を送り続け、`UNKNOWN_SKU` の原因が分からなくなる。
 * 単価も商品マスタの値をそのまま使う（API 側も商品マスタの単価で組み直す）。
 *
 * ## 明細の検証を送信前に済ませる理由
 *
 * 数量や重複の誤りは `order-form.ts` で送信前に弾く。API も同じ検証を持つが、
 * 画面側で弾けるものを往復させると「入力の誤り」と「API の不調」が
 * 同じ赤いメッセージとして出てしまう。判断の権限は API 側にあり、
 * 画面側の検証は先に気づくための手段である。
 *
 * ## 状態の持ち方
 *
 * 投入結果は最後の 1 件だけを保持する。連続投入の履歴は
 * 注文照会（`OrderStatusPanel`）と負荷テストのパネルが担う。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  createOrder,
  getCatalog,
  seedInventory,
  type OrderApiOptions,
} from "@/src/lib/orders/api";
import type {
  CatalogProductView,
  CreateOrderRequest,
  CreateOrderResponse,
  SeedInventoryResponse,
} from "@/src/lib/orders/types";

import FailureAlert from "./FailureAlert";
import { describeOrderApiFailure, type FailureNotice } from "./order-api-failure";
import {
  DEFAULT_INITIAL_QUANTITY,
  MAX_ORDER_ITEMS,
  buildOrderDraft,
  findLineIssue,
  parseCustomerIdInput,
  parseInitialQuantityInput,
  type OrderLineDraft,
  type OrderLineIssue,
} from "./order-form";
import { formatCount, formatElapsedMs, formatJpy } from "./order-progress";
import styles from "./orders.module.css";
import SummaryItem from "./SummaryItem";

/** 商品マスタの読み込み状態 */
type CatalogState = "loading" | "ready" | "error";

interface OrderSubmitPanelProps {
  /**
   * 投入に成功した注文 ID を親に伝える。
   * 親（`OrderDashboard`）が `OrderStatusPanel` に渡し、そのまま照会できるようにする。
   */
  onOrderCreated?: (orderId: string) => void;
}

export default function OrderSubmitPanel({ onOrderCreated }: OrderSubmitPanelProps) {
  // ── 商品マスタ（SKU 選択肢の出典）
  const [catalogState, setCatalogState] = useState<CatalogState>("loading");
  const [products, setProducts] = useState<CatalogProductView[]>([]);
  const [pointRate, setPointRate] = useState<number | null>(null);
  const [catalogFailure, setCatalogFailure] = useState<FailureNotice | null>(null);

  // ── 注文の入力
  const [customerIdInput, setCustomerIdInput] = useState("");
  const [customerIdIssue, setCustomerIdIssue] = useState<string | null>(null);
  const [useRandomItems, setUseRandomItems] = useState(false);
  const [lines, setLines] = useState<OrderLineDraft[]>([]);
  const [lineIssues, setLineIssues] = useState<OrderLineIssue[]>([]);
  const [itemsIssue, setItemsIssue] = useState<string | null>(null);

  // ── 注文の投入結果
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<CreateOrderResponse | null>(null);
  const [submitFailure, setSubmitFailure] = useState<FailureNotice | null>(null);

  // ── 初期在庫の投入
  const [seedQuantityInput, setSeedQuantityInput] = useState("");
  const [seedQuantityIssue, setSeedQuantityIssue] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState<SeedInventoryResponse | null>(null);
  const [seedFailure, setSeedFailure] = useState<FailureNotice | null>(null);

  // 行 id の採番。並べ替え・削除で index を key にしないため
  const lineSeqRef = useRef(0);
  const nextLineId = useCallback((): string => {
    lineSeqRef.current += 1;
    return `line-${lineSeqRef.current}`;
  }, []);

  // アンマウント時に進行中の取得を中断する（タブは hidden で残るので通常は起きない）
  const catalogAbortRef = useRef<AbortController | null>(null);

  const loadCatalog = useCallback(async () => {
    catalogAbortRef.current?.abort();
    const controller = new AbortController();
    catalogAbortRef.current = controller;
    const options: OrderApiOptions = { signal: controller.signal };

    setCatalogState("loading");
    setCatalogFailure(null);
    try {
      const response = await getCatalog(options);
      if (controller.signal.aborted) {
        return;
      }
      setProducts(response.products);
      setPointRate(response.pointRate);
      setCatalogState("ready");
      // 最初の商品で 1 行だけ用意しておく（空のフォームから始めさせない）
      setLines((current) => {
        if (current.length > 0 || response.products.length === 0) {
          return current;
        }
        return [{ id: nextLineId(), sku: response.products[0].sku, qty: "1" }];
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      setProducts([]);
      setPointRate(null);
      setCatalogState("error");
      setCatalogFailure(describeOrderApiFailure(error, "loadCatalog"));
    }
  }, [nextLineId]);

  useEffect(() => {
    void loadCatalog();
    return () => {
      catalogAbortRef.current?.abort();
    };
  }, [loadCatalog]);

  // ── 明細の編集

  function updateLine(lineId: string, patch: Partial<Omit<OrderLineDraft, "id">>) {
    setLines((current) =>
      current.map((line) => (line.id === lineId ? { ...line, ...patch } : line))
    );
  }

  function addLine() {
    setLines((current) => {
      if (current.length >= MAX_ORDER_ITEMS) {
        return current;
      }
      // まだ選ばれていない商品を既定にして、重複の指摘から始めないようにする
      const used = new Set(current.map((line) => line.sku));
      const candidate = products.find((product) => !used.has(product.sku));
      return [...current, { id: nextLineId(), sku: candidate?.sku ?? "", qty: "1" }];
    });
  }

  function removeLine(lineId: string) {
    setLines((current) => current.filter((line) => line.id !== lineId));
    setLineIssues((current) => current.filter((issue) => issue.lineId !== lineId));
  }

  // ── 注文の投入

  async function handleSubmitOrder(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) {
      return;
    }

    const customerId = parseCustomerIdInput(customerIdInput);
    setCustomerIdIssue(customerId.ok ? null : customerId.issue);

    const request: CreateOrderRequest = {};
    if (customerId.ok && customerId.value !== undefined) {
      request.customerId = customerId.value;
    }

    // ランダム生成では items を送らない（要件 1.2）。明細の検証も行わない
    if (useRandomItems) {
      setLineIssues([]);
      setItemsIssue(null);
    } else {
      const draft = buildOrderDraft(lines, products);
      setLineIssues(draft.lineIssues);
      setItemsIssue(draft.formIssue);
      if (!draft.ok) {
        return;
      }
      request.items = draft.items;
    }

    if (!customerId.ok) {
      return;
    }

    setSubmitting(true);
    setSubmitFailure(null);
    try {
      const response = await createOrder(request);
      setSubmitResult(response);
      onOrderCreated?.(response.orderId);
    } catch (error) {
      setSubmitResult(null);
      setSubmitFailure(describeOrderApiFailure(error, "createOrder"));
    } finally {
      setSubmitting(false);
    }
  }

  // ── 初期在庫の投入

  async function handleSeedInventory(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (seeding) {
      return;
    }

    const quantity = parseInitialQuantityInput(seedQuantityInput);
    setSeedQuantityIssue(quantity.ok ? null : quantity.issue);
    if (!quantity.ok) {
      return;
    }

    setSeeding(true);
    setSeedFailure(null);
    try {
      const response = await seedInventory(
        quantity.value === undefined ? {} : { initialQuantity: quantity.value }
      );
      setSeedResult(response);
    } catch (error) {
      setSeedResult(null);
      setSeedFailure(describeOrderApiFailure(error, "seedInventory"));
    } finally {
      setSeeding(false);
    }
  }

  // ── 表示

  const catalogSummary =
    catalogState === "ready"
      ? `商品マスタ ${formatCount(products.length)} 件${
          pointRate === null ? "" : ` / ポイント付与率 ${(pointRate * 100).toFixed(1)}%`
        }`
      : catalogState === "loading"
        ? "商品マスタを読み込んでいます…"
        : "商品マスタを取得できませんでした。";

  // 明細を指定する投入は商品マスタが必要（ランダム生成なら SKU は不要）
  const canSubmit = submitting ? false : useRandomItems || catalogState === "ready";

  return (
    <div className={styles.panelStack}>
      <section className="card" aria-labelledby="order-submit-heading">
        <h2 id="order-submit-heading" className={styles.sectionTitle}>
          注文の投入
        </h2>
        <p className={styles.sectionDescription}>
          <code>POST /orders</code> に注文を 1 件投入する。SKU の選択肢は
          <code>GET /catalog</code> の商品マスタから作る。
        </p>

        {/* 商品マスタの状態は投入前に必ず読む情報なので、読み込み中も含めて通知する */}
        <p className={styles.statusLine} role="status" aria-live="polite">
          {catalogSummary}
        </p>

        {catalogFailure !== null && (
          <FailureAlert notice={catalogFailure} onRetry={() => void loadCatalog()} />
        )}

        <form className={styles.form} onSubmit={handleSubmitOrder} noValidate>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="order-customer-id">
              顧客 ID（任意）
            </label>
            <input
              id="order-customer-id"
              className={`input ${styles.textInput}`}
              type="text"
              value={customerIdInput}
              onChange={(event) => setCustomerIdInput(event.target.value)}
              placeholder="test-0001"
              aria-describedby={
                customerIdIssue === null
                  ? "order-customer-id-hint"
                  : "order-customer-id-hint order-customer-id-error"
              }
              aria-invalid={customerIdIssue !== null}
            />
            <p id="order-customer-id-hint" className={styles.fieldHint}>
              未入力ならテスト顧客が自動で割り当てられる。
            </p>
            {customerIdIssue !== null && (
              <p id="order-customer-id-error" className={styles.fieldError}>
                {customerIdIssue}
              </p>
            )}
          </div>

          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>明細</legend>

            <div className={styles.checkboxField}>
              <input
                id="order-random-items"
                type="checkbox"
                checked={useRandomItems}
                onChange={(event) => setUseRandomItems(event.target.checked)}
              />
              <label htmlFor="order-random-items">
                商品マスタからランダムに生成する（<code>items</code> を送らない）
              </label>
            </div>

            {useRandomItems ? (
              <p className={styles.fieldHint}>
                明細は API 側で商品マスタからランダムに組み立てられる。商品マスタを
                取得できていなくても投入できる。
              </p>
            ) : (
              <>
                <ul className={styles.lineList}>
                  {lines.map((line, index) => {
                    const skuIssue = findLineIssue(lineIssues, line.id, "sku");
                    const qtyIssue = findLineIssue(lineIssues, line.id, "qty");
                    const skuErrorId = `${line.id}-sku-error`;
                    const qtyErrorId = `${line.id}-qty-error`;
                    return (
                      <li key={line.id} className={styles.lineItem}>
                        <div className={styles.lineFieldSku}>
                          <label className={styles.fieldLabel} htmlFor={`${line.id}-sku`}>
                            {index + 1} 行目の商品
                          </label>
                          <select
                            id={`${line.id}-sku`}
                            className={`input ${styles.select}`}
                            value={line.sku}
                            onChange={(event) => updateLine(line.id, { sku: event.target.value })}
                            aria-describedby={skuIssue === null ? undefined : skuErrorId}
                            aria-invalid={skuIssue !== null}
                            disabled={catalogState !== "ready"}
                          >
                            <option value="">選択してください</option>
                            {products.map((product) => (
                              <option key={product.sku} value={product.sku}>
                                {product.name}（{formatJpy(product.price)} / {product.sku}）
                              </option>
                            ))}
                          </select>
                          {skuIssue !== null && (
                            <p id={skuErrorId} className={styles.fieldError}>
                              {skuIssue}
                            </p>
                          )}
                        </div>

                        <div className={styles.lineFieldQty}>
                          <label className={styles.fieldLabel} htmlFor={`${line.id}-qty`}>
                            数量
                          </label>
                          <input
                            id={`${line.id}-qty`}
                            className={`input ${styles.qtyInput}`}
                            type="text"
                            inputMode="numeric"
                            value={line.qty}
                            onChange={(event) => updateLine(line.id, { qty: event.target.value })}
                            aria-describedby={qtyIssue === null ? undefined : qtyErrorId}
                            aria-invalid={qtyIssue !== null}
                          />
                          {qtyIssue !== null && (
                            <p id={qtyErrorId} className={styles.fieldError}>
                              {qtyIssue}
                            </p>
                          )}
                        </div>

                        <div className={styles.lineFieldAction}>
                          <button
                            type="button"
                            className="btn-secondary"
                            onClick={() => removeLine(line.id)}
                          >
                            削除
                            <span className={styles.srOnly}>（{index + 1} 行目）</span>
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>

                {itemsIssue !== null && <p className={styles.fieldError}>{itemsIssue}</p>}

                <div className={styles.inlineActions}>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={addLine}
                    disabled={catalogState !== "ready" || lines.length >= MAX_ORDER_ITEMS}
                  >
                    明細を追加
                  </button>
                </div>
              </>
            )}
          </fieldset>

          <div className={styles.actions}>
            <button type="submit" className="btn-primary" disabled={!canSubmit}>
              {submitting ? "投入中…" : "注文を投入する"}
            </button>
          </div>
        </form>

        {/* 非同期の結果を支援技術に伝える。成功も失敗もこの 1 箇所から読み上げる */}
        <p className={styles.statusLine} role="status" aria-live="polite">
          {submitting
            ? "注文を投入しています…"
            : submitResult !== null
              ? `注文 ${submitResult.orderId} を投入しました。`
              : submitFailure !== null
                ? `注文の投入に失敗しました: ${submitFailure.title}`
                : ""}
        </p>

        {submitFailure !== null && <FailureAlert notice={submitFailure} />}

        {submitResult !== null && (
          <div className={styles.subCard}>
            <h3 className={styles.subTitle}>投入した注文</h3>
            <dl className={styles.summaryGrid}>
              <SummaryItem label="注文 ID" value={submitResult.orderId} mono />
              <SummaryItem label="顧客 ID" value={submitResult.customerId} mono />
              <SummaryItem label="ステータス" value={submitResult.orderStatus} />
              <SummaryItem label="合計金額" value={formatJpy(submitResult.totalAmount)} />
              <SummaryItem
                label="受付 API の処理時間"
                value={formatElapsedMs(submitResult.acceptLatencyMs)}
              />
              <SummaryItem label="受付時刻" value={submitResult.createdAt} mono />
            </dl>
            <div className={styles.tableWrap}>
              <table className="data-table">
                <caption className={styles.tableCaption}>投入した明細</caption>
                <thead>
                  <tr>
                    <th scope="col">SKU</th>
                    <th scope="col">数量</th>
                    <th scope="col">単価</th>
                  </tr>
                </thead>
                <tbody>
                  {submitResult.items.map((item) => (
                    <tr key={item.sku}>
                      <td className={styles.mono}>{item.sku}</td>
                      <td>{item.qty}</td>
                      <td>{formatJpy(item.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="inventory-seed-heading">
        <h2 id="inventory-seed-heading" className={styles.sectionTitle}>
          初期在庫の投入
        </h2>
        <p className={styles.sectionDescription}>
          <code>POST /inventory/seed</code> で商品マスタ全 SKU × 単一倉庫の在庫を投入する。
          在庫がないと引当が常に失敗するため、検証の前に一度実行する。
        </p>

        <form className={styles.form} onSubmit={handleSeedInventory} noValidate>
          <div className={styles.field}>
            <label className={styles.fieldLabel} htmlFor="inventory-seed-quantity">
              在庫数（任意）
            </label>
            <input
              id="inventory-seed-quantity"
              className={`input ${styles.textInput}`}
              type="text"
              inputMode="numeric"
              value={seedQuantityInput}
              onChange={(event) => setSeedQuantityInput(event.target.value)}
              placeholder={String(DEFAULT_INITIAL_QUANTITY)}
              aria-describedby={
                seedQuantityIssue === null
                  ? "inventory-seed-quantity-hint"
                  : "inventory-seed-quantity-hint inventory-seed-quantity-error"
              }
              aria-invalid={seedQuantityIssue !== null}
            />
            <p id="inventory-seed-quantity-hint" className={styles.fieldHint}>
              未入力なら既定値（{formatCount(DEFAULT_INITIAL_QUANTITY)}）。
              在庫不足を意図的に起こす検証では小さい値（0 を含む）を指定する。
            </p>
            {seedQuantityIssue !== null && (
              <p id="inventory-seed-quantity-error" className={styles.fieldError}>
                {seedQuantityIssue}
              </p>
            )}
          </div>

          <div className={styles.actions}>
            <button type="submit" className="btn-primary" disabled={seeding}>
              {seeding ? "投入中…" : "初期在庫を投入する"}
            </button>
          </div>
        </form>

        <p className={styles.statusLine} role="status" aria-live="polite">
          {seeding
            ? "初期在庫を投入しています…"
            : seedResult !== null
              ? `在庫レコード ${formatCount(seedResult.seededCount)} 件を投入しました。`
              : seedFailure !== null
                ? `初期在庫の投入に失敗しました: ${seedFailure.title}`
                : ""}
        </p>

        {seedFailure !== null && <FailureAlert notice={seedFailure} />}

        {seedResult !== null && (
          <dl className={styles.summaryGrid}>
            <SummaryItem label="倉庫" value={seedResult.warehouseId} mono />
            <SummaryItem label="在庫数" value={formatCount(seedResult.initialQuantity)} />
            <SummaryItem label="投入件数" value={formatCount(seedResult.seededCount)} />
            <SummaryItem label="BatchWrite 回数" value={formatCount(seedResult.batchCount)} />
            <SummaryItem label="再送回数" value={formatCount(seedResult.retryCount)} />
            <SummaryItem label="所要時間" value={formatElapsedMs(seedResult.seedLatencyMs)} />
          </dl>
        )}
      </section>
    </div>
  );
}
