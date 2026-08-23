"use client";

import styles from "./page.module.css";

/** テンプレートのトップページ */
export default function Home() {
  return (
    <main className={styles.main}>
      <section className={styles.hero}>
        <h1 className={styles.title}>業務 Web アプリテンプレート</h1>
        <p className={styles.subtitle}>
          AWS Amplify Gen 2 + Next.js + TypeScript
        </p>
      </section>

      <section className={styles.grid}>
        <article className={styles.card}>
          <h2>はじめに</h2>
          <p>
            <code>src/app/page.tsx</code> を編集して、
            業務アプリの構築を開始してください。
          </p>
        </article>

        <article className={styles.card}>
          <h2>バックエンド</h2>
          <p>
            <code>amplify/</code> 配下で認証・データモデル・
            API を定義します。
          </p>
        </article>

        <article className={styles.card}>
          <h2>エージェント（任意）</h2>
          <p>
            <code>agents/</code> 配下に Strands Agents を
            追加して AI 機能を拡張できます。
          </p>
        </article>

        <article className={styles.card}>
          <h2>デプロイ</h2>
          <p>
            GitHub に Push すると Amplify Hosting が
            自動でビルド・デプロイします。
          </p>
        </article>
      </section>

      <footer className={styles.footer}>
        <p>
          <a href="/sample">→ サンプルページ（Todo CRUD）を試す</a>
        </p>
        <p>
          詳細は{" "}
          <a
            href="https://docs.amplify.aws/nextjs/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Amplify Gen 2 ドキュメント
          </a>{" "}
          を参照してください。
        </p>
      </footer>
    </main>
  );
}
