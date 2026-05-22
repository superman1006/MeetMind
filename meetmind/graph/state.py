"""LangGraph 状态的 TypedDict 定义。"""

from __future__ import annotations

from operator import add
from typing import Annotated, TypedDict


class MessageTurn(TypedDict):
    agent_name: str
    role: str
    message: str
    output_role: str | None  # 下一响应该由哪个 agent 负责，完成时为 None


class AgentState(TypedDict, total=False):
    # 架构师输入,同一个会话中不变
    requirement: str

    # 仅追加的讨论记录
    messages: Annotated[list[MessageTurn], add]

    # 路由：下一待调用的 agent（由上一节点设置）
    next_agent: str | None

    # 完成信号 — 工作完成时由架构师设置
    complete: bool

    # 安全：图迭代次数上限
    iteration: int
