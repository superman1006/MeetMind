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

from meetmind.agents import AgentResponse
from meetmind.agents.architect import ArchitectAgent
from meetmind.agents.backend import BackendAgent
from meetmind.agents.base import BaseAgent
from meetmind.agents.frontend import FrontendAgent
from meetmind.agents.pm import PMAgent
from meetmind.agents.tester import TesterAgent
from meetmind.config.constants import AGENT_NAMES, ARCHITECT, BACKEND, FRONTEND, PM, TESTER
from meetmind.graph.route import route_to_which_agent
from meetmind.graph.state import AgentState, MessageTurn
from meetmind.utils.formatting import print_agent_info
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


def _create_node(agent: BaseAgent) -> Callable[[AgentState], dict]:
    """一个工厂函数: 输入一个 Agent，输出一个"能被 LangGraph 调用的节点函数"""

    def _node(state: AgentState) -> dict:
        """节点函数: 接收当前状态，调用 agent 处理，并返回更新后的状态。"""
        requirement = state.get("requirement", "")
        history = _format_history(state.get("messages", []))
        iteration = state.get("iteration", 0) + 1

        logger.info(
            f"[graph] iteration={iteration}  →  invoking {agent.name}_node"
        )

        response :AgentResponse = agent.invoke(requirement=requirement, conversation_history=history)

        # 实时在控制台美化输出
        print_agent_info(
            agent_name=response.agent_name,
            message=response.message,
            next_role=response.next_agent if not response.done else "DONE",
            used_rag=response.used_rag,
        )

        new_turn: MessageTurn = {
            "agent_name": response.agent_name,
            "role": response.role,
            "message": response.message,
            "next_agent": response.next_agent,
        }

        return {
            "messages": [new_turn],
            "next_agent": response.next_agent,
            "done": response.done,
            "iteration": iteration,
        }

    # 返回这个函数，LangGraph 在执行到这个节点时会调用它
    return _node


def build_graph():
    """编译并返回多 Agent 图。"""
    agents = _build_all_agents()
    graph = StateGraph(AgentState)

    # 1. 为每个 agent 添加节点
    for name, agent in agents.items():
        graph.add_node(f"{name}_node", _create_node(agent))

    # 2. 入口 — START --> ARCHITECT
    graph.add_edge(START, f"{ARCHITECT}_node")

    # 3. 每个节点使用同一路由器的条件边
    route_map = {}
    for name in AGENT_NAMES:
        node_key = f"{name}_node"
        route_map[node_key] = node_key
    route_map[END] = END
    # route_map:
    # { 'architect_node': 'architect_node',
    #   'backend_node': 'backend_node',
    #   'frontend_node': 'frontend_node',
    #   'tester_node': 'tester_node',
    #   'pm_node': 'pm_node',
    #   'END': 'END' }

    # 添加所有条件边
    for name in AGENT_NAMES:
        graph.add_conditional_edges(
            f"{name}_node",
            route_to_which_agent, # 条件函数，根据 state 决定下一节点
            route_map,  # 一个映射图 route_next 的返回值（如 "backend_node"）到实际节点的映射
        )

    graph = graph.compile()
    node_names = []
    for n in AGENT_NAMES:
        node_names.append(f"{n}_node")
    logger.info(f"LangGraph compiled: {', '.join(node_names)}")
    return graph
