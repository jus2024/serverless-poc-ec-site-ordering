"use client";

import { Amplify } from "aws-amplify";
import { Authenticator } from "@aws-amplify/ui-react";
import "@aws-amplify/ui-react/styles.css";

/**
 * Amplify 初期化プロバイダー
 *
 * モジュール読み込み時に同期的に Amplify.configure() を実行する。
 * amplify_outputs.json が存在しない場合（sandbox 未起動時）は
 * configure をスキップし、コンソールに案内を出す。
 */
let configured = false;

try {
  const outputs = require("@/amplify_outputs.json");
  Amplify.configure(outputs.default ?? outputs);
  configured = true;
} catch {
  console.info(
    "[AmplifyProvider] amplify_outputs.json が見つかりません。sandbox を起動してください。"
  );
}

export function isAmplifyConfigured(): boolean {
  return configured;
}

export default function AmplifyProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!configured) {
    return <>{children}</>;
  }
  return <Authenticator>{children}</Authenticator>;
}