/**
 * 跑一轮讨论并把过程推成 SSE：
 *   取会话历史 → 拼 userTurn → graph.stream(["custom","values"]) →
 *   custom 帧转发成 SSE 同名事件, values 末帧更新会话记忆 → round_done。
 */
import { ARCHITECT } from "../config/constants.js";
import type { AgentResponse } from "../agents/base.js";
import type { AgentState } from "../graph/state.js";
import type { NodeStreamChunk } from "../graph/streamEvents.js";
import type { buildGraph } from "../graph/builder.js";
import * as sseServer from "./sseServer.js";
import * as chatStore from "../database/chat/chatStore.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("server.runDiscussion");

type CompiledGraph = ReturnType<typeof buildGraph>;

export async function runDiscussion(
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

  // 整个函数体都在 try 里:任何异常(含读 DB)都转成 SSE error,绝不让 Promise reject 逃逸。
  try {
    // 取该会话已有发言(从 DB)作为跨轮记忆起点(首轮为空)
    const priorMessages = await chatStore.getMessages(sessionId);
    const seedMessages = [...priorMessages, userTurn];

    const initialState: AgentState = {
      requirement,
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
      logger.info(`[runDiscussion] 会话 ${sessionId} 被用户打断,本轮不落库`);
      sseServer.send(sessionId, "round_done", { done: false, interrupted: true });
      return;
    }

    // 本轮新增的 turn = 最终 messages 超出 seed(=prior+userTurn 之前的 prior)的尾部,
    // 即 userTurn + 各 agent 回复;增量落库,不重写整段。
    const finalMessages = finalState.messages ?? seedMessages;
    const newTurns = finalMessages.slice(priorMessages.length);
    await chatStore.appendMessages(sessionId, newTurns);
    sseServer.send(sessionId, "round_done", { done: finalState.done ?? false });
  } catch (exc) {
    // abort 会让 graph.stream 抛错:这是预期的打断,不当成错误,丢弃本轮、发 round_done。
    if (signal?.aborted) {
      logger.info(`[runDiscussion] 会话 ${sessionId} 被用户打断(stream 抛出),本轮不落库`);
      sseServer.send(sessionId, "round_done", { done: false, interrupted: true });
      return;
    }
    logger.error(`[runDiscussion] 会话 ${sessionId} 出错: ${String(exc)}`);
    sseServer.send(sessionId, "error", { message: String(exc) });
  }
}
