"""LangGraph 共享状态的 TypedDict 定义。

`AgentState` 是整个图运行时被所有节点共享的"全局变量"；每个节点函数返回
的字典会按字段被合并进来——其中 `messages` 使用 `operator.add` 作为
reducer 实现追加合并，其他字段则是直接覆盖。
"""

from __future__ import annotations

from operator import add
from typing import Annotated, TypedDict


class MessageTurn(TypedDict):
    """根据每个 agent 调用后输出的 AgentResponse 筛选出要放入 AgentState 的，会被追加进 `AgentState.messages`。"""

    agent_name: str
    role: str
    message: str
    next_agent: str | None  # 该 agent 指定的下一发言人；None 表示已结束


class AgentState(TypedDict, total=False):
    """整张图共享的状态。所有字段对所有节点都可读，写则按 reducer 合并。"""

    # 架构师本轮输入的原始需求；整轮讨论中保持不变
    requirement: str

    # 仅追加的讨论历史：每个节点 return `{"messages": [new_turn]}` 会被拼到尾部
    messages: Annotated[list[MessageTurn], add]

    # 下一待调用 agent 的名字，由上一节点解析自己的 `[NEXT_AGENT: …]` 标记后写入
    next_agent: str | None

    # 完成信号；架构师输出 `[DONE]` 时被置 True，触发条件边走向 END
    done: bool

    # 已执行的节点轮次数；用于和 Settings.max_iterations 比较，防死循环
    iteration: int
