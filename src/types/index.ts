/**
 * 共通型定義
 *
 * プロジェクト全体で使う型をここに追加してください。
 */

/** API レスポンスの汎用ラッパー */
export interface ApiResponse<T> {
  data: T;
  error?: string;
}

/** チャットメッセージの送信者 */
export type MessageRole = "user" | "assistant";

/** チャットメッセージ */
export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
}