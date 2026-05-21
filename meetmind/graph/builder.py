"""Build the multi-agent LangGraph.

Topology:
    START -> architect_node
    every agent_node -> conditional edge -> next agent or END

Routing is driven by `state['next_agent']`, populated each turn from the
agent's parsed `[NEXT_AGENT: name]` marker (or `[DONE]` for the architect).
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
from meetmind.config.constants import AGENT_NAMES, ARCHITECT
from meetmind.graph.routing import route_next
from meetmind.graph.state import AgentState, MessageTurn
from meetmind.utils.formatting import format_agent_output
from meetmind.utils.logger import get_logger

logger = get_logger(__name__)


def _build_agents() -> dict[str, BaseAgent]:
    return {
        ARCHITECT: ArchitectAgent(),
        "backend": BackendAgent(),
        "frontend": FrontendAgent(),
        "tester": TesterAgent(),
        "pm": PMAgent(),
    }


def _format_history(messages: list[MessageTurn]) -> str:
    if not messages:
        return ""
    chunks = []
    for m in messages:
        chunks.append(f"--- {m['agent_name']} ({m['role']}) ---\n{m['message']}")
    return "\n\n".join(chunks)


def _make_node_fn(agent: BaseAgent) -> Callable[[AgentState], dict]:
    """Wrap an agent's process() into a LangGraph node function."""

    def _node(state: AgentState) -> dict:
        requirement = state.get("requirement", "")
        history = _format_history(state.get("messages", []))
        iteration = state.get("iteration", 0) + 1

        logger.info(
            "[graph] iter=%d  →  invoking %s_node",
            iteration,
            agent.name,
        )

        response = agent.process(requirement=requirement, conversation_history=history)

        # Real-time pretty print to the console
        format_agent_output(
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

    return _node


def build_agent_graph():
    """Compile and return the multi-agent graph."""
    agents = _build_agents()
    builder = StateGraph(AgentState)

    # 1. Add a node for every agent
    for name, agent in agents.items():
        builder.add_node(f"{name}_node", _make_node_fn(agent))

    # 2. Entry point — architect always speaks first
    builder.add_edge(START, f"{ARCHITECT}_node")

    # 3. Conditional edges from every node using the same router
    route_map = {f"{name}_node": f"{name}_node" for name in AGENT_NAMES}
    route_map[END] = END

    for name in AGENT_NAMES:
        builder.add_conditional_edges(
            f"{name}_node",
            route_next,
            route_map,
        )

    graph = builder.compile()
    logger.info("LangGraph compiled: %s", ", ".join(f"{n}_node" for n in AGENT_NAMES))
    return graph
