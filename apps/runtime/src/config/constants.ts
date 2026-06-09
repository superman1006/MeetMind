/**
 * MeetMind 应用级常量。
 * 字段名刻意用 snake_case（会序列化进 LangGraph state），统一不混 camelCase。
 */

export const ARCHITECT = "architect";
export const BACKEND = "backend";
export const FRONTEND = "frontend";
export const TESTER = "tester";
export const PM = "pm";

export const AGENT_NAMES = [ARCHITECT, BACKEND, FRONTEND, TESTER, PM] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export const NON_ARCHITECT_AGENTS = [BACKEND, FRONTEND, TESTER, PM] as const;

/**
 * 「回答助手」——右侧单节点工作流的角色名。
 * 刻意不放进 AGENT_NAMES：它不参与架构师那套多 agent 协作路由（isAgentName 也不会命中它），
 * 是一条独立的、用完即 END 的旁路工作流，只和左侧共享 AgentState + 同一批工具。
 */
export const ASSISTANT = "assistant";

export const ROLE_DESCRIPTIONS: Record<string, string> = {
  [ARCHITECT]: "架构师 (Architect / Tech Lead)",
  [BACKEND]: "后端工程师 (Backend Engineer)",
  [FRONTEND]: "前端工程师 (Frontend Engineer)",
  [TESTER]: "测试工程师 (QA Engineer)",
  [PM]: "产品经理 (Product Manager)",
};

/** 类型守卫：判断字符串是否是 5 个合法 agent 名（architect / backend / frontend / tester / pm）之一。 */
export function isAgentName(value: string): value is AgentName {
  return (AGENT_NAMES as readonly string[]).includes(value);
}

/**
 * intent_node 的候选意图标签（zero-shot 分类的候选集）。
 * 用简短、彼此区隔清晰的中文名词，便于 NLI 模型按「这条输入的意图是 {标签}」做蕴含判断
 * （标签越少、越不重叠，top-1 越稳）。精简成 4 个，两两分到「右侧助手 / 左侧团队」：
 *
 *   闲聊 / 知识问答  → 走「回答助手」单节点（普通对话、一问一答，不必惊动整个团队）
 *   开发需求 / 任务指令 → 走架构师全团队（要多角色协作设计 / 执行的软件工作）
 *
 * 这个标签同时承担两个用途：①给左侧各 agent 当一句弱参考提示；②给 route_node 做右侧分流的依据。
 */
export const INTENT_LABELS = [
  "闲聊", // 问候 / 寒暄 / 情绪 / 与项目无关的对话
  "知识问答", // 概念解释 / 技术名词 / 一问一答的 how-to
  "开发需求", // 要团队协作设计或实现的软件功能 / 系统
  "任务指令", // 明确要求对项目执行的操作（写代码 / 改文件 / 跑流程…）
] as const;

/**
 * 命中这些意图就分流到右侧「回答助手」单节点工作流；其余意图（含分类失败 / 低置信）一律走架构师全团队。
 * 兜底方向刻意偏向架构师——全功能路径是安全默认，宁可多惊动团队，也不把真需求误塞给单节点助手。
 */
export const ASSISTANT_INTENTS: readonly string[] = ["闲聊", "知识问答"];
