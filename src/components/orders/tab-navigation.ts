/**
 * タブリストのキーボード操作の解決（純粋関数）。
 *
 * WAI-ARIA APG の Tabs パターン（横並び・自動アクティブ化）に従う。
 * 矢印キーは端で回り込み、Home / End は端へ飛ぶ。
 *
 * DOM を触らない純粋関数として切り出しているのは、回り込みと境界の挙動を
 * `.kiro/steering/testing.md` の「最も狭い範囲の検証を最初に実行する」に沿って
 * 単体テストで固定するためである（`OrderDashboard` 側は focus の移動だけを持つ）。
 */

/** タブリストで処理するキー */
export const TAB_NAVIGATION_KEYS = ["ArrowRight", "ArrowLeft", "Home", "End"] as const;

export type TabNavigationKey = (typeof TAB_NAVIGATION_KEYS)[number];

/** `key` がタブリストで処理すべきキーかどうか */
export function isTabNavigationKey(key: string): key is TabNavigationKey {
  return (TAB_NAVIGATION_KEYS as readonly string[]).includes(key);
}

/**
 * キー入力に対する移動先のタブ位置を返す。
 *
 * @param key `KeyboardEvent.key`
 * @param currentIndex 現在のタブ位置（0 起点）
 * @param tabCount タブの総数
 * @returns 移動先の位置。処理しないキー・入力が不正な場合は `null`
 *
 * `null` を返した場合、呼び出し側は `preventDefault()` せずブラウザ既定の
 * 挙動に委ねる（Tab キーによるパネルへの移動などを壊さないため）。
 */
export function resolveTabIndex(
  key: string,
  currentIndex: number,
  tabCount: number
): number | null {
  if (!Number.isInteger(tabCount) || tabCount <= 0) {
    return null;
  }
  if (!isTabNavigationKey(key)) {
    return null;
  }

  // Home / End は現在位置に依存しないため、先に解決する
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return tabCount - 1;
  }

  // 矢印キーは現在位置からの相対移動。位置が不正なら移動先を決められない
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex >= tabCount) {
    return null;
  }

  const delta = key === "ArrowRight" ? 1 : -1;
  return (currentIndex + delta + tabCount) % tabCount;
}
