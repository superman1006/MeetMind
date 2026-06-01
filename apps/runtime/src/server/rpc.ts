/**
 * JSON-RPC 2.0 分发。
 *   chat.send         触发一轮讨论(后台跑,立即返回,输出走 SSE)
 *   chat.interrupt    打断进行中的讨论(abort,本轮丢弃不落库)
 *   session.create    新建会话(返 {id,title,created_at})
 *   session.list      列出所有会话
 *   session.messages  取某会话历史(渲染气泡用)
 *   session.rename    重命名会话(改 title)
 *   session.delete    删除会话(级联删消息;busy 中拒删)
 */
import type { buildGraph } from "../graph/builder.js";
import { runDiscussion } from "./runDiscussion.js";
import * as sessions from "./sessions.js";
import * as chatStore from "../database/chatStore.js";

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
    // 每轮挂一个 AbortController,signal 透传给 graph.stream;chat.interrupt 据此打断。
    const controller = new AbortController();
    sessions.setController(sessionId, controller);
    // 后台跑,不 await:HTTP 立即返回,真正的输出全走 SSE;跑完(成功/失败/被打断)都清 busy + controller。
    // 必须 catch:否则 runDiscussion 一旦 reject,finally 会把异常再抛出成未处理的
    // Promise rejection,在 Node 15+ 上直接拖垮整个服务进程。
    const running = runDiscussion(graph, sessionId, requirement, controller.signal);
    running
      .catch((exc) => {
        console.error(`[rpc] runDiscussion 未捕获异常 (会话 ${sessionId}):`, exc);
      })
      .finally(() => {
        sessions.setBusy(sessionId, false);
        sessions.clearController(sessionId);
      });
    return rpcOk(id, { ok: true });
  }

  if (body.method === "chat.interrupt") {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      return rpcError(id, -32602, "缺少 sessionId");
    }
    // 打断进行中的讨论:abort() 会让 graph.stream 抛错,runDiscussion 捕获后丢弃本轮。
    // 没有进行中的讨论(无 controller)也返回 ok,幂等。
    const controller = sessions.getController(sessionId);
    if (controller) {
      controller.abort();
    }
    return rpcOk(id, { ok: true });
  }

  if (body.method === "session.create") {
    const rawTitle = params.title;
    const title = typeof rawTitle === "string" && rawTitle ? rawTitle : "新会话";
    const meta = await chatStore.createSession(title);
    return rpcOk(id, meta);
  }

  if (body.method === "session.list") {
    const list = await chatStore.listSessions();
    return rpcOk(id, list);
  }

  if (body.method === "session.messages") {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      return rpcError(id, -32602, "缺少 sessionId");
    }
    const messages = await chatStore.getMessages(sessionId);
    return rpcOk(id, messages);
  }

  if (body.method === "session.rename") {
    const sessionId = params.sessionId;
    const rawTitle = params.title;
    if (typeof sessionId !== "string" || !sessionId) {
      return rpcError(id, -32602, "缺少 sessionId");
    }
    if (typeof rawTitle !== "string" || !rawTitle.trim()) {
      return rpcError(id, -32602, "title 不能为空");
    }
    await chatStore.renameSession(sessionId, rawTitle.trim());
    return rpcOk(id, { ok: true });
  }

  if (body.method === "session.delete") {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      return rpcError(id, -32602, "缺少 sessionId");
    }
    if (sessions.isBusy(sessionId)) {
      return rpcError(id, -32000, "该会话讨论进行中,无法删除");
    }
    await chatStore.deleteSession(sessionId);
    return rpcOk(id, { ok: true });
  }

  return rpcError(id, -32601, `未知方法: ${body.method}`);
}
