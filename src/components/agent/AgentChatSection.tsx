"use client";

import { CopilotChat } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";
import { CopilotProvider } from "@/src/lib/agent/CopilotProvider";

interface AgentChatSectionProps {
  runtimeArn: string | undefined;
}

/**
 * エージェントチャット UI セクション。
 * CopilotKit + AG-UI プロトコルで AgentCore Runtime と通信する。
 * 通信は /api/copilotkit (Next.js API Route) 経由。
 */
export default function AgentChatSection({ runtimeArn }: AgentChatSectionProps) {
  const isRuntimeConfigured = !!runtimeArn?.trim();

  return (
    <section
      style={{
        marginTop: "3rem",
        paddingTop: "2rem",
        borderTop: "1px solid var(--color-border, #e5e7eb)",
      }}
    >
      <h2
        style={{
          fontSize: "1.5rem",
          fontWeight: 700,
          marginBottom: "0.5rem",
        }}
      >
        サンプル: エージェントチャット
      </h2>
      <p
        style={{
          color: "var(--color-text-secondary, #6b7280)",
          marginBottom: "2rem",
          lineHeight: 1.6,
        }}
      >
        AgentCore Runtime との連携サンプルです。AG-UI プロトコル経由で
        CopilotKit がエージェントと対話します。
      </p>

      {!isRuntimeConfigured && (
        <div
          role="status"
          style={{
            backgroundColor: "#eff6ff",
            border: "1px solid #93c5fd",
            color: "#1e40af",
            borderRadius: "var(--radius, 0.5rem)",
            padding: "0.75rem 1rem",
            marginBottom: "1.5rem",
            fontSize: "0.9rem",
          }}
        >
          AgentCore Runtime
          が設定されていません。NEXT_PUBLIC_AGENTCORE_RUNTIME_ARN
          を設定してください。
        </div>
      )}

      {isRuntimeConfigured && (
        <CopilotProvider>
          <div style={{ height: "500px", border: "1px solid #e5e7eb", borderRadius: "0.5rem" }}>
            <CopilotChat
              labels={{
                title: "エージェントチャット",
                initial: "こんにちは！何かお手伝いできることはありますか？",
                placeholder: "メッセージを入力...",
              }}
            />
          </div>
        </CopilotProvider>
      )}
    </section>
  );
}
