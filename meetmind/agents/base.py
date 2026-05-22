"""BaseAgent — 所有协作 Agent 的公共接口。"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from meetmind.config.constants import (
    AGENT_NAMES,
    ARCHITECT,
    DONE_MARKER,
    NEXT_AGENT_PATTERN,
    ROLE_DESCRIPTIONS,
)
from meetmind.config.settings import get_settings
from meetmind.tools.rag_retriever import RAGRetriever
from meetmind.utils.logger import get_logger

logger = get_logger(__name__)


def _scrub_surrogates(text: str) -> str:
    """清理乱码字符（防止中文在非UTF-8 终端下崩溃）"""
    if not text:
        return text
    return text.encode("utf-8", errors="replace").decode("utf-8", errors="replace")


@dataclass
class AgentResponse:
    """
    每个 Agent 输出的内容，这里面的内容包含有用的信息和没用的信息
    没用的信息通过 rich 面板展示给用户看，有用的信息会被 graph/state.py 解析后更新到图的状态AgentState中, AgentState 是一个共享数据。
    """
    agent_name: str
    role: str
    message: str
    output_role: str | None  # 要路由到的下一个 agent，或 None
    done: bool = False
    used_rag: bool = False
    rag_sources: list[str] = field(default_factory=list)


class BaseAgent(ABC):
    """具体 Agent 继承此类并重写 `system_prompt`。"""

    name: str
    role: str

    def __init__(self, name: str, role: str):
        self.name = name
        self.role = role
        self.RAGRetriever = RAGRetriever(agent_name=name)

        settings = get_settings()
        self._llm = ChatOpenAI(
            api_key=settings.api_key,
            base_url=settings.base_url,
            model=settings.model_name,
            max_tokens=settings.max_tokens,
            temperature=settings.temperature,
            extra_body={"thinking": {"type": "disabled"}},
        )

    # ---------- 提示词 ----------

    @property
    @abstractmethod
    def system_prompt(self) -> str:
        """各子类定义角色人设与指令。可以重写来制定当前 role 的专属提示词。"""
        pass

    def _build_user_prompt(self, requirement: str, history: str, rag_context: str) -> str:
        """构建用户提示词，包含需求、历史讨论和 RAG 检索结果。"""
        return (
            f"## 项目当前需求\n{requirement}\n\n"
            f"## 已有讨论历史\n{history or '(尚无讨论)'}\n\n"
            f"## 你的私有知识库 (RAG 检索结果)\n{rag_context}\n\n"
            "## 你的任务\n"
            f"以 {ROLE_DESCRIPTIONS.get(self.name, self.name)} 的身份基于上述信息发表你的看法、"
            "建议或下一步行动，然后按系统指示选择下一个 agent。"
        )

    def _routing_instructions(self) -> str:
        """返回 路由指令 : str """
        peers = ", ".join(a for a in AGENT_NAMES if a != self.name)
        return (
            "\n\n=== 路由指令（非常重要） ===\n"
            "你的回复必须在最后一行单独标注路由指令，格式严格如下之一：\n"
            f"  [NEXT_AGENT: <agent_name>]   # 把发言权交给指定 agent，可选项: {peers}\n"
            "  [DONE]                       # 仅当你是架构师且认为整个需求已完成时使用\n"
            "其他 agent（非架构师）回复结束后默认应回到架构师：写 [NEXT_AGENT: architect]。\n"
            "不要在标记的同一行写任何其他内容。"
        )

    # ---------- 核心处理 ----------

    def process(self, requirement: str, conversation_history: str) -> AgentResponse:
        """查询 RAG、调用 LLM、解析响应并返回 AgentResponse。"""
        
        # 预先清理代理码点 — 终端编码不佳（LANG 未设为 UTF-8 区域）
        requirement = _scrub_surrogates(requirement)
        conversation_history = _scrub_surrogates(conversation_history)


        # RAG检索信息
        rag_context = self.RAGRetriever.retrieve(requirement)
        rag_text = (
            "\n".join(d.as_context_line() for d in rag_context)
            if rag_context
            else "(暂无相关历史信息)"
        )
        rag_sources = [d.metadata.get("source", "") for d in rag_context]

        # 系统提示词
        system_prompt = _scrub_surrogates(
            # 两段文字: 1) 角色人设与指令；2) 路由指令（非常重要）
            self.system_prompt + self._routing_instructions()
        )
        # 用户提示词
        user_prompt = self._build_user_prompt(
            requirement=requirement,
            history=conversation_history,
            rag_context=rag_text,
        )

        try:
            response = self._llm.invoke(
                [
                    SystemMessage(content=system_prompt),
                    HumanMessage(content=_scrub_surrogates(user_prompt)),
                ]
            )
            # 确保返回文本是字符串（有些模型可能返回 dict 或其他结构）
            text = response.content if isinstance(response.content, str) else str(response.content)
        except Exception as exc:
            logger.error("[%s] LLM call failed: %s", self.name, exc)
            text = (
                f"(LLM 调用失败: {exc})\n"
                # 其他角色回答出错后默认回退给架构师
                f"[NEXT_AGENT: {ARCHITECT}]"
            )

        # 解析出下一个路由的 agent 和是否有 完成标记
        output_role, done = self._parse_routing(text)

        return AgentResponse(
            agent_name=self.name,
            role=self.role,
            message=text.strip(),
            output_role=output_role,
            done=done,
            used_rag=bool(rag_context),
            rag_sources=rag_sources,
        )

    # ---------- 辅助方法 ----------

    @staticmethod
    def _parse_routing(text: str) -> tuple[str | None, bool]:
        """从文本末尾解析路由指令，返回 (next_agent, done)。"""

        # 如果文本中包含 "[DONE]"字符串,表示架构师认为需求已完成
        if DONE_MARKER in text:
            return None, True

        # 根据正则表达式寻找下一位发言的 agent
        match = re.search(NEXT_AGENT_PATTERN, text)
        if match:
            next_agent = match.group(1).strip().lower()
            if next_agent in AGENT_NAMES:
                return next_agent, False

        # 默认回退 — 交回架构师以保持图继续运行
        return ARCHITECT, False
