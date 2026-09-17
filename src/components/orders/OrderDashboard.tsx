"use client";

/**
 * 検証用ダッシュボードの外枠（design §11.1 / 要件 14.8, 14.9）。
 *
 * ヘッダー（`BrandIcon` + タイトル）とタブだけを持ち、各タブの中身は
 * それぞれのパネルに委ねる。
 *
 * | タブ | 中身 |
 * |------|------|
 * | 注文 | `OrdersTabPanel`（`ProductGrid` / `CartPanel` / `OrderStatusPanel`） |
 * | 負荷テスト | `LoadTestPanel` / `QueryImpactPanel` |
 * | 計測結果 | `MeasurementComparison` |
 * | 設定 | `SettingsTabPanel`（`ConfigPanel` / `InventorySeedPanel`） |
 *
 * ## 4 つのパネルを常にマウントしたままにしている理由
 *
 * 非アクティブなタブパネルは条件分岐で外さず、`hidden` 属性で隠す。
 * 負荷生成と並行計測は実行 ID をポーリングして状態を追う（要件 11.6 / 12.5）ため、
 * タブを離れた時点でアンマウントするとポーリングが止まり、
 * 実行中の計測を取りこぼす。`hidden` なパネルは支援技術からも読み上げ対象外になる。
 *
 * ## 色とコンポーネントの見た目
 *
 * 在庫管理編から引き継いだトークンを使う（要件 14.8）。
 * カラートークンは `src/app/globals.css` の CSS 変数、
 * コンポーネントトークンは同ファイルのグローバルクラス（`card` / `btn-primary` /
 * `badge` / `data-table` など）で、このファイルでは色を直接書かない。
 */

import { useRef, useState } from "react";

import BrandIcon from "@/src/components/common/BrandIcon";

import LoadTestPanel from "./LoadTestPanel";
import MeasurementComparison from "./MeasurementComparison";
import OrdersTabPanel from "./OrdersTabPanel";
import QueryImpactPanel from "./QueryImpactPanel";
import SettingsTabPanel from "./SettingsTabPanel";
import { resolveTabIndex } from "./tab-navigation";
import styles from "./orders.module.css";

/**
 * タブの定義（design §11.1: 注文 / 負荷テスト / 計測結果 / 設定）。
 *
 * 表示順は配列順。キーボードの左右移動もこの順に従う。
 */
const TABS = [
  { id: "orders", label: "注文" },
  { id: "load-test", label: "負荷テスト" },
  { id: "measurements", label: "計測結果" },
  { id: "settings", label: "設定" },
] as const;

/** タブの識別子 */
export type OrderDashboardTabId = (typeof TABS)[number]["id"];

const DEFAULT_TAB_ID: OrderDashboardTabId = "orders";

/** タブボタンの DOM id。`aria-controls` / `aria-labelledby` で相互参照する */
function tabDomId(tabId: OrderDashboardTabId): string {
  return `order-tab-${tabId}`;
}

/** タブパネルの DOM id */
function panelDomId(tabId: OrderDashboardTabId): string {
  return `order-tabpanel-${tabId}`;
}

export default function OrderDashboard() {
  const [activeTabId, setActiveTabId] = useState<OrderDashboardTabId>(DEFAULT_TAB_ID);
  // 矢印キーでの移動先へ focus を移すために各タブボタンを保持する
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const activeIndex = TABS.findIndex((tab) => tab.id === activeTabId);

  /**
   * 横並びタブの自動アクティブ化（WAI-ARIA APG）。
   * 矢印 / Home / End で選択と focus を同時に動かす。
   */
  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    const nextIndex = resolveTabIndex(event.key, activeIndex, TABS.length);
    if (nextIndex === null) {
      // Tab キーなどはブラウザ既定の挙動に任せる（パネル本体へ移動できる）
      return;
    }
    event.preventDefault();
    setActiveTabId(TABS[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  }

  return (
    <main className={styles.dashboard}>
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <BrandIcon size={32} />
          <div>
            <h1 className={styles.title}>Kiro Roasters EC 注文処理 PoC</h1>
            <p className={styles.subtitle}>
              DynamoDB Streams → Lambda の消費能力と滞留の挙動を検証する
            </p>
          </div>
        </div>
      </header>

      {/* 横並びタブ。roving tabindex（アクティブなタブのみ Tab キーで到達可能） */}
      <div className={styles.tablist} role="tablist" aria-label="検証ダッシュボードの表示切り替え">
        {TABS.map((tab, index) => {
          const isActive = tab.id === activeTabId;
          return (
            <button
              key={tab.id}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={tabDomId(tab.id)}
              aria-selected={isActive}
              aria-controls={panelDomId(tab.id)}
              tabIndex={isActive ? 0 : -1}
              className={isActive ? styles.tabActive : styles.tab}
              onClick={() => setActiveTabId(tab.id)}
              onKeyDown={handleTabKeyDown}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {TABS.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={panelDomId(tab.id)}
          aria-labelledby={tabDomId(tab.id)}
          // 非アクティブなパネルはマウントしたまま隠す（上のコメントの理由）
          hidden={tab.id !== activeTabId}
          // パネル自体を focus 対象にして、タブから Tab キーで中身へ入れるようにする
          tabIndex={0}
          className={styles.panel}
        >
          {renderPanel(tab.id)}
        </div>
      ))}
    </main>
  );
}

/**
 * タブごとの中身。
 * 外枠側には各パネル固有の状態を持たせない（パネル間で受け渡す値だけを持つ）。
 */
function renderPanel(tabId: OrderDashboardTabId) {
  switch (tabId) {
    case "orders":
      return <OrdersTabPanel />;
    case "load-test":
      return <LoadTestTabPanel />;
    case "measurements":
      return <MeasurementComparison />;
    case "settings":
      return <SettingsTabPanel />;
  }
}

/**
 * 「負荷テスト」タブ（負荷生成 + 並行計測）。
 *
 * 負荷生成で追跡中の実行 ID を並行計測へ渡す。並行計測の結果は
 * 「どの投入レートの最中に測ったのか」と対でなければ解釈できないため、
 * 実行レコードに `loadTestId` を残せるようにしている（要件 12.5）。
 *
 * 2 つのパネルの間にだけ必要な状態をここに置く。外枠（`OrderDashboard`）には
 * パネル固有の状態を持たせない。
 */
function LoadTestTabPanel() {
  const [trackedLoadTestId, setTrackedLoadTestId] = useState<string | null>(null);

  return (
    <div className={styles.panelStack}>
      <LoadTestPanel onLoadTestTracked={setTrackedLoadTestId} />
      <QueryImpactPanel loadTestId={trackedLoadTestId} />
    </div>
  );
}

