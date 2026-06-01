/**
 * JSON-RPC 2.0 分发。chat.send 触发一轮讨论(后台跑,立即返回,输出走 SSE);session.reset 清记忆。
 */
import type { buildGraph } from "../graph/builder.js";
import { runDiscussion } from "./runDiscussion.js";
import * as sessions from "./sessions.js";

export interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type CompiledGraph = ReturnType<typeof buildGraph>;
type RpcId = string | number | null;

/** 构造 JSON-RPC 错误响应。 */
function rpcError(id: RpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

/** 构造 JSON-RPC 成功响应。 */
function rpcOk(id: RpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

export async function handleRpc(graph: CompiledGraph, body: RpcRequest) {
  const id: RpcId = body.id ?? null;
  const params = body.params ?? {};

  if (body.method === "chat.send") {
    const sessionId = params.sessionId;
    const requirement = params.requirement;
    if (typeof sessionId !== "string" || typeof requirement !== "string" || !sessionId || !requirement) {
      return rpcError(id, -32602, "缺少 sessionId 或 requirement");
    }
    if (sessions.isBusy(sessionId)) {
      return rpcError(id, -32000, "上一轮讨论还在进行");
    }
    sessions.setBusy(sessionId, true);
    // 后台跑,不 await:HTTP 立即返回,真正的输出全走 SSE;跑完(成功或失败)都清 busy
    const running = runDiscussion(graph, sessionId, requirement);
    running.finally(() => {
      sessions.setBusy(sessionId, false);
    });
    return rpcOk(id, { ok: true });
  }

  if (body.method === "session.reset") {
    const sessionId = params.sessionId;
    if (typeof sessionId === "string" && sessionId) {
      sessions.resetSession(sessionId);
    }
    return rpcOk(id, { ok: true });
  }

  return rpcError(id, -32601, `未知方法: ${body.method}`);
}
