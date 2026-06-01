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
import * as sse from "./sse.js";
import * as chatStore from "../database/chatStore.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger("server.runDiscussion");

type CompiledGraph = ReturnType<typeof buildGraph>;

export async function runDiscussion(
  graph: CompiledGraph,
  sessionId: string,
  requirement: string,
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
    const stream = await graph.stream(initialState, {
      recursionLimit: 50,
      streamMode: ["custom", "values"],
    });

    for await (const item of stream) {
      const [mode, chunk] = item as [string, unknown];
      if (mode === "custom") {
        const event = chunk as NodeStreamChunk;
        sse.send(sessionId, event.kind, event);
      } else {
        finalState = chunk as AgentState;
      }
    }

    // 本轮新增的 turn = 最终 messages 超出 seed(=prior+userTurn 之前的 prior)的尾部,
    // 即 userTurn + 各 agent 回复;增量落库,不重写整段。
    const finalMessages = finalState.messages ?? seedMessages;
    const newTurns = finalMessages.slice(priorMessages.length);
    await chatStore.appendMessages(sessionId, newTurns);
    sse.send(sessionId, "round_done", { done: finalState.done ?? false });
  } catch (exc) {
    logger.error(`[runDiscussion] 会话 ${sessionId} 出错: ${String(exc)}`);
    sse.send(sessionId, "error", { message: String(exc) });
  }
}
