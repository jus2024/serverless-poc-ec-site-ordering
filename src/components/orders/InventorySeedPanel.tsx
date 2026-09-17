"use client";

/**
 * 初期在庫の投入（`POST /inventory/seed`。要件 5.1 / 5.2、旧 14.2）。
 *
 * ## なぜ注文タブから設定タブへ移すのか
 *
 * 在庫の投入は顧客の操作ではなく検証の準備である（design §3.1）。注文タブが
 * EC の購買導線（商品グリッド → カート → 注文 → 状況）になったので、
 * 顧客が触らない操作は設定タブへ寄せる。**移設であって作り直しではない**ため、
 * `OrderSubmitPanel` の該当セクションのロジックをそのまま持ってきている
 * （`seedInventory` の呼び出し、`parseInitialQuantityInput` の検証、結果表示。要件 5.2）。
 *
 * ## 状態を自分で持つ
 *
 * 在庫の投入は他のパネルと値を受け渡さない。注文タブのように親（`OrdersTabPanel`）へ
 * 状態を上げる理由（カートを空にする・`orderId` を引き継ぐ）がなく、`ConfigPanel` と
 * 同じ「自分の中で完結するパネル」にできる。そのため props を持たず、
 * 設定タブ（`SettingsTabPanel`）は `<InventorySeedPanel />` を並べるだけでよい。
 *
 * ## 投入結果は最後の 1 件だけ
 *
 * 連続投入の履歴は残さない。投入は冪等（全 SKU × 単一倉庫を上書き）なので、
 * 意味を持つのは直前の結果だけである。`OrderSubmitPanel` の方針を引き継いでいる。
 */

import { useState } from "react";

import { seedInventory } from "@/src/lib/orders/api";
import type { SeedInventoryResponse } from "@/src/lib/orders/types";

import FailureAlert from "./FailureAlert";
import { describeOrderApiFailure, type FailureNotice } from "./order-api-failure";
import { DEFAULT_INITIAL_QUANTITY, parseInitialQuantityInput } from "./order-form";
import { formatCount, formatElapsedMs } from "./order-progress";
import styles from "./orders.module.css";
import SummaryItem from "./SummaryItem";

export default function InventorySeedPanel() {
  const [seedQuantityInput, setSeedQuantityInput] = useState("");
  const [seedQuantityIssue, setSeedQuantityIssue] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState<SeedInventoryResponse | null>(null);
  const [seedFailure, setSeedFailure] = useState<FailureNotice | null>(null);

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

  return (
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

      {/* 非同期の結果を支援技術に伝える。成功も失敗もこの 1 箇所から読み上げる */}
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
  );
}
