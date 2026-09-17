"use client";

/**
 * 「設定」タブ（検証パラメータ + 検証の準備操作。design §3.1 / 要件 5.1 / 5.5）。
 *
 * ```
 * SettingsTabPanel
 * ├── ConfigPanel         … 検証パラメータと消費能力の見積もり（既存。変更しない）
 * └── InventorySeedPanel  … 初期在庫の投入（注文タブから移設）
 * ```
 *
 * ## なぜ外枠を 1 枚挟むのか
 *
 * 設定タブはこれまで `ConfigPanel` 単体だった。初期在庫の投入は顧客の操作ではなく
 * 検証の準備なので設定タブへ寄せる（要件 5.1）が、`ConfigPanel` の中に足すと
 * 既存表示（検証パラメータ・消費能力）に手が入る。要件 5.5 は移設後も既存表示を
 * 維持することを求めているため、**`ConfigPanel` は一切触らず**、2 枚のパネルを
 * 縦に積むだけの外枠をここに作る。
 *
 * ## 状態を持たない
 *
 * `LoadTestTabPanel` は 2 つのパネルの間で実行 ID を受け渡すために状態を持つが、
 * こちらは受け渡す値がない。`ConfigPanel` は `GET /config`、`InventorySeedPanel` は
 * `POST /inventory/seed` をそれぞれ自分で扱い、互いに依存しない
 * （`InventorySeedPanel` が props を持たない理由もこれ）。したがってこの外枠は
 * 並べる順を決めるだけで、`panelStack`（既存の縦積みパターン）に載せる。
 *
 * 表示順は「まず今の条件を確かめ、次に準備操作をする」という検証の流れに合わせ、
 * `ConfigPanel` を先に置く。
 */

import ConfigPanel from "./ConfigPanel";
import InventorySeedPanel from "./InventorySeedPanel";
import styles from "./orders.module.css";

export default function SettingsTabPanel() {
  return (
    <div className={styles.panelStack}>
      <ConfigPanel />
      <InventorySeedPanel />
    </div>
  );
}
