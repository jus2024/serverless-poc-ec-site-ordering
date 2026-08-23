/**
 * 共通ユーティリティ
 *
 * プロジェクト全体で使う汎用関数をここに追加してください。
 */

/** クラス名を結合する（falsy な値は除外） */
export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}
