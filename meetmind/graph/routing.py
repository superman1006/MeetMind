"""Conditional edge routing logic for the agent graph."""

from __future__ import annotations

from langgraph.graph import END

from meetmind.config.constants import AGENT_NAMES, ARCHITECT
from meetmind.config.settings import get_settings
from meetmind.graph.state import AgentState
from meetmind.utils.logger import get_logger

logger = get_logger(__name__)


def route_next(state: AgentState) -> str:
    """Decide the next graph node based on the previous agent's output.

    Priority:
      1. If iteration cap hit -> END (safety).
      2. If `complete` flag set -> END (architect signalled done).
      3. If `next_agent` points to a known agent -> route there.
      4. Default -> back to architect to keep things alive.
    """
    iteration = state.get("iteration", 0)
    if iteration >= get_settings().max_iterations:
        logger.warning(
            "Reached max_iterations=%d, ending discussion as a safety stop.",
            get_settings().max_iterations,
        )
        return END

    if state.get("complete"):
        return END

    next_agent = state.get("next_agent")
    if next_agent and next_agent in AGENT_NAMES:
        return f"{next_agent}_node"

    return f"{ARCHITECT}_node"
