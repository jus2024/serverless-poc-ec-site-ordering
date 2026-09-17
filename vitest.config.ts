import { defineConfig } from "vitest/config";

/**
 * 純粋関数の単体テストに限定した最小構成（design §12）。
 *
 * 対象は合成時の設定検証（`amplify/custom/`）、Lambda 側のロジック
 * （`amplify/functions/`。共有モジュールと、各関数から切り出した純粋関数）、
 * フロントエンド側の算出ロジック（`src/lib/orders/`）と、
 * コンポーネントから切り出した純粋関数（`src/components/orders/`。
 * タブのキーボード操作の解決など）のみ。
 * AWS への接続を伴うテストと、DOM を必要とするテストは対象にしない
 * （`environment: "node"` のまま、jsdom を持ち込まない）。
 */
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "amplify/custom/**/*.test.ts",
      "amplify/functions/**/*.test.ts",
      "src/lib/orders/**/*.test.ts",
      "src/components/orders/**/*.test.ts",
    ],
  },
});
