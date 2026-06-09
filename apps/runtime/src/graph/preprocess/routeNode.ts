/**
 * route_node —— 预处理流水线第三步：分流决策。
 *
 * 跑在 intent_node 之后：读 intent_node 已经算好的「意图标签 + 置信分」，按「标签 ∈ 助手意图 且
 * 分数 ≥ 阈值」决定本轮走哪条工作流，把结果写进 state.route（"chat" / "team"）。真正的 node 间
 * 分派由它后面那条条件边（routeAfterPreprocess）读 state.route 完成——本节点只负责「决策」、不负责「跳转」。
 *
 * 为什么单独开一个节点而不是把判断塞进条件边：条件边是廉价确定性的分派函数，不适合承载「带阈值的决策 +
 * 打日志 + 留 checkpoint」。把决策抽成一等公民节点，意图识别那个 NLI 就退回去只当展示/参考信号，职责清晰。
 *
 * 当前实现刻意简单：纯用 NLI 的 label + score 划分，不再调 LLM。NLI 偏脆，所以兜底方向一律偏向架构师
 * 全团队（安全默认）——分类失败 / 低置信 / 非助手意图，统统走 team。
 */

import { ASSISTANT_INTENTS } from "../../config/constants.js";
import { getSettings } from "../../config/settings.js";
import { getLogger } from "../../utils/logger.js";
import type { AgentState } from "../state.js";

const logger = getLogger("graph.route");

/** route 的两个取值，集中成常量避免各处手写裸串。 */
export const ROUTE_CHAT = "chat"; // → 右侧回答助手单节点
export const ROUTE_TEAM = "team"; // → 左侧架构师全团队

/**
 * 构造 route_node 节点函数。无需建模型——纯读 state 里 intent_node 的产出做判断。
 */
export function createRouteNode() {
  return async (state: AgentState): Promise<Partial<AgentState>> => {
    const intent = state.intent ?? "";
    const score = state.intent_score ?? 0;
    const threshold = getSettings().intentRouteThreshold;

    // 默认走团队（安全兜底）；仅当命中助手意图且置信分过阈值才分流到助手
    let route = ROUTE_TEAM;
    const isAssistantIntent = ASSISTANT_INTENTS.includes(intent);
    if (isAssistantIntent && score >= threshold) {
      route = ROUTE_CHAT;
    }

    const target = route === ROUTE_CHAT ? "回答助手 (assistant)" : "架构师全团队 (architect)";
    logger.info(
      `[route] 分流决策完成\n` +
        `    命中意图: ${intent || "(无)"} (${score.toFixed(3)})  阈值: ${threshold}\n` +
        `    分流结果: ${route} → ${target}`,
    );
    return { route };
  };
}
