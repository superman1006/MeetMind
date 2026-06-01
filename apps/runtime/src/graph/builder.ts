/**
 * 构建多 Agent LangGraph。
 *
 * 拓扑：
 *     START → architect_node
 *     每个 agent_node → 条件边 → 下一 agent 或 END
 *
 * 路由由 `state.next_agent` 驱动，每轮由 agent 的结构化输出填充。
 */

import { END, START, StateGraph } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";

import { ArchitectAgent } from "../agents/architect.js";
import type { AgentResponse, BaseAgent } from "../agents/base.js";
import { BackendAgent } from "../agents/backend.js";
import { FrontendAgent } from "../agents/frontend.js";
import { PMAgent } from "../agents/pm.js";
import { TesterAgent } from "../agents/tester.js";
import {
  AGENT_NAMES,
  ARCHITECT,
  BACKEND,
  FRONTEND,
  PM,
  TESTER,
} from "../config/constants.js";
import { printAgentInfo } from "../utils/utils.js";
import { getLogger } from "../utils/logger.js";
import { routeToWhichAgent } from "./route.js";
import {
  AgentStateAnnotation,
  type AgentState,
} from "./state.js";

const logger = getLogger("graph.builder");

/** 一次性 new 出 5 个角色 Agent 实例，返回 name → Agent 的字典。 */
function buildAllAgents(): Record<string, BaseAgent> {
  return {
    [ARCHITECT]: new ArchitectAgent(),
    [BACKEND]: new BackendAgent(),
    [FRONTEND]: new FrontendAgent(),
    [TESTER]: new TesterAgent(),
    [PM]: new PMAgent(),
  };
}

/** 把 messages 数组拼成 "--- agent (role) ---\n正文" 风格的纯文本，用作下一个 Agent 的 history 上下文。 */
function formatHistory(messages: AgentResponse[]): string {
  if (messages.length === 0) {
    return "";
  }
  const chunks: string[] = [];
  for (const m of messages) {
    chunks.push(`--- ${m.agent_name} (${m.role}) ---\n${m.message}`);
  }
  return chunks.join("\n\n");
}

/** 把一个 BaseAgent 包成 LangGraph 节点函数：读 state → 发 turn_start → 调 agent.invoke(流式) → 发 turn_end → 返回增量 state。 */
function createNode(agent: BaseAgent) {
  return async (
    state: AgentState,
    config: LangGraphRunnableConfig,
  ): Promise<Partial<AgentState>> => {
    const requirement = state.requirement ?? "";
    const history = formatHistory(state.messages ?? []); // 历史发言拼成文本喂给 agent
    const iteration = (state.iteration ?? 0) + 1; // 轮次 +1，供安全阀判断
    const turnId = `${agent.name}-${iteration}`;

    logger.info(`[graph] iteration=${iteration}  →  invoking ${agent.name}_node`);

    // 有 writer(服务端流式)才发事件 + 传 onDelta；无 writer(CLI)则保持原非流式行为
    const writer = config.writer;
    if (writer) {
      writer({ kind: "turn_start", turnId, agent_name: agent.name, role: agent.role });
    }

    let onDelta: ((text: string) => void) | undefined = undefined;
    let onToolUse: ((toolName: string) => void) | undefined = undefined;
    const toolsUsed: string[] = []; // 本轮用过的工具名(去重),用于落库 + 前端常驻标签
    if (writer) {
      onDelta = (text: string) => {
        writer({ kind: "delta", turnId, text });
      };
      onToolUse = (toolName: string) => {
        writer({ kind: "using_tools", turnId, tool: toolName });
        if (!toolsUsed.includes(toolName)) {
          toolsUsed.push(toolName);
        }
      };
    }

    let response;
    if (onDelta) {
      response = await agent.invoke(requirement, history, { onDelta, onToolUse });
    } else {
      response = await agent.invoke(requirement, history);
    }

    // 把本轮用过的工具名挂到 response,随消息落库;前端据此常驻 "UsingTools: <工具名>"
    if (toolsUsed.length > 0) {
      response.tool = toolsUsed.join(", ");
    }

    printAgentInfo({
      agentName: response.agent_name,
      message: response.message,
      nextRole: response.done ? "DONE" : response.next_agent,
      usedRag: response.used_rag,
    });

    if (writer) {
      writer({
        kind: "turn_end",
        turnId,
        next_agent: response.next_agent,
        done: response.done,
        used_rag: response.used_rag,
      });
    }

    // 只回增量：messages 追加（整条 AgentResponse 直接进历史），其余字段覆盖进 State
    return {
      messages: [response],
      next_agent: response.next_agent,
      done: response.done,
      iteration,
    };
  };
}

/**
 * 编译并返回多 Agent 图。
 */
export function buildGraph() {
  const agents = buildAllAgents();
  // LangGraph JS 用字面量收 node name 泛型；循环动态加节点时 TS 推不出来。
  // 这里把 graph 当 any 处理，运行时行为不变。
  const graph = new StateGraph(AgentStateAnnotation) as unknown as {
    addNode: (name: string, fn: ReturnType<typeof createNode>) => void;
    addEdge: (from: string, to: string) => void;
    addConditionalEdges: (
      from: string,
      router: typeof routeToWhichAgent,
      map: Record<string, string>,
    ) => void;
    compile: () => ReturnType<StateGraph<typeof AgentStateAnnotation.spec>["compile"]>;
  };

  // 1. 加节点
  for (const name of AGENT_NAMES) {
    const agent = agents[name];
    if (!agent) {
      throw new Error(`找不到 agent: ${name}`);
    }
    graph.addNode(`${name}_node`, createNode(agent));
  }

  // 2. 入口固定为架构师
  graph.addEdge(START, `${ARCHITECT}_node`);

  // 3. 条件边：routeMap 把 router 返回值映射到实际节点
  const routeMap: Record<string, string> = {};
  for (const name of AGENT_NAMES) {
    routeMap[`${name}_node`] = `${name}_node`;
  }
  routeMap[END] = END;

  for (const name of AGENT_NAMES) {
    graph.addConditionalEdges(`${name}_node`, routeToWhichAgent, routeMap);
  }

  const compiled = graph.compile();
  const nodeNames: string[] = [];
  for (const n of AGENT_NAMES) {
    nodeNames.push(`${n}_node`);
  }
  logger.info(`LangGraph compiled: ${nodeNames.join(", ")}`);
  return compiled;
}
