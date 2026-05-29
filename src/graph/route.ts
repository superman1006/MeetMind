/**
 * Agent 图的条件边路由逻辑。
 */

import { END } from "@langchain/langgraph";

import { ARCHITECT, isAgentName } from "../config/constants.js";
import { getSettings } from "../config/settings.js";
import { getLogger } from "../utils/logger.js";
import type { AgentState } from "./state.js";

const logger = getLogger("graph.route");

/**
 * 根据上一 agent 的输出决定下一图节点。
 *
 * 优先级：
 *   1. 达到迭代上限 → END（安全保护）
 *   2. done 为真 → END（架构师宣布完成）
 *   3. next_agent 指向已知 agent → 路由到该处
 *   4. 默认 → 回到架构师
 */
export function routeToWhichAgent(state: AgentState): string {
  const iteration = state.iteration ?? 0;
  const maxIter = getSettings().maxIterations;

  // 安全阀：超过轮次上限强制结束
  if (iteration >= maxIter) {
    logger.warning(`已达到迭代上限 max_iterations=${maxIter}，强制结束讨论。`);
    return END;
  }

  // 架构师宣布完成
  if (state.done) {
    return END;
  }

  // 指向合法 agent 就路由过去
  const next = state.next_agent;
  if (next && isAgentName(next)) {
    return `${next}_node`;
  }

  return `${ARCHITECT}_node`; // 兜底回架构师
}
