import { randomUUID } from "node:crypto";
import { Annotation, END, START, StateGraph, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { z } from "zod";
import { TwinAgent } from "../agents/twinAgent.js";
import { createMeetingModel } from "../agents/meetingModel.js";
import { ASSISTANT_INTENTS } from "../config/constants.js";
import { getSettings } from "../config/settings.js";
import { type MeetingRound, type RoundMode, type TaskStep, hasDirectReply, saveBoundary, savePlan, saveReply } from "../database/chat/meetingStore.js";
import type { Twin } from "../database/users/twins.js";
import { createIntentNode, matchChitchatRule } from "./preprocess/intentNode.js";
import { createRewriteNode } from "./preprocess/rewriteNode.js";
import { AgentStateAnnotation } from "./state.js";
import { cleanBadChars } from "../utils/utils.js";
import { buildAllAgents } from "./builder.js";

// 用规则识别明确的全员指令、协作任务或寒暄。返回 null 时交给后续分类流程。
export function classifyMeetingRule(requirement: string): RoundMode | null {
  if (/(每个人|每一位|全员|所有[人参]|都来|each (?:person|participant)|everyone)/i.test(requirement)) return "everyone";
  if (/(分析|评审|检查|设计|实现|修改|整理|开发|测试)(?:一下|一下这个|这个|你们的|当前|现有|下|一下当前)?[^\n]{0,8}(项目|系统|代码|接口|功能|方案)|分工|协作|分步骤|一起讨论/.test(requirement)) return "task";
  const greeting = requirement.trim();
  if (matchChitchatRule(greeting) || /^(?:你好|您好)?[\s，,。]*(?:你是谁|你叫什么(?:名字)?|请介绍一下自己)[。！!？?\s]*$/.test(greeting)) return "direct";
  return null;
}

// 已完成步数同时是下一项的下标，计划用尽时结束本轮。
export function teamRouter(steps: TaskStep[], completedSteps: number): string {
  const step = steps[completedSteps];
  return step ? `${step.agentName}_node` : END;
}

const MeetingStateAnnotation = Annotation.Root({
  ...AgentStateAnnotation.spec,
  mode: Annotation<RoundMode>(),
  steps: Annotation<TaskStep[]>(),
  completed_steps: Annotation<number>(),
});

type MeetingState = typeof MeetingStateAnnotation.State;
type MeetingNode = (state: MeetingState, config: LangGraphRunnableConfig) => Promise<Partial<MeetingState>>;

type Emit = (event: string, data: Record<string, unknown>, hostOnly?: boolean) => void;
type RequestApproval = (approvalId: string, signal?: AbortSignal) => Promise<boolean>;

// 每轮按参会名单构建图。新轮次先决定怎么答，再按需生成计划并逐步执行。
export function buildMeetingGraph(
  round: MeetingRound, twins: Twin[], emit: Emit, requestApproval: RequestApproval,
) {
  const host = twins[0];
  const seedAgents = twins.some((twin) => twin.is_seed) ? buildAllAgents() : {};
  const agents: TwinAgent[] = [];
  const nodes: string[] = [END];
  for (const twin of twins) {
    const rolePrompt = seedAgents[twin.agent_key]?.systemPrompt ?? "";
    agents.push(new TwinAgent(twin, rolePrompt, host.username));
    nodes.push(`${twin.agent_key}_node`);
  }
  const rewriteNode = createRewriteNode();
  const intentNode = createIntentNode();
  const model = createMeetingModel(0);
  const classify = model.withStructuredOutput(z.object({ mode: z.enum(["direct", "task", "everyone"]) }), {
    name: "MeetingBoundary",
  });
  const maximumSteps = Math.max(getSettings().maxIterations, twins.length);
  const planSchema = z.object({
    title: z.string().trim().min(1).max(200),
    steps: z.array(z.object({ agentName: z.string(), instruction: z.string().trim().min(1).max(3000) })).min(1).max(maximumSteps),
  });
  const planner = model.withStructuredOutput(planSchema, { name: "MeetingPlan" });
  const directSteps = [{
    agentName: host.agent_key,
    instruction: "直接回答主持人当前的问题，保持简洁。",
  }];

  const graph = new StateGraph(MeetingStateAnnotation) as unknown as {
    addNode: (name: string, node: MeetingNode) => void;
    addEdge: (from: string, to: string) => void;
    addConditionalEdges: (from: string, router: (state: MeetingState) => string, pathMap: string[]) => void;
    compile: () => ReturnType<StateGraph<typeof MeetingStateAnnotation.spec>["compile"]>;
  };

  // 恢复时从轮次记录复用已落库的改写结果和意图。
  graph.addNode("rewrite_node", async (state, config) => {
    if (round.mode) return { rewritten_query: round.rewritten_query, expansion_terms: round.expansion_terms };
    return rewriteNode(state, config);
  });
  graph.addNode("intent_node", async (state) => {
    if (round.mode) return { intent: round.intent };
    const known = classifyMeetingRule(state.requirement) ?? classifyMeetingRule(state.rewritten_query || "");
    if (known) return { intent: known === "direct" ? "闲聊" : "任务指令", intent_margin: 1 };
    return intentNode(state);
  });
  graph.addNode("task_boundary_node", async (state, config) => {
    const query = state.rewritten_query || state.requirement;
    let mode = round.mode ?? classifyMeetingRule(state.requirement) ?? classifyMeetingRule(query);
    // 高置信度的任务意图可直接走协作流程，其余未决情况交给模型划分模式。
    if (!mode && state.intent && state.intent_margin >= getSettings().intentRouteMargin && !ASSISTANT_INTENTS.includes(state.intent)) {
      mode = "task";
    }
    if (!mode) {
      const text = cleanBadChars(cleanMeetingQuery(query, state.intent));
      const result = await classify.invoke([
        ["system", "按实际需求分类。寒暄、自我介绍、一个答复可解决的知识问答选 direct。要求执行、分析、多人协作或多个步骤选 task。明确要求每个人执行选 everyone。不要执行需求。"],
        ["human", text],
      ], { signal: config.signal });
      mode = result.mode;
    }
    if (!round.mode) {
      await saveBoundary(round.id, mode, query, state.expansion_terms, state.intent);
      emit("plan_updated", { roundId: round.id });
    }
    // 直接答复没有计划表记录，通过已落库的发言判断是否需要继续。
    if (mode === "direct") {
      const alreadyReplied = await hasDirectReply(round.id);
      return { mode, steps: directSteps, completed_steps: alreadyReplied ? 1 : 0 };
    }
    return { mode };
  });

  graph.addNode("task_plan_node", async (state, config) => {
    if (round.plan) return { steps: round.plan.steps, completed_steps: round.completed_steps };
    const query = state.rewritten_query || state.requirement;
    const literal = /^(?:请)?(?:每个人|全员|所有人)\s*说(?:出)?(?:一个)?\s*([0-9]+)[。！!\s]*$/.exec(state.requirement);
    if (literal && state.mode === "everyone") {
      const steps: TaskStep[] = [];
      for (const twin of twins) {
        steps.push({
          agentName: twin.agent_key,
          displayName: twin.display_name,
          instruction: `只回复数字 ${literal[1]}，无需其他文字。`,
        });
      }
      await savePlan(round, { title: state.requirement, steps });
      emit("plan_updated", { roundId: round.id });
      return { steps, completed_steps: 0 };
    }

    // 规划器使用参会人的标识和简介来分工。返回的标识随后与实际名单核对。
    const identities = new Map(twins.map((twin) => [twin.agent_key, twin]));
    const roster = twins.map((twin) => ({
      agentName: twin.agent_key,
      displayName: twin.display_name,
      introduction: twin.persona,
      host: twin === host,
    }));
    const instruction = state.mode === "everyone"
      ? "按所给名单为每个人各安排一步，包含主持人的数字人，保留明确的发言顺序。"
      : "按执行顺序安排子任务，尊重用户的点名和顺序。只分配需要参与的人。";
    const rosterText = JSON.stringify(roster);
    const planInput = cleanBadChars(`参会名单：${rosterText}\n需求：${query}`);
    const plan = await planner.invoke([
      ["system", `只规划会议工作，不直接回答。${instruction} 使用名单中的 agentName。每个 instruction 只描述该成员的一项操作。除非用户明确要求，不安排开场、总结、让别人发言等额外操作。`],
      ["human", planInput],
    ], { signal: config.signal });

    const steps: TaskStep[] = [];
    for (const step of plan.steps) {
      const twin = identities.get(step.agentName);
      if (!twin) throw new Error("任务计划指定了未参会的数字人");
      if (state.mode === "everyone" && steps.some((entry) => entry.agentName === step.agentName)) continue;
      steps.push({ ...step, displayName: twin.display_name });
    }
    // 全员模式补齐计划中遗漏的成员。上一步已去除同一成员的重复分配。
    if (state.mode === "everyone") {
      for (const twin of twins) {
        if (steps.some((entry) => entry.agentName === twin.agent_key)) continue;
        steps.push({
          agentName: twin.agent_key, displayName: twin.display_name,
          instruction: `作为一名成员执行一次全员指令：${state.rewritten_query || state.requirement}`,
        });
      }
    }

    await savePlan(round, { title: plan.title, steps });
    emit("plan_updated", { roundId: round.id });
    return { steps, completed_steps: 0 };
  });

  const next = (state: MeetingState) => teamRouter(state.steps, state.completed_steps);
  graph.addEdge(START, "rewrite_node");
  graph.addEdge("rewrite_node", "intent_node");
  graph.addEdge("intent_node", "task_boundary_node");
  graph.addConditionalEdges("task_boundary_node", (state) => state.mode === "direct" ? next(state) : "task_plan_node", [
    ...nodes, "task_plan_node",
  ]);
  graph.addConditionalEdges("task_plan_node", next, nodes);

  for (const agent of agents) {
    const twin = agent.twin;
    const name = `${twin.agent_key}_node`;
    graph.addNode(name, async (state, config) => {
      const index = state.completed_steps;
      const turnId = `${round.id}-${index + 1}`;
      const payload = { turnId, agent_name: twin.agent_key, role: twin.display_name };
      emit("turn_start", payload);

      const tools = new Set<string>();
      const history: string[] = [];
      const recent = state.messages.slice(-24);
      for (const message of recent) history.push(`${message.role}：${message.message}`);

      const reply = await agent.reply(
        state.rewritten_query || state.requirement, state.steps[index].instruction, history.join("\n"),
        {
          signal: config.signal,
          expansionTerms: state.expansion_terms,
          onToolUse(tool) {
            tools.add(tool);
            emit("using_tools", { turnId, tool });
          },
          async onToolApproval(info) {
            const approvalId = randomUUID();
            const pending = requestApproval(approvalId, config.signal);
            emit("tool_approval_request", { turnId, approvalId, tool: info.toolName, risk: info.risk }, true);
            return await pending;
          },
        },
        (text) => emit("delta", { turnId, text }),
      );
      // 完整发言与步骤进度落库后，再发送结束事件并推进图状态。
      config.signal?.throwIfAborted();
      await saveReply(round, index, twin.agent_key, twin.display_name, reply, Array.from(tools));
      const nextAgent = state.steps[index + 1]?.agentName ?? null;
      const finished = nextAgent === null;
      emit("turn_end", { turnId, next_agent: nextAgent, done: finished, used_rag: tools.has("rag_search") });
      if (state.mode !== "direct") emit("plan_updated", { roundId: round.id });
      return {
        completed_steps: index + 1,
        messages: [{
          agent_name: twin.agent_key, role: twin.display_name, message: reply, done: finished,
          next_agent: nextAgent, used_rag: tools.has("rag_search"),
        }],
      };
    });
    graph.addConditionalEdges(name, next, nodes);
  }

  // 续跑由会议轮次表和计划表提供进度，重建图后从下一个未完成步骤执行。
  return graph.compile();
}

function cleanMeetingQuery(query: string, intent: string): string {
  return `意图参考：${intent || "未知"}\n需求：${query}`;
}

