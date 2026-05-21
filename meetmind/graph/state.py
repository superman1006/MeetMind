"""TypedDict definitions for the LangGraph state."""

from __future__ import annotations

from operator import add
from typing import Annotated, TypedDict


class MessageTurn(TypedDict):
    agent_name: str
    role: str
    message: str
    output_role: str | None  # which agent should respond next, None if done


class AgentState(TypedDict, total=False):
    # Architect input
    requirement: str

    # Append-only discussion log
    messages: Annotated[list[MessageTurn], add]

    # Routing: next agent to invoke (set by previous node)
    next_agent: str | None

    # Completion signal — set by architect when work is done
    complete: bool

    # Safety: cap on graph iterations
    iteration: int
