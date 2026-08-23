"use client";

import { CopilotKit } from "@copilotkit/react-core/v2";
import { fetchAuthSession } from "aws-amplify/auth";
import { useState, useEffect, type ReactNode } from "react";

interface CopilotProviderProps {
  children: ReactNode;
}

/**
 * CopilotKit を Next.js API Route 経由で AgentCore Runtime に接続するプロバイダー。
 *
 * /api/copilotkit が CopilotKit Runtime として動作し、AgentCore Runtime にプロキシする。
 * 認証は Amplify の Cognito トークンを Bearer ヘッダーとして渡す。
 */
export function CopilotProvider({ children }: CopilotProviderProps) {
  const [headers, setHeaders] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadToken() {
      try {
        const session = await fetchAuthSession();
        const token = session.tokens?.accessToken?.toString();
        if (!cancelled) {
          setHeaders(
            token ? { Authorization: `Bearer ${token}` } : {},
          );
        }
      } catch {
        if (!cancelled) {
          setHeaders({});
        }
      }
    }

    loadToken();
    return () => { cancelled = true; };
  }, []);

  if (headers === null) {
    return (
      <div style={{ padding: "1rem", color: "#6b7280", fontSize: "0.9rem" }}>
        認証情報を取得中...
      </div>
    );
  }

  return (
    <CopilotKit
      runtimeUrl="/api/copilotkit"
      headers={headers}
      agent="sample_agent"
    >
      {children}
    </CopilotKit>
  );
}
