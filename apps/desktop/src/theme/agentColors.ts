/** agent_name → 气泡配色(背景/文字)。user 灰,5 个角色各异。浅/深两套调色板。 */
export interface AgentColor { bg: string; fg: string; label: string }

// 浅色主题:柔和的浅底 + 深字(原始配色,保持不动)。
const LIGHT_COLORS: Record<string, AgentColor> = {
  user: { bg: "#e5e7eb", fg: "#111827", label: "用户" },
  architect: { bg: "#ede9fe", fg: "#5b21b6", label: "架构师" },
  backend: { bg: "#dbeafe", fg: "#1e40af", label: "后端" },
  frontend: { bg: "#dcfce7", fg: "#166534", label: "前端" },
  tester: { bg: "#ffedd5", fg: "#9a3412", label: "测试" },
  pm: { bg: "#fce7f3", fg: "#9d174d", label: "产品经理" },
};

const LIGHT_FALLBACK: AgentColor = { bg: "#f3f4f6", fg: "#374151", label: "未知" };

// 深色主题:每个角色保留各自色相,但改成「深底 + 亮字」——深底比聊天区底色(#1e1e20)亮一档、
// 互相可区分;亮字取该色相的浅 300 档(tailwind),在深底上对比舒适、不刺眼。
const DARK_COLORS: Record<string, AgentColor> = {
  user: { bg: "#374151", fg: "#f3f4f6", label: "用户" },
  architect: { bg: "#2e2255", fg: "#c4b5fd", label: "架构师" },
  backend: { bg: "#1e3a5f", fg: "#93c5fd", label: "后端" },
  frontend: { bg: "#14402a", fg: "#86efac", label: "前端" },
  tester: { bg: "#45290f", fg: "#fdba74", label: "测试" },
  pm: { bg: "#45203a", fg: "#f9a8d4", label: "产品经理" },
};

const DARK_FALLBACK: AgentColor = { bg: "#2a2a2d", fg: "#d1d5db", label: "未知" };

export function agentColor(agentName: string, theme: "light" | "dark" = "light"): AgentColor {
  if (theme === "dark") {
    return DARK_COLORS[agentName] ?? DARK_FALLBACK;
  }
  return LIGHT_COLORS[agentName] ?? LIGHT_FALLBACK;
}
