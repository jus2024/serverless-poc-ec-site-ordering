"use client";

/**
 * デプロイ済みの検証パラメータと消費能力の見積もり（要件 14.7 / 10.6）。
 *
 * ## 出典は `.env.local` ではなくデプロイ済みの Lambda である
 *
 * シナリオを切り替えるとき、PF や擬似処理時間の変更は**再デプロイ**を伴う
 * （design §10.1 の「再デプロイ」列）。手元の `.env.local` を書き換えただけで
 * デプロイしていない、あるいは別のブランチをデプロイしたままという状態は
 * 起こりうる。そのとき画面が手元の値を表示していると、
 * 実測結果を誤った条件のもとで解釈することになる。
 *
 * そこでこの画面は `GET /config` の応答だけを出典にする（design §5.8）。
 * 表示されている値が、いま注文を処理している Lambda の環境変数である。
 *
 * ## シャード数が実測値か暫定値かを値と同じ強さで示す
 *
 * `GET /config` はストリームを参照しないため、S は既定で暫定値
 * （`ASSUMED`）である。暫定値に基づく消費能力を「実測した壁の位置」と
 * 読み違えると design §2.2 の結論が変わる（Property 10）。
 * 出典をバッジで示し、暫定値のときは実測値の確認先を案内する。
 *
 * ## 消費能力を画面側で再計算して突き合わせる
 *
 * `src/lib/orders/capacity.ts` は Lambda 側の実装と意図的に重複している
 * （要件 18.6）。片方だけを直したときに気づけるよう、API の見積もりと
 * 画面側の再計算を突き合わせて食い違いを出す（`config-view.ts`）。
 */

import type { VerificationConfigResponse } from "@/src/lib/orders/types";

import { formatPercent, formatRatePerMinute, formatSeconds } from "./execution-run";
import { deriveVerificationConfigView } from "./config-view";
import FailureAlert from "./FailureAlert";
import { formatDurationSeconds } from "./measurement-comparison";
import { EMPTY_VALUE, formatCount, formatElapsedMs } from "./order-progress";
import styles from "./orders.module.css";
import SummaryItem from "./SummaryItem";
import { useVerificationConfig } from "./use-verification-config";

/** TTL の日数を秒に直すための係数（保持期間を時間の桁でも見せるため） */
const SECONDS_PER_DAY = 86_400;

export default function ConfigPanel() {
  const { state, config, failure, reload } = useVerificationConfig();

  return (
    <section className="card" aria-labelledby="config-panel-heading">
      <h2 id="config-panel-heading" className={styles.sectionTitle}>
        検証パラメータ
      </h2>
      <p className={styles.sectionDescription}>
        <code>GET /config</code> が返す、いまデプロイされている Lambda の環境変数と、
        そこから算出した消費能力（<code>S × P ÷ D</code>。design §2.1）。手元の
        <code>.env.local</code> ではなくデプロイ済みの値である。
      </p>

      <p className={styles.statusLine} role="status" aria-live="polite">
        {state === "loading"
          ? "検証パラメータを読み込んでいます…"
          : state === "error"
            ? "検証パラメータを取得できませんでした。"
            : "デプロイ済みの設定を表示しています。"}
      </p>

      {failure !== null && <FailureAlert notice={failure} onRetry={reload} />}

      {config !== null && <ConfigContent config={config} onReload={reload} />}
    </section>
  );
}

function ConfigContent({
  config,
  onReload,
}: {
  config: VerificationConfigResponse;
  onReload: () => void;
}) {
  const view = deriveVerificationConfigView(config);
  const { capacity } = config;

  return (
    <div className={styles.result}>
      <div className={styles.inlineActions}>
        <button type="button" className="btn-secondary" onClick={onReload}>
          再取得する
        </button>
      </div>

      {/* ── 消費能力（この画面の主役）── */}
      <div className={styles.subCard}>
        <h3 className={styles.subTitle}>消費能力の見積もり</h3>
        <p className={styles.fieldHint}>
          <code>消費能力 = S × P ÷ D</code>（design §2.1）。
          <code>BatchSize</code> は式に現れない（バッチ内を直列処理する限り約分される）。
        </p>

        {/*
          S の出典。値の並びに埋めず独立させる。
          暫定値に基づく消費能力を実測値と読み違えると結論が変わる（Property 10）。
        */}
        <p className={view.shardCount.measured ? styles.infoNote : styles.warningAlert} role="note">
          <span
            className={
              view.shardCount.measured ? "badge badge-completed" : "badge badge-running"
            }
          >
            シャード数: {view.shardCount.label}
          </span>{" "}
          {view.shardCount.note}
        </p>

        <dl className={styles.summaryGrid}>
          <SummaryItem
            label="オープンシャード数 (S)"
            value={formatCount(capacity.openShardCount)}
          />
          <SummaryItem
            label="並列化係数 (P)"
            value={formatCount(capacity.parallelizationFactor)}
          />
          <SummaryItem
            label="最大同時実行数 (S × P)"
            value={formatCount(capacity.maxConcurrency)}
          />
          <SummaryItem label="擬似待機の合計" value={formatElapsedMs(capacity.pseudoDelayMs)} />
          <SummaryItem
            label="オーバーヘッドの想定"
            value={formatElapsedMs(capacity.assumedOverheadMs)}
          />
          <SummaryItem
            label="1 レコードの処理時間 (D)"
            value={formatElapsedMs(capacity.recordProcessingMs)}
          />
          <SummaryItem
            label="オーバーヘッドが D に占める割合"
            value={formatPercent(view.overheadShare)}
          />
          <SummaryItem
            label="算出した消費能力"
            value={formatRatePerMinute(capacity.estimatedCapacityPerMinute)}
          />
        </dl>

        {/*
          Lambda 側と画面側で式が食い違っていないかの確認。
          一致しているときは静かにしておく（毎回出すと注意が薄れる）。
        */}
        {view.capacity.matches === false && (
          <p className={styles.warningAlert} role="alert">
            API が返した消費能力（{formatRatePerMinute(view.capacity.reported)}）と、
            画面側で同じ式から再計算した値（
            {formatRatePerMinute(view.capacity.recomputed)}）が一致しません。Lambda 側と
            フロントエンド側の <code>capacity.ts</code> は意図的に重複しているため、
            どちらかの式が変更された可能性があります。
          </p>
        )}
        {view.capacity.problem !== null && (
          <p className={styles.warningNote} role="note">
            消費能力を画面側で再計算できませんでした（{view.capacity.problem}）。
          </p>
        )}
        {!view.maxConcurrencyMatches && (
          <p className={styles.warningAlert} role="alert">
            API が返した最大同時実行数（{formatCount(capacity.maxConcurrency)}）が S × P（
            {formatCount(view.maxConcurrency)}）と一致しません。
          </p>
        )}
      </div>

      {/* ── パイプラインと後続処理の設定 ── */}
      <div className={styles.subCard}>
        <h3 className={styles.subTitle}>後続処理の設定</h3>
        <p className={styles.fieldHint}>
          擬似待機を持つのは決済と通知の 2 段階のみ（design §10.1）。引当とポイント付与の
          所要時間はオーバーヘッドに含めて扱う。
        </p>
        <dl className={styles.summaryGrid}>
          <SummaryItem label="パイプライン構成" value={config.pipelineMode} mono />
          <SummaryItem label="バッチサイズ" value={formatCount(config.stream.batchSize)} />
          <SummaryItem
            label="並列化係数 (PF)"
            value={formatCount(config.stream.parallelizationFactor)}
          />
          <SummaryItem
            label="決済の擬似処理時間"
            value={formatElapsedMs(config.stageDelaysMs.payment)}
          />
          <SummaryItem
            label="通知の擬似処理時間"
            value={formatElapsedMs(config.stageDelaysMs.notification)}
          />
          <SummaryItem label="決済の擬似失敗率" value={formatPercent(config.paymentFailureRate)} />
          <SummaryItem
            label="注文データの保持期間"
            value={
              Number.isFinite(config.dataTtlDays)
                ? `${formatCount(config.dataTtlDays)} 日（${formatDurationSeconds(
                    config.dataTtlDays * SECONDS_PER_DAY
                  )}）`
                : EMPTY_VALUE
            }
          />
        </dl>
      </div>

      {/* ── パラメータの上限 ── */}
      <div className={styles.subCard}>
        <h3 className={styles.subTitle}>負荷生成・並行計測の上限</h3>
        <p className={styles.fieldHint}>
          負荷テストのタブの入力欄はこの上限で検証される。画面側に定数として持たず、
          この応答を出典にしている（要件 10.6）。上限は API に認証を掛けていない構成での
          歯止めでもある（design §8）。
        </p>
        <dl className={styles.summaryGrid}>
          <SummaryItem
            label="目標投入レートの上限"
            value={`${formatCount(config.limits.maxOrdersPerMinute)} 件/分`}
          />
          <SummaryItem
            label="継続時間の上限"
            value={formatSeconds(config.limits.maxDurationSeconds)}
          />
          <SummaryItem
            label="並行計測の並行数の上限"
            value={`${formatCount(config.limits.maxMeasureConcurrency)} 並行`}
          />
        </dl>
      </div>
    </div>
  );
}
