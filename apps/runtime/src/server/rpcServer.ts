// 这个文件:后端「按 method 分诊并干活」的地方(JSON-RPC 业务总机)。
// 上游是 httpServer 读出请求体后交到这里;看请求里的 method 是哪个功能,就转给对应逻辑处理。
import { ChatOpenAI } from "@langchain/openai";
import { buildGraph } from "../graph/builder.js";
import { runExecution, resumeExecution } from "./runExecution.js";
import { deleteThreadCheckpoints } from "../graph/checkpointer.js";
import type { AgentState } from "../graph/state.js";
import * as sessions from "./sessions.js";
import * as toolApprovals from "./toolApprovals.js";
import * as chatStore from "../database/chat/chatStore.js";
import * as userStore from "../database/users/userStore.js";
import * as sse from "./sseServer.js";
import { summarizeMeeting } from "./meetingSummary.js";
import { summarizeTitle } from "./titleSummary.js";
import { getSettings, setModelOverrides, getCurrentModelConfig } from "../config/settings.js";

// 一条进来的 JSON-RPC 请求的形状(和前端 rpcClient 发的一一对应)。
export interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type CompiledGraph = ReturnType<typeof buildGraph>;
type RpcId = string | number | null;

// graph 的可变持有者：model.set 改完模型配置后会 buildGraph() 重建并换掉 current，
// 后续 chat.send 读 current 即用新模型。进行中的那一轮已捕获旧 graph 引用，不受影响（下一轮才换）。
export interface GraphHolder {
  current: CompiledGraph;
}

// 拼一个标准的 JSON-RPC「失败」响应:code 是错误码,message 给人看。
function rpcError(id: RpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

// 拼一个标准的 JSON-RPC「成功」响应,把真正的结果放进 result。
function rpcOk(id: RpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

// 总机主函数:拿到一条请求,按 method 分发处理,返回要回给前端的响应对象(由 httpServer 写回)。
// graph 传入可变持有者(holder),而非裸 graph：model.set 重建后能让后续请求用上新模型。
export async function handleRpc(graph: GraphHolder, body: RpcRequest) {
  // id 可能没带,兜底成 null;params 没带就当空对象,后面取字段不会崩。
  const id: RpcId = body.id ?? null;
  const params = body.params ?? {};

  // user.login:登录鉴权。校验用户名 / 密码,命中回 {ok:true, username},否则回 {ok:false}。
  // 注意:密码错是「业务失败」,回 ok:false 让前端弹窗;不走 rpcError(那会让前端 rpc() 抛异常)。
  if (body.method === "user.login") {
    const username = params.username;
    const password = params.password;
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      return rpcError(id, -32602, "缺少 username 或 password");
    }
    const result = await userStore.verifyUser(username, password);
    if (!result.ok) {
      return rpcOk(id, { ok: false });
    }
    return rpcOk(id, { ok: true, username: result.username });
  }

  // user.registry:注册新用户。校验用户名 / 密码非空,交给 userStore 原子判重写库。
  // 用户名已存在是「业务失败」,回 {ok:false, reason:"exists"} 让前端弹「用户已存在」;不走 rpcError(那会让前端 rpc() 抛异常)。
  // 注册成功只回 {ok:true},不自动登录——前端据此回到登录窗口让用户重新登录。
  if (body.method === "user.registry") {
    const username = params.username;
    const password = params.password;
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      return rpcError(id, -32602, "缺少 username 或 password");
    }
    const result = await userStore.createUser(username, password);
    if (!result.ok) {
      return rpcOk(id, { ok: false, reason: result.reason });
    }
    return rpcOk(id, { ok: true });
  }

  // user.getMemory:读取当前登录用户的个人记忆(按 username 定位,与 session.* 一致)。
  // 未命中 / memory 为 NULL 由 userStore 兜成空串,这里只透传。
  if (body.method === "user.getMemory") {
    const username = params.username;
    if (typeof username !== "string" || !username) {
      return rpcError(id, -32602, "缺少 username");
    }
    const memory = await userStore.getMemory(username);
    return rpcOk(id, { memory });
  }

  // user.setMemory:整字段覆盖写入当前登录用户的个人记忆。
  // memory 必须是字符串,但空串合法(表示清空记忆),故不做非空校验。
  if (body.method === "user.setMemory") {
    const username = params.username;
    const memory = params.memory;
    if (typeof username !== "string" || !username) {
      return rpcError(id, -32602, "缺少 username");
    }
    if (typeof memory !== "string") {
      return rpcError(id, -32602, "memory 必须是字符串");
    }
    await userStore.setMemory(username, memory);
    return rpcOk(id, { ok: true });
  }

  // chat.send:开始一轮讨论。
  if (body.method === "chat.send") {
    const sessionId = params.sessionId;
    const requirement = params.requirement;
    // 校验参数必须是非空字符串,不合法回 -32602(参数错误)。
    if (typeof sessionId !== "string" || typeof requirement !== "string" || !sessionId || !requirement) {
      return rpcError(id, -32602, "缺少 sessionId 或 requirement");
    }
    // 会议已结束(持久化在 DB)→ 拒绝继续讨论。前端已拦,这里是服务端兜底。
    if (await chatStore.isSessionEnded(sessionId)) {
      return rpcError(id, -32000, "会议已结束,无法继续讨论");
    }
    // 同一会话一次只能跑一轮,正在跑就拒绝。
    if (sessions.isBusy(sessionId)) {
      return rpcError(id, -32000, "上一轮讨论还在进行");
    }
    sessions.setBusy(sessionId, true);

    // AbortController 是个"紧急停止"开关,signal 透传给 graph.stream;之后 chat.interrupt 靠它叫停本轮。
    const controller = new AbortController();
    sessions.setController(sessionId, controller);

    // 关键:这里不 await。讨论很慢,但 HTTP 要立刻回话(否则前端傻等),所以马上回 {ok:true},真正的发言内容稍后全走 SSE 推。
    const running = runExecution(graph.current, sessionId, requirement, controller.signal);
    // 必须 .catch:否则讨论失败时未处理的 Promise 异常会在 Node 15+ 直接拖垮整个服务进程。
    // finally:不管成功/失败/被打断,都清掉 busy 和 controller,让会话能再次开跑。
    running
      .catch((exc) => {
        console.error(`[rpc] runExecution 未捕获异常 (会话 ${sessionId}):`, exc);
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
    // 按下"紧急停止":abort() 会让 graph.stream 抛错,runExecution 捕获后丢弃本轮;没有进行中的讨论也照样回 ok(幂等)。
    const controller = sessions.getController(sessionId);
    if (controller) {
      controller.abort();
    }
    return rpcOk(id, { ok: true });
  }

  // chat.getResumable:探测本会话是否有崩溃残留的未完成轮可恢复。
  if (body.method === "chat.getResumable") {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      return rpcError(id, -32602, "缺少 sessionId");
    }
    // 正在跑就不提示恢复。
    if (sessions.isBusy(sessionId)) {
      return rpcOk(id, { resumable: false });
    }
    const threadId = await chatStore.getPendingThread(sessionId);
    if (!threadId) {
      return rpcOk(id, { resumable: false });
    }
    // 取 checkpoint 当前状态里「超出 DB」的发言，供前端先渲染崩溃前内容。
    let pendingTurns: unknown[] = [];
    try {
      const snapshot = await graph.current.getState({ configurable: { thread_id: threadId } });
      const stateValues = snapshot?.values as AgentState | undefined;
      const checkpointMessages = stateValues?.messages ?? [];
      const dbMessages = await chatStore.getMessages(sessionId);
      pendingTurns = checkpointMessages.slice(dbMessages.length);
    } catch (exc) {
      console.error(`[rpc] getResumable 读取 checkpoint 失败 (会话 ${sessionId}):`, exc);
      return rpcOk(id, { resumable: false });
    }
    if (pendingTurns.length === 0) {
      return rpcOk(id, { resumable: false });
    }
    return rpcOk(id, { resumable: true, pendingTurns });
  }

  // chat.discardResumable:放弃崩溃残留的未完成轮——清掉在途 thread 标记 + 删该 thread 的 checkpoint，
  // 使其不再被 getResumable 探测到（之后该会话回到「干净空闲、可发新消息」的状态）。
  if (body.method === "chat.discardResumable") {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      return rpcError(id, -32602, "缺少 sessionId");
    }
    // 正在跑就不该丢弃（应先打断）。
    if (sessions.isBusy(sessionId)) {
      return rpcError(id, -32000, "上一轮讨论还在进行,无法放弃");
    }
    const threadId = await chatStore.getPendingThread(sessionId);
    // 先清 DB 里的在途标记；有 threadId 再顺手删它的 checkpoint，避免残留。
    await chatStore.clearPendingThread(sessionId);
    if (threadId) {
      try {
        await deleteThreadCheckpoints(threadId);
      } catch (exc) {
        console.error(`[rpc] discardResumable 删 checkpoint 失败 (会话 ${sessionId}):`, exc);
      }
    }
    return rpcOk(id, { ok: true });
  }

  // chat.resume:从崩溃残留的 checkpoint 续跑未完成轮（仿 chat.send 不 await）。
  if (body.method === "chat.resume") {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      return rpcError(id, -32602, "缺少 sessionId");
    }
    if (await chatStore.isSessionEnded(sessionId)) {
      return rpcError(id, -32000, "会议已结束,无法继续讨论");
    }
    if (sessions.isBusy(sessionId)) {
      return rpcError(id, -32000, "上一轮讨论还在进行");
    }
    const threadId = await chatStore.getPendingThread(sessionId);
    if (!threadId) {
      return rpcError(id, -32000, "没有可恢复的未完成轮次");
    }
    sessions.setBusy(sessionId, true);
    const controller = new AbortController();
    sessions.setController(sessionId, controller);
    const running = resumeExecution(graph.current, sessionId, controller.signal);
    running
      .catch((exc) => {
        console.error(`[rpc] resumeExecution 未捕获异常 (会话 ${sessionId}):`, exc);
      })
      .finally(() => {
        sessions.setBusy(sessionId, false);
        sessions.clearController(sessionId);
      });
    return rpcOk(id, { ok: true });
  }

  // chat.summaryTitle:为新会话的首条用户输入生成一个简短标题(≤15 字),写入 DB 并回给前端。
  // 与 chat.send(架构师讨论)各自独立调一次 LLM、并行进行(两条独立 HTTP 请求)。
  // 失败/超时/空标题按「业务失败」回 ok:false,前端据此保留默认标题——不走 rpcError(那会让前端 rpc() 抛异常)。
  if (body.method === "chat.summaryTitle") {
    const sessionId = params.sessionId;
    const requirement = params.requirement;
    if (typeof sessionId !== "string" || typeof requirement !== "string" || !sessionId || !requirement) {
      return rpcError(id, -32602, "缺少 sessionId 或 requirement");
    }
    // summarizeTitle 内部已 try/catch,失败返回空串,不会抛。
    const title = await summarizeTitle(requirement);
    if (!title) {
      return rpcOk(id, { ok: false });
    }
    await chatStore.renameSession(sessionId, title);
    return rpcOk(id, { ok: true, title });
  }

  // toolApproval:工具风险审批回执——前端点同意/拒绝后调，兑现后端挂起的审批 Promise。
  if (body.method === "toolApproval") {
    const approvalId = params.approvalId;
    const approved = params.approved;
    if (typeof approvalId !== "string" || !approvalId) {
      return rpcError(id, -32602, "缺少 approvalId");
    }
    if (typeof approved !== "boolean") {
      return rpcError(id, -32602, "approved 必须是布尔值");
    }
    // 未知 approvalId（已取消/已处理/打断后）时 resolve 返回 false：幂等回 ok，不报错。
    toolApprovals.resolve(approvalId, approved);
    return rpcOk(id, { ok: true });
  }

  // chat.end:结束会议——立即返回,后台让各 agent 整理会议纪要(仿 chat.send 不 await)。
  if (body.method === "chat.end") {
    const sessionId = params.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      return rpcError(id, -32602, "缺少 sessionId");
    }
    // 一个会话 = 一个会议:已结束就不能再次结束/整理(状态持久化在 DB)。
    if (await chatStore.isSessionEnded(sessionId)) {
      return rpcError(id, -32000, "会议已结束,无法再次结束");
    }
    // 仅空闲时可结束;讨论进行中先打断再结束(服务端兜底,前端按钮也已置灰)。
    if (sessions.isBusy(sessionId)) {
      return rpcError(id, -32000, "讨论进行中,无法结束会议,请先打断");
    }
    // 先持久化「已结束」,从此该会话锁定(刷新/重启后依然拒绝再发送/再结束)。
    await chatStore.markSessionEnded(sessionId);
    // 上锁,防止整理期间又被 chat.send / 再次 chat.end 插入。
    sessions.setBusy(sessionId, true);
    // 不 await:整理很慢(6 次 LLM),HTTP 立即回 ok,进度/结果走 SSE。
    const running = summarizeMeeting(sessionId);
    running
      .catch((exc) => {
        console.error(`[rpc] summarizeMeeting 未捕获异常 (会话 ${sessionId}):`, exc);
        sse.send(sessionId, "summary_error", { message: String(exc) });
      })
      .finally(() => {
        sessions.setBusy(sessionId, false);
      });
    return rpcOk(id, { ok: true });
  }

  // session.create:新建会话(归属当前登录用户 username)。没给标题就用默认名"新会话"。
  // 必须带 username,否则新建的会话挂不到该用户名下、他自己的列表里反而看不到。
  if (body.method === "session.create") {
    const username = params.username;
    if (typeof username !== "string" || !username) {
      return rpcError(id, -32602, "缺少 username");
    }
    const rawTitle = params.title;
    const title = (typeof rawTitle === "string" && rawTitle) ? rawTitle : "新会话";
    const meta = await chatStore.createSession(title, username);
    return rpcOk(id, meta);
  }

  // session.list:按用户隔离——只列出当前登录用户(username)自己的会话。
  if (body.method === "session.list") {
    const username = params.username;
    if (typeof username !== "string" || !username) {
      return rpcError(id, -32602, "缺少 username");
    }
    const list = await chatStore.listSessions(username);
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

  // model.get:读取当前生效的 LLM 模型配置(供前端设置面板回填)。apiKey 只回脱敏值。
  if (body.method === "model.get") {
    return rpcOk(id, getCurrentModelConfig());
  }

  // model.set:前端下发新的 LLM 模型配置(url / apikey / modelname),热切换 runtime 用的模型。
  if (body.method === "model.set") {
    const apiKey = params.apiKey;
    const baseUrl = params.baseUrl;
    const modelName = params.modelName;
    // 三者皆可选,但传了就必须是字符串;一个有效字段都没有则拒绝(避免空操作还重建图)。
    if (apiKey !== undefined && typeof apiKey !== "string") {
      return rpcError(id, -32602, "apiKey 必须是字符串");
    }
    if (baseUrl !== undefined && typeof baseUrl !== "string") {
      return rpcError(id, -32602, "baseUrl 必须是字符串");
    }
    if (modelName !== undefined && typeof modelName !== "string") {
      return rpcError(id, -32602, "modelName 必须是字符串");
    }
    // 只收非空字段:空字符串视为"不修改该项"(如 apiKey 留空表示沿用已配置的 key)。
    const overrides: { apiKey?: string; baseUrl?: string; modelName?: string } = {};
    if (typeof apiKey === "string" && apiKey) {
      overrides.apiKey = apiKey;
    }
    if (typeof baseUrl === "string" && baseUrl) {
      overrides.baseUrl = baseUrl;
    }
    if (typeof modelName === "string" && modelName) {
      overrides.modelName = modelName;
    }
    if (Object.keys(overrides).length === 0) {
      return rpcError(id, -32602, "未提供任何要修改的模型配置");
    }
    // 写入覆盖 → 清缓存,再重建图。agent 只在构造阶段读 settings,必须重建才能让新模型生效。
    setModelOverrides(overrides);
    graph.current = buildGraph();
    return rpcOk(id, getCurrentModelConfig());
  }

  // model.test:用给定(或当前)配置探一次连通性,让用户保存前确认 key/url 能通。
  if (body.method === "model.test") {
    const settings = getSettings();
    const rawApiKey = params.apiKey;
    const rawBaseUrl = params.baseUrl;
    const rawModelName = params.modelName;
    // 传了哪个就用哪个,没传/空则回退到当前生效配置。
    let apiKey = settings.apiKey;
    if (typeof rawApiKey === "string" && rawApiKey) {
      apiKey = rawApiKey;
    }
    let baseUrl = settings.baseUrl;
    if (typeof rawBaseUrl === "string" && rawBaseUrl) {
      baseUrl = rawBaseUrl;
    }
    let modelName = settings.modelName;
    if (typeof rawModelName === "string" && rawModelName) {
      modelName = rawModelName;
    }
    if (!apiKey || !baseUrl || !modelName) {
      return rpcOk(id, { ok: false, message: "apiKey / baseUrl / modelName 不完整,无法测试" });
    }
    // 探针模型:不重试、给超时,避免错误配置把请求挂死;thinking 关闭与正式 agent 保持一致。
    const probe = new ChatOpenAI({
      apiKey,
      configuration: { baseURL: baseUrl },
      model: modelName,
      maxTokens: 16,
      temperature: 0,
      maxRetries: 0,
      timeout: 15000,
      modelKwargs: { thinking: { type: "disabled" } },
    });
    try {
      await probe.invoke("ping");
      return rpcOk(id, { ok: true });
    } catch (exc) {
      return rpcOk(id, { ok: false, message: String(exc) });
    }
  }

  // 所有已知 method 都没匹配上 → 回 -32601(方法不存在)。
  return rpcError(id, -32601, `未知方法: ${body.method}`);
}
