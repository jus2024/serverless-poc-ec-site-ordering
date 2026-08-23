"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "@/amplify/data/resource";
import { isAmplifyConfigured } from "@/src/lib/amplify/AmplifyProvider";
import AgentChatSection from "@/src/components/agent/AgentChatSection";
import styles from "./sample.module.css";

type Todo = Schema["Todo"]["type"];

/**
 * サンプルページ: Amplify Data (Todo CRUD)
 *
 * sandbox 起動後に /sample にアクセスすると、
 * Amplify バックエンドとの連携を確認できます。
 */
export default function SamplePage() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [client] = useState(() =>
    isAmplifyConfigured() ? generateClient<Schema>() : null
  );

  useEffect(() => {
    if (!client) {
      setError(
        "Amplify バックエンドに接続できません。sandbox が起動しているか確認してください。"
      );
      return;
    }

    const sub = client.models.Todo.observeQuery().subscribe({
      next: ({ items }) => setTodos([...items]),
      error: (err) => setError(String(err)),
    });
    return () => sub.unsubscribe();
  }, [client]);

  async function addTodo() {
    if (!client) return;
    const content = input.trim();
    if (!content) return;
    setInput("");
    await client.models.Todo.create({ content, isDone: false });
  }

  async function toggleTodo(todo: Todo) {
    if (!client) return;
    await client.models.Todo.update({ id: todo.id, isDone: !todo.isDone });
  }

  async function deleteTodo(id: string) {
    if (!client) return;
    await client.models.Todo.delete({ id });
  }

  return (
    <main className={styles.main}>
      <h1 className={styles.title}>サンプル: Todo リスト</h1>
      <p className={styles.description}>
        Amplify Data との連携サンプルです。
        <code>amplify/data/resource.ts</code> で定義した Todo
        モデルの CRUD を確認できます。
      </p>

      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}

      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          addTodo();
        }}
      >
        <label htmlFor="todo-input" className={styles.srOnly}>
          Todo の内容
        </label>
        <input
          id="todo-input"
          className={styles.input}
          type="text"
          placeholder="新しい Todo を入力..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className={styles.addButton} type="submit">
          追加
        </button>
      </form>

      {todos.length === 0 && !error ? (
        <p className={styles.empty}>Todo はまだありません。</p>
      ) : (
        <ul className={styles.list}>
          {todos.map((todo) => (
            <li key={todo.id} className={styles.item}>
              <label className={styles.itemLabel}>
                <input
                  type="checkbox"
                  checked={todo.isDone ?? false}
                  onChange={() => toggleTodo(todo)}
                />
                <span
                  className={
                    todo.isDone ? styles.contentDone : styles.content
                  }
                >
                  {todo.content}
                </span>
              </label>
              <button
                className={styles.deleteButton}
                onClick={() => deleteTodo(todo.id)}
                aria-label={`${todo.content} を削除`}
              >
                削除
              </button>
            </li>
          ))}
        </ul>
      )}

      <nav className={styles.nav}>
        <Link href="/">← トップページに戻る</Link>
      </nav>

      <AgentChatSection runtimeArn={process.env.NEXT_PUBLIC_AGENTCORE_RUNTIME_ARN} />
    </main>
  );
}