/**
 * 跑一轮讨论并把过程推成 SSE：
 *   取会话历史 → 拼 userTurn → graph.stream(["custom","values"]) →
 *   custom 帧转发成 SSE 同名事件, values 末帧更新会话记忆 → round_done。
 */
import { randomUUID } from "node:crypto";
import { ARCHITECT } from "../config/constants.js";
import type { AgentResponse } from "../agents/base.js";
import type { AgentState } from "../graph/state.js";
import type { NodeStreamChunk } from "../graph/streamEvents.js";
import type { buildGraph } from "../graph/builder.js";
import * as sseServer from "./sseServer.js";
import * as chatStore from "../database/chat/chatStore.js";
import * as userStore from "../database/users/userStore.js";
import { getLogger } from "../utils/logger.js";
import { deleteThreadCheckpoints } from "../graph/checkpointer.js";

const logger = getLogger("server.runExecution");

type CompiledGraph = ReturnType<typeof buildGraph>;

export async function runExecution(
  graph: CompiledGraph,
  sessionId: string,
  requirement: string,
  signal?: AbortSignal,
): Promise<void> {
  // 把本轮用户输入记进历史(agent_name=user),复刻 CLI 的做法
  const userTurn: AgentResponse = {
    agent_name: "user",
    role: "用户",
    message: requirement,
    next_agent: ARCHITECT,
    done: false,
    used_rag: false,
  };

  // 本轮唯一 thread_id；清理闭包供「完成 / 停止 / 出错」三处复用（崩溃则都不跑→标记残留）。
  const roundId = randomUUID();
  const threadId = `${sessionId}:${roundId}`;
  async function cleanupRound(): Promise<void> {
    await chatStore.clearPendingThread(sessionId);
    await deleteThreadCheckpoints(threadId);
  }

  // 整个函数体都在 try 里:任何异常(含读 DB)都转成 SSE error,绝不让 Promise reject 逃逸。
  try {
    // 轮开始即登记在途 thread_id：崩溃时该标记残留 = 可恢复信号。
    await chatStore.setPendingThread(sessionId, threadId);

    // 取该会话「喂 LLM 的上下文」作为跨轮记忆起点：压过缩则是「摘要 + 边界后尾部」，没压过则是全量(首轮为空)。
    // 注意：这里刻意不用 getMessages（那是给前端展示的全量）——LLM 历史走压缩后的读路径，控制上下文长度。
    const priorMessages = await chatStore.getContextMessages(sessionId);
    const seedMessages = [...priorMessages, userTurn];

    // 按会话主人(owner=用户名)加载其个人记忆，本轮整轮共用，拼到各 agent 的 systemPrompt 最前面。
    // 取不到 owner / 没写过记忆都回空串，memorySection 据此不加任何内容。
    const owner = await chatStore.getSessionOwner(sessionId);
    let userMemory = "";
    if (owner) {
      userMemory = await userStore.getMemory(owner);
    }

    const initialState: AgentState = {
      requirement,
      // 预处理节点（rewrite_node / intent_node / route_node）入口跑时会填，这里给空初值
      rewritten_query: "",
      expansion_terms: "",
      intent: "",
      intent_score: 0,
      route: "",
      userMemory,
      messages: seedMessages,
      next_agent: null,
      done: false,
      iteration: 0,
    };

    let finalState: AgentState = initialState;
    // signal 透传给 graph.stream:chat.interrupt abort() 后,LLM 请求 + 图迭代会被中止。
    const stream = await graph.stream(initialState, {
      recursionLimit: 50,
      streamMode: ["custom", "values"],
      signal,
      configurable: { thread_id: threadId },
    });


    // 拿到 graph 的输出后用 sseServer.send 转发成 SSE 事件推给前端
    for await (const item of stream) {
      const [mode, chunk] = item as [string, unknown];
      if (mode === "custom") {
        const event = chunk as NodeStreamChunk;
        // 通过 sse 的 ServerResponse 对象把事件推给前端;事件类型就是 event.kind,事件数据就是整个 event 对象(前端 JSON.parse 后读 event.kind 路由到对应 handler,其余字段照旧)。
        sseServer.send(sessionId, event.kind, event);
      } else {
        finalState = chunk as AgentState;
      }
    }

    // 被打断:丢弃本轮(不落库,保留上一轮记忆),发 round_done 让前端恢复输入。
    if (signal?.aborted) {
      logger.info(`[runExecution] 会话 ${sessionId} 被用户打断,本轮不落库`);
      await cleanupRound();
      sseServer.send(sessionId, "round_done", { done: false, interrupted: true });
      return;
    }

    // 本轮新增的 turn = 最终 messages 超出 seed(=prior+userTurn 之前的 prior)的尾部,
    // 即 userTurn + 各 agent 回复;增量落库,不重写整段。
    const finalMessages = finalState.messages ?? seedMessages;
    const newTurns = finalMessages.slice(priorMessages.length);
    await chatStore.appendMessages(sessionId, newTurns);
    await cleanupRound();
    sseServer.send(sessionId, "round_done", { done: finalState.done ?? false });
  } catch (exc) {
    // abort 会让 graph.stream 抛错:这是预期的打断,不当成错误,丢弃本轮、发 round_done。
    if (signal?.aborted) {
      logger.info(`[runExecution] 会话 ${sessionId} 被用户打断(stream 抛出),本轮不落库`);
      await cleanupRound();
      sseServer.send(sessionId, "round_done", { done: false, interrupted: true });
      return;
    }
    logger.error(`[runExecution] 会话 ${sessionId} 出错: ${String(exc)}`);
    await cleanupRound();
    sseServer.send(sessionId, "error", { message: String(exc) });
  }
}

/**
 * 从崩溃残留的 checkpoint 续跑某会话的未完成轮：
 *   读 pending thread_id → graph.stream(null, {thread_id}) 从最后一个节点续 →
 *   SSE 复用既有事件 → 增量落库 → 清标记 / 删 checkpoint → round_done。
 */
export async function resumeExecution(
  graph: CompiledGraph,
  sessionId: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const threadId = await chatStore.getPendingThread(sessionId);
    if (!threadId) {
      // 没有可恢复轮：直接发 round_done 让前端复位。
      sseServer.send(sessionId, "round_done", { done: false });
      return;
    }
    // 崩溃轮从未落库，且恢复发生在重启时（其间无新消息 / 无新压缩），
    // 故当前「上下文消息条数」== 该轮 seed 时的基线（与 runExecution 的 seed 路径一致，含合成摘要那一条）。
    const priorMessages = await chatStore.getContextMessages(sessionId);
    const priorCount = priorMessages.length;

    let finalState: AgentState | null = null;
    // 传 null 输入 = 从最后一个 checkpoint 续跑；只重跑崩溃时未完成的节点及其后续。
    const stream = await graph.stream(null as unknown as Parameters<typeof graph.stream>[0], {
      recursionLimit: 50,
      streamMode: ["custom", "values"],
      signal,
      configurable: { thread_id: threadId },
    });
    for await (const item of stream) {
      const [mode, chunk] = item as [string, unknown];
      if (mode === "custom") {
        const event = chunk as NodeStreamChunk;
        sseServer.send(sessionId, event.kind, event);
      } else {
        finalState = chunk as AgentState;
      }
    }

    // 恢复中被打断：丢弃这次恢复，清标记不再续。
    if (signal?.aborted) {
      logger.info(`[resumeExecution] 会话 ${sessionId} 恢复中被打断`);
      await chatStore.clearPendingThread(sessionId);
      await deleteThreadCheckpoints(threadId);
      sseServer.send(sessionId, "round_done", { done: false, interrupted: true });
      return;
    }

    const finalMessages = finalState?.messages ?? priorMessages;
    const newTurns = finalMessages.slice(priorCount);
    await chatStore.appendMessages(sessionId, newTurns);
    await chatStore.clearPendingThread(sessionId);
    await deleteThreadCheckpoints(threadId);
    sseServer.send(sessionId, "round_done", { done: finalState?.done ?? false });
  } catch (exc) {
    if (signal?.aborted) {
      logger.info(`[resumeExecution] 会话 ${sessionId} 恢复中被打断(stream 抛出)`);
      const tid = await chatStore.getPendingThread(sessionId);
      await chatStore.clearPendingThread(sessionId);
      if (tid) {
        await deleteThreadCheckpoints(tid);
      }
      sseServer.send(sessionId, "round_done", { done: false, interrupted: true });
      return;
    }
    // 非打断的恢复错误：保留 pending 标记，允许用户再次点「继续」重试。
    logger.error(`[resumeExecution] 会话 ${sessionId} 恢复出错: ${String(exc)}`);
    sseServer.send(sessionId, "error", { message: String(exc) });
  }
}
