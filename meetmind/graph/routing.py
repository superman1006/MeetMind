"""Agent 图的条件边路由逻辑。"""

from __future__ import annotations

from langgraph.graph import END

from meetmind.config.constants import AGENT_NAMES, ARCHITECT
from meetmind.config.settings import get_settings
from meetmind.graph.state import AgentState
from meetmind.utils.logger import get_logger

logger = get_logger(__name__)


def route_next(state: AgentState) -> str:
    """根据上一 agent 的输出决定下一图节点。

    优先级：
      1. 达到迭代上限 -> END（安全保护）。
      2. `complete` 为真 -> END（架构师宣布完成）。
      3. `next_agent` 指向已知 agent -> 路由到该处。
      4. 默认 -> 回到架构师以保持讨论继续。
    """

    # 拿到当前迭代次数,默认为0
    iteration = state.get("iteration", 0)

    # 当迭代次数达到上限后自动路由到 END 节点,以防止无限循环
    if iteration >= get_settings().max_iterations:
        logger.warning(
            "Reached max_iterations=%d, ending discussion as a safety stop.",
            get_settings().max_iterations,
        )
        return END

    # 当迭代<max且任务已完成时,路由到 END 节点
    if state.get("complete"):
        return END

    # 当以上两个条件都不满足时,根据 next_agent 字段路由到指定 agent 的节点
    next_agent = state.get("next_agent")
    if next_agent and next_agent in AGENT_NAMES:
        return f"{next_agent}_node"

    # 默认路由到架构师
    return f"{ARCHITECT}_node"
