import OrderDashboard from "@/src/components/orders/OrderDashboard";

/**
 * トップページ（design §11.1 / 要件 14.9）。
 *
 * 検証ダッシュボードそのものが主画面なので、このファイルは
 * `OrderDashboard` を描画するだけに留める。`<main>` は
 * `OrderDashboard` 側が持つため、ここでは landmark を重ねない。
 *
 * `src/app/sample/` はテンプレートの参考実装として残すが、
 * ナビゲーションからは外す（`.kiro/steering/structure.md` の規約）。
 */
export default function Home() {
  return <OrderDashboard />;
}
