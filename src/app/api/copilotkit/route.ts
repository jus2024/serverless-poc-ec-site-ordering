import { CopilotRuntime, ExperimentalEmptyAdapter, copilotRuntimeNextJSAppRouterEndpoint } from "@copilotkit/runtime";
import { HttpAgent } from "@ag-ui/client";
import { NextRequest } from "next/server";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { defaultProvider } from "@aws-sdk/credential-provider-node";

/**
 * CopilotKit Runtime API Route
 *
 * HttpAgent（カスタム fetch で SigV4 署名）→ AgentCore。
 * agent と runtime はモジュールスコープで1回だけ生成。
 */

const AGENTCORE_RUNTIME_ARN = process.env.NEXT_PUBLIC_AGENTCORE_RUNTIME_ARN;
const REGION = "us-west-2";

function buildInvocationUrl(runtimeArn: string): string {
  const parts = runtimeArn.split(":");
  const region = parts[3] || REGION;
  const encodedArn = encodeURIComponent(runtimeArn);
  return `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodedArn}/invocations?qualifier=DEFAULT`;
}

async function sigv4Fetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const targetUrl = new URL(typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url);
  const body = init?.body ? String(init.body) : "";

  const httpRequest = new HttpRequest({
    method: "POST",
    protocol: targetUrl.protocol.replace(":", ""),
    hostname: targetUrl.hostname,
    path: targetUrl.pathname,
    query: Object.fromEntries(targetUrl.searchParams),
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      host: targetUrl.hostname,
      // TODO: Memory 有効化時に以下を追加
      // "X-Amzn-Bedrock-AgentCore-Runtime-User-Id": userId,
      // "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": sessionId,
    },
    body,
  });

  const signer = new SignatureV4({
    service: "bedrock-agentcore",
    region: REGION,
    credentials: defaultProvider(),
    sha256: Sha256,
  });

  const signed = await signer.sign(httpRequest);

  return fetch(targetUrl.toString(), {
    method: "POST",
    headers: signed.headers as Record<string, string>,
    body,
    signal: init?.signal,
  });
}

// モジュールスコープで agent と runtime を1回だけ生成
const agentUrl = AGENTCORE_RUNTIME_ARN ? buildInvocationUrl(AGENTCORE_RUNTIME_ARN) : "";

const agent = agentUrl
  ? new HttpAgent({ url: agentUrl, fetch: sigv4Fetch })
  : null;

// @ts-expect-error — @ag-ui/client HttpAgent と @copilotkit/runtime の型定義のバージョン差異
const runtime = agent ? new CopilotRuntime({ agents: { sample_agent: agent } }) : null;

export async function POST(req: NextRequest) {
  if (!runtime) {
    return new Response(
      JSON.stringify({ error: "NEXT_PUBLIC_AGENTCORE_RUNTIME_ARN is not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // フロントエンドの Cognito トークン存在チェック
  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime,
    serviceAdapter: new ExperimentalEmptyAdapter(),
    endpoint: "/api/copilotkit",
  });

  return handleRequest(req);
}
