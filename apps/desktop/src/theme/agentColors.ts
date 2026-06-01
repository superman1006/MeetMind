/** agent_name → 气泡配色(背景/文字)。user 灰,5 个角色各异。 */
export interface AgentColor { bg: string; fg: string; label: string }

const COLORS: Record<string, AgentColor> = {
  user: { bg: "#e5e7eb", fg: "#111827", label: "用户" },
  architect: { bg: "#ede9fe", fg: "#5b21b6", label: "架构师" },
  backend: { bg: "#dbeafe", fg: "#1e40af", label: "后端" },
  frontend: { bg: "#dcfce7", fg: "#166534", label: "前端" },
  tester: { bg: "#ffedd5", fg: "#9a3412", label: "测试" },
  pm: { bg: "#fce7f3", fg: "#9d174d", label: "产品经理" },
};

const FALLBACK: AgentColor = { bg: "#f3f4f6", fg: "#374151", label: "未知" };

export function agentColor(agentName: string): AgentColor {
  return COLORS[agentName] ?? FALLBACK;
}
