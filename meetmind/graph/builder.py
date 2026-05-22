"""构建多 Agent LangGraph。

拓扑：
    START -> architect_node
    每个 agent_node -> 条件边 -> 下一 agent 或 END

路由由 `state['next_agent']` 驱动，每轮由 agent 解析的
`[NEXT_AGENT: name]` 标记（架构师可用 `[DONE]`）填充。
"""

from __future__ import annotations

from typing import Callable

from langgraph.graph import END, START, StateGraph

from meetmind.agents.architect import ArchitectAgent
from meetmind.agents.backend import BackendAgent
from meetmind.agents.base import BaseAgent
from meetmind.agents.frontend import FrontendAgent
from meetmind.agents.pm import PMAgent
from meetmind.agents.tester import TesterAgent
from meetmind.config.constants import AGENT_NAMES, ARCHITECT, BACKEND, FRONTEND, PM, TESTER
from meetmind.graph.routing import route_next
from meetmind.graph.state import AgentState, MessageTurn
from meetmind.utils.formatting import format_output_agentInfo
from meetmind.utils.logger import get_logger

logger = get_logger(__name__)


def _build_all_agents() -> dict[str, BaseAgent]:
    """初始化所有 agent 实例并返回一个字典映射。"""
    return {
        ARCHITECT: ArchitectAgent(),
        BACKEND: BackendAgent(),
        FRONTEND: FrontendAgent(),
        TESTER: TesterAgent(),
        PM: PMAgent(),
    }


def _format_history(messages: list[MessageTurn]) -> str:
    """将消息历史格式化为字符串，供 agent 处理时参考。"""
    if not messages:
        return ""
    chunks = []
    for m in messages:
        chunks.append(f"--- {m['agent_name']} ({m['role']}) ---\n{m['message']}")
    return "\n\n".join(chunks)


def _make_node_fn(agent: BaseAgent) -> Callable[[AgentState], dict]:
    """一个工厂函数: 输入一个 Agent，输出一个"能被 LangGraph 调用的节点函数"""

    def _node(state: AgentState) -> dict:
        """节点函数: 接收当前状态，调用 agent 处理，并返回更新后的状态。"""
        requirement = state.get("requirement", "")
        history = _format_history(state.get("messages", []))
        iteration = state.get("iteration", 0) + 1

        logger.info(
            "[graph] iter=%d  →  invoking %s_node",
            iteration,
            agent.name,
        )

        response = agent.process(requirement=requirement, conversation_history=history)

        # 实时在控制台美化输出
        format_output_agentInfo(
            agent_name=response.agent_name,
            message=response.message,
            next_role=response.output_role if not response.done else "DONE",
            used_rag=response.used_rag,
            rag_sources=[s for s in response.rag_sources if s],
        )

        new_turn: MessageTurn = {
            "agent_name": response.agent_name,
            "role": response.role,
            "message": response.message,
            "output_role": response.output_role,
        }

        return {
            "messages": [new_turn],
            "next_agent": response.output_role,
            "complete": response.done,
            "iteration": iteration,
        }

    # 返回这个函数，LangGraph 在执行到这个节点时会调用它
    return _node


def build_agent_graph():
    """编译并返回多 Agent 图。"""
    agents = _build_all_agents()
    graph = StateGraph(AgentState)

    # 1. 为每个 agent 添加节点
    for name, agent in agents.items():
        graph.add_node(f"{name}_node", _make_node_fn(agent))

    # 2. 入口 — START --> ARCHITECT
    graph.add_edge(START, f"{ARCHITECT}_node")

    # 3. 每个节点使用同一路由器的条件边
    route_map = {f"{name}_node": f"{name}_node" for name in AGENT_NAMES}
    route_map[END] = END
    # route_map:
    # { 'architect_node': 'architect_node',
    #   'backend_node': 'backend_node',
    #   'frontend_node': 'frontend_node',
    #   'tester_node': 'tester_node',
    #   'pm_node': 'pm_node',
    #   'END': 'END' }

    for name in AGENT_NAMES:
        graph.add_conditional_edges(
            f"{name}_node",
            route_next, # 条件函数，根据 state 决定下一节点
            route_map,  # 一个映射图 route_next 的返回值（如 "backend_node"）到实际节点的映射
        )

    graph = graph.compile()
    logger.info("LangGraph compiled: %s", ", ".join(f"{n}_node" for n in AGENT_NAMES))
    return graph
