/**
 * route_node —— 预处理流水线第三步：分流决策。
 *
 * 跑在 intent_node 之后：读 intent_node 已经算好的「意图标签 + top-1/top-2 间距」，决定本轮走哪条
 * 工作流，把结果写进 state.route（"chat" / "team"）。真正的 node 间分派由它后面那条条件边
 * （routeAfterPreprocess）读 state.route 完成——本节点只负责「决策」、不负责「跳转」。
 *
 * 为什么单独开一个节点而不是把判断塞进条件边：条件边是廉价确定性的分派函数，不适合承载「带阈值的决策 +
 * 打日志 + 留 checkpoint」。把决策抽成一等公民节点，意图识别那个 NLI 就退回去只当展示/参考信号，职责清晰。
 *
 * 判定逻辑（间距 margin 而非绝对阈值）：NLI 4 标签 softmax 归一化后分数贴近均匀线（0.25），单标签很难
 * 超过绝对阈值；改看 top-1 与 top-2 的间距——间距 ≥ margin 阈值才认为分类「有信号、可信」，此时按命中
 * 意图分流（闲聊/知识问答 → 助手，开发需求/任务指令 → 团队）；间距过小（贴均匀线、四个标签难分伯仲）
 * 视为「判定不了」，默认走右侧回答助手（chat）——单点回答比惊动整个团队更轻、误判代价更小。
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
    const margin = state.intent_margin ?? 0;
    const marginThreshold = getSettings().intentRouteMargin;

    // 间距够大 → 分类可信，按命中意图分流（助手意图走 chat，其余走 team）；
    // 间距过小 → 判定不了（四个标签贴均匀线、难分伯仲），默认走右侧回答助手。
    const isAssistantIntent = ASSISTANT_INTENTS.includes(intent);
    let route: string;
    let decision: string;
    if (margin >= marginThreshold) {
      if (isAssistantIntent) {
        route = ROUTE_CHAT;
      } else {
        route = ROUTE_TEAM;
      }
      decision = "可信，按意图分流";
    } else {
      route = ROUTE_CHAT;
      decision = "判定不了，默认走助手";
    }

    const target = route === ROUTE_CHAT ? "回答助手 (assistant)" : "架构师全团队 (architect)";
    logger.info(
      `[route] 分流决策完成\n` +
        `    命中意图: ${intent || "(无)"}  间距: ${margin.toFixed(3)}  阈值: ${marginThreshold}（${decision}）\n` +
        `    分流结果: ${route} → ${target}`,
    );
    return { route };
  };
}
