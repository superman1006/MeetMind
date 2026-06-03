// 这个文件:后端「按 method 分诊并干活」的地方(JSON-RPC 业务总机)。
// 上游是 httpServer 读出请求体后交到这里;看请求里的 method 是哪个功能,就转给对应逻辑处理。
import type { buildGraph } from "../graph/builder.js";
import { runDiscussion } from "./runDiscussion.js";
import * as sessions from "./sessions.js";
import * as chatStore from "../database/chatStore.js";

// 一条进来的 JSON-RPC 请求的形状(和前端 rpcClient 发的一一对应)。
export interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type CompiledGraph = ReturnType<typeof buildGraph>;
type RpcId = string | number | null;

// 拼一个标准的 JSON-RPC「失败」响应:code 是错误码,message 给人看。
function rpcError(id: RpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

// 拼一个标准的 JSON-RPC「成功」响应,把真正的结果放进 result。
function rpcOk(id: RpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

// 总机主函数:拿到一条请求,按 method 分发处理,返回要回给前端的响应对象(由 httpServer 写回)。
export async function handleRpc(graph: CompiledGraph, body: RpcRequest) {
  // id 可能没带,兜底成 null;params 没带就当空对象,后面取字段不会崩。
  const id: RpcId = body.id ?? null;
  const params = body.params ?? {};

  // chat.send:开始一轮讨论。
  if (body.method === "chat.send") {
    const sessionId = params.sessionId;
    const requirement = params.requirement;
    // 校验参数必须是非空字符串,不合法回 -32602(参数错误)。
    if (typeof sessionId !== "string" || typeof requirement !== "string" || !sessionId || !requirement) {
      return rpcError(id, -32602, "缺少 sessionId 或 requirement");
    }
    // 同一会话一次只能跑一轮,正在跑就拒绝。
    if (sessions.isBusy(sessionId)) {
      return rpcError(id, -32000, "上一轮讨论还在进行");
    }
    sessions.setBusy(sessionId, true);

    // AbortController 是个“紧急停止”开关,signal 透传给 graph.stream;之后 chat.interrupt 靠它叫停本轮。
    const controller = new AbortController();
    sessions.setController(sessionId, controller);

    // 关键:这里不 await。讨论很慢,但 HTTP 要立刻回话(否则前端傻等),所以马上回 {ok:true},真正的发言内容稍后全走 SSE 推。
    const running = runDiscussion(graph, sessionId, requirement, controller.signal);
    // 必须 .catch:否则讨论失败时未处理的 Promise 异常会在 Node 15+ 直接拖垮整个服务进程。
    // finally:不管成功/失败/被打断,都清掉 busy 和 controller,让会话能再次开跑。
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

  // chat.interrupt:打断进行中的讨论。
  if (body.method === "chat.interrupt") {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      return rpcError(id, -32602, "缺少 sessionId");
    }
    // 按下“紧急停止”:abort() 会让 graph.stream 抛错,runDiscussion 捕获后丢弃本轮;没有进行中的讨论也照样回 ok(幂等)。
    const controller = sessions.getController(sessionId);
    if (controller) {
      controller.abort();
    }
    return rpcOk(id, { ok: true });
  }

  // session.create:新建会话。没给标题就用默认名“新会话”。然后返回
  if (body.method === "session.create") {
    const rawTitle = params.title;
    const title = (typeof rawTitle === "string" && rawTitle) ? rawTitle : "新会话";
    const meta = await chatStore.createSession(title);
    return rpcOk(id, meta);
  }

  // session.list:列出所有会话。
  if (body.method === "session.list") {
    const list = await chatStore.listSessions();
    return rpcOk(id, list);
  }

  // session.messages:取某会话的历史消息(前端用来渲染气泡)。
  if (body.method === "session.messages") {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      return rpcError(id, -32602, "缺少 sessionId");
    }
    const messages = await chatStore.getMessages(sessionId);
    return rpcOk(id, messages);
  }

  // session.rename:重命名会话。
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

  // session.delete:删除会话(级联删消息)。讨论进行中不允许删,避免删一半导致状态错乱。
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

  // 所有已知 method 都没匹配上 → 回 -32601(方法不存在)。
  return rpcError(id, -32601, `未知方法: ${body.method}`);
}
