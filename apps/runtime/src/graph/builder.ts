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
import type { AgentResponse, BaseAgent, ToolCallRecord } from "../agents/base.js";
import { AssistantAgent } from "../agents/assistant.js";
import { BackendAgent } from "../agents/backend.js";
import { FrontendAgent } from "../agents/frontend.js";
import { PMAgent } from "../agents/pm.js";
import { TesterAgent } from "../agents/tester.js";
import {
  AGENT_NAMES,
  ARCHITECT,
  ASSISTANT,
  BACKEND,
  FRONTEND,
  PM,
  TESTER,
} from "../config/constants.js";
import { printAgentInfo } from "../utils/utils.js";
import { getLogger } from "../utils/logger.js";
import * as toolApprovals from "../server/toolApprovals.js";
import { createIntentNode } from "./preprocess/intentNode.js";
import { createRewriteNode } from "./preprocess/rewriteNode.js";
import { createRouteNode } from "./preprocess/routeNode.js";
import { routeAfterPreprocess, routeToWhichAgent } from "./route.js";
import { getCheckpointer } from "./checkpointer.js";
import {
  AgentStateAnnotation,
  type AgentState,
} from "./state.js";

const logger = getLogger("graph.builder");

/** 一次性 new 出 5 个角色 Agent 实例，返回 name → Agent 的字典。 */
export function buildAllAgents(): Record<string, BaseAgent> {
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
    // 喂给 agent 的是 rewrite_node 改写后的独立句（指代已消解）；为空兜底回原始输入。
    // 注意只影响 LLM 读到的内容；展示 / 落库用的「用户原话」是另一条 user message，不受这里影响。
    const requirement = state.rewritten_query || state.requirement || "";
    // 检索扩展词（rewrite_node 产出）：经 config 透传给 rag_search 拼到 query 后面，仅用于召回
    const expansionTerms = state.expansion_terms ?? "";
    // 意图标签（intent_node 产出）：透传进 _userPrompt 当一句参考提示
    const intent = state.intent ?? "";
    const history = formatHistory(state.messages ?? []); // 历史发言拼成文本喂给 agent
    const iteration = (state.iteration ?? 0) + 1; // 轮次 +1，供安全阀判断
    const turnId = `${agent.name}-${iteration}`;

    logger.info(`[graph] iteration=${iteration}  →  invoking ${agent.name}_node`);

    // 有 writer(服务端流式)才发事件 + 传 onDelta；无 writer(CLI)则保持原非流式行为
    const writer = config.writer;
    if (writer) {
      writer({ kind: "turn_start", turnId, agent_name: agent.name, role: agent.role });
    }

    // onDelta:每当 Phase 2 结构化收尾时，content 又多出一小段字，就调一次这个回调，把「新增的那截」传出去
    let onDelta: ((text: string) => void) | undefined = undefined;
    // onToolUse:在 Phase 1 真正执行某个工具之前调一次，参数是工具名（如 rag_search、web_search）。
    let onToolUse: ((toolName: string) => void) | undefined = undefined;
    // onToolResult:每次工具执行完成后调一次，带 name/args/result，转发成 tool_result 事件供前端加按钮 + 展开结果。
    let onToolResult: ((rec: ToolCallRecord) => void) | undefined = undefined;
    // onToolApproval:risk>low 的工具执行前调一次，发 tool_approval_request 事件并 await 用户决策。
    let onToolApproval:
      | ((info: { toolName: string; risk: string; args: Record<string, unknown> }) => Promise<boolean>)
      | undefined = undefined;
    const toolsUsed: string[] = []; // 本轮用过的工具名(去重),用于落库 + 前端常驻标签
    let approvalSeq = 0; // 本轮（本节点）审批编号自增计数器，拼出一轮内唯一的 approvalId
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
      onToolResult = (rec: ToolCallRecord) => {
        writer({
          kind: "tool_result",
          turnId,
          name: rec.name,
          args: rec.args,
          result: rec.result,
        });
      };
      onToolApproval = async (info) => {
        const approvalId = `${turnId}-${approvalSeq}`;
        approvalSeq += 1;
        // 先推事件让前端弹审批框，再挂起等用户决策（打断会经 config.signal 取消挂起）。
        writer({
          kind: "tool_approval_request",
          turnId,
          approvalId,
          tool: info.toolName,
          risk: info.risk,
          args: info.args,
        });
        const approved = await toolApprovals.createPending(approvalId, config.signal);
        return approved;
      };
    }

    // 会话主人的个人记忆：本轮开始时已加载进 state，节点这里读出透传给 agent，
    // 由 invoke 拼到 systemPrompt 最前面。CLI / 未登录场景为空串。
    const userMemory = state.userMemory ?? "";

    let response;
    if (onDelta) {
      response = await agent.invoke(requirement, history, {
        userMemory,
        intent,
        expansionTerms,
        onDelta,
        onToolUse,
        onToolResult,
        onToolApproval,
      });
    } else {
      response = await agent.invoke(requirement, history, {
        userMemory,
        intent,
        expansionTerms,
      });
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
 * 把「回答助手」包成 LangGraph 节点（右侧单节点工作流）。
 * 流式 plumbing 与 createNode 一致（turn_start / delta / using_tools / tool_result / tool_approval / turn_end），
 * 但调的是 assistant.answer()（纯文本流式、不结构化）。刻意【不碰 iteration / next_agent】——
 * 右侧与左侧团队隔离，答完只追加这条消息 + 标记 done，由图直接 → END。
 */
function createAssistantNode() {
  const assistant = new AssistantAgent();
  return async (
    state: AgentState,
    config: LangGraphRunnableConfig,
  ): Promise<Partial<AgentState>> => {
    // 喂给助手的是改写后的独立句；为空兜底回原始输入
    const requirement = state.rewritten_query || state.requirement || "";
    const expansionTerms = state.expansion_terms ?? "";
    const history = formatHistory(state.messages ?? []);
    const userMemory = state.userMemory ?? "";
    const turnId = `${ASSISTANT}-1`; // 单节点工作流，本轮只发言一次

    logger.info(`[graph] → invoking ${ASSISTANT}_node（右侧回答助手）`);

    const writer = config.writer;
    if (writer) {
      writer({ kind: "turn_start", turnId, agent_name: assistant.name, role: assistant.role });
    }

    // 与 createNode 同形态的回调（有 writer 才发流式事件；CLI 无 writer 走非流式）
    let onDelta: ((text: string) => void) | undefined = undefined;
    let onToolUse: ((toolName: string) => void) | undefined = undefined;
    let onToolResult: ((rec: ToolCallRecord) => void) | undefined = undefined;
    let onToolApproval:
      | ((info: { toolName: string; risk: string; args: Record<string, unknown> }) => Promise<boolean>)
      | undefined = undefined;
    const toolsUsed: string[] = [];
    let approvalSeq = 0;
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
      onToolResult = (rec: ToolCallRecord) => {
        writer({ kind: "tool_result", turnId, name: rec.name, args: rec.args, result: rec.result });
      };
      onToolApproval = async (info) => {
        const approvalId = `${turnId}-${approvalSeq}`;
        approvalSeq += 1;
        writer({
          kind: "tool_approval_request",
          turnId,
          approvalId,
          tool: info.toolName,
          risk: info.risk,
          args: info.args,
        });
        const approved = await toolApprovals.createPending(approvalId, config.signal);
        return approved;
      };
    }

    let response;
    if (onDelta) {
      response = await assistant.answer(requirement, history, {
        userMemory,
        expansionTerms,
        onDelta,
        onToolUse,
        onToolResult,
        onToolApproval,
      });
    } else {
      response = await assistant.answer(requirement, history, { userMemory, expansionTerms });
    }

    if (toolsUsed.length > 0) {
      response.tool = toolsUsed.join(", ");
    }

    printAgentInfo({
      agentName: response.agent_name,
      message: response.message,
      nextRole: "DONE",
      usedRag: response.used_rag,
    });

    if (writer) {
      writer({ kind: "turn_end", turnId, next_agent: null, done: true, used_rag: response.used_rag });
    }

    // 右侧工作流：只追加这条消息 + 标记本轮完成；绝不碰 iteration（与左侧团队隔离）。
    return { messages: [response], done: true };
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
    compile: (options?: { checkpointer?: unknown }) => ReturnType<StateGraph<typeof AgentStateAnnotation.spec>["compile"]>;
  };

  // 1. 加节点
  for (const name of AGENT_NAMES) {
    const agent = agents[name];
    if (!agent) {
      throw new Error(`找不到 agent: ${name}`);
    }
    graph.addNode(`${name}_node`, createNode(agent));
  }

  // 1.5 预处理流水线：rewrite_node（改写 + 扩展）→ intent_node（意图识别）→ route_node（分流决策）。
  // 三者每轮只在入口跑一次，不参与 agent 间路由、不计入 iteration（只返回各自字段）。
  graph.addNode("rewrite_node", createRewriteNode());
  graph.addNode("intent_node", createIntentNode());
  graph.addNode("route_node", createRouteNode());

  // 1.6 右侧「回答助手」单节点工作流（与左侧团队隔离，只共享 AgentState + 同一批工具）。
  graph.addNode(`${ASSISTANT}_node`, createAssistantNode());

  // 2. 入口：START → 改写 → 意图 → 分流；route_node 后按 state.route 走「助手」或「架构师全团队」。
  graph.addEdge(START, "rewrite_node");
  graph.addEdge("rewrite_node", "intent_node");
  graph.addEdge("intent_node", "route_node");
  graph.addConditionalEdges("route_node", routeAfterPreprocess, {
    [`${ASSISTANT}_node`]: `${ASSISTANT}_node`,
    [`${ARCHITECT}_node`]: `${ARCHITECT}_node`,
  });
  // 助手答完即结束，不进协作循环
  graph.addEdge(`${ASSISTANT}_node`, END);

  // 3. 条件边：routeMap 把 router 返回值映射到实际节点
  const routeMap: Record<string, string> = {};
  for (const name of AGENT_NAMES) {
    routeMap[`${name}_node`] = `${name}_node`;
  }
  routeMap[END] = END;

  for (const name of AGENT_NAMES) {
    graph.addConditionalEdges(`${name}_node`, routeToWhichAgent, routeMap);
  }

  const compiled = graph.compile({ checkpointer: getCheckpointer() });
  const nodeNames: string[] = [];
  for (const n of AGENT_NAMES) {
    nodeNames.push(`${n}_node`);
  }
  logger.info(`LangGraph compiled: ${nodeNames.join(", ")}`);
  return compiled;
}
