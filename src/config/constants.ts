/**
 * MeetMind 应用级常量。
 * 字段名按 Python 端 snake_case 保留（会序列化进 LangGraph state），
 * 跨语言一致性优先于 TS camelCase 风格。
 */

export const ARCHITECT = "architect";
export const BACKEND = "backend";
export const FRONTEND = "frontend";
export const TESTER = "tester";
export const PM = "pm";

export const AGENT_NAMES = [ARCHITECT, BACKEND, FRONTEND, TESTER, PM] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export const NON_ARCHITECT_AGENTS = [BACKEND, FRONTEND, TESTER, PM] as const;

export const ROLE_DESCRIPTIONS: Record<string, string> = {
  [ARCHITECT]: "架构师 (Architect / Tech Lead)",
  [BACKEND]: "后端工程师 (Backend Engineer)",
  [FRONTEND]: "前端工程师 (Frontend Engineer)",
  [TESTER]: "测试工程师 (QA Engineer)",
  [PM]: "产品经理 (Product Manager)",
};

export function isAgentName(value: string): value is AgentName {
  return (AGENT_NAMES as readonly string[]).includes(value);
}
