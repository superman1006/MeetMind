"""BaseAgent — common interface for all collaborator agents."""

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
    """Replace any unpaired UTF-16 surrogate code points with U+FFFD.

    These leak in when the terminal/stdin encoding isn't UTF-8 and Python
    falls back to `surrogateescape`. httpx would later reject them when
    encoding the HTTP body, producing the cryptic
    `'utf-8' codec can't encode character '\\udcXX' ... surrogates not allowed`.
    """
    if not text:
        return text
    return text.encode("utf-8", errors="replace").decode("utf-8", errors="replace")


@dataclass
class AgentResponse:
    agent_name: str
    role: str
    message: str
    output_role: str | None  # next agent to route to, or None
    done: bool = False
    used_rag: bool = False
    rag_sources: list[str] = field(default_factory=list)


class BaseAgent(ABC):
    """Concrete agents inherit from this class and override `system_prompt`."""

    name: str
    role: str

    def __init__(self, name: str, role: str):
        self.name = name
        self.role = role
        self.rag_tool = RAGRetriever(agent_name=name)

        settings = get_settings()
        self._llm = ChatOpenAI(
            api_key=settings.api_key,
            base_url=settings.base_url,
            model=settings.model_name,
            max_tokens=settings.max_tokens,
            temperature=settings.temperature,
            extra_body={"thinking": {"type": "disabled"}},
        )

    # ---------- prompts ----------

    @property
    @abstractmethod
    def system_prompt(self) -> str:
        """Each subclass defines the persona / instructions."""

    def _routing_instructions(self) -> str:
        peers = ", ".join(a for a in AGENT_NAMES if a != self.name)
        return (
            "\n\n=== 路由指令（非常重要） ===\n"
            "你的回复必须在最后一行单独标注路由指令，格式严格如下之一：\n"
            f"  [NEXT_AGENT: <agent_name>]   # 把发言权交给指定 agent，可选项: {peers}\n"
            "  [DONE]                       # 仅当你是架构师且认为整个需求已完成时使用\n"
            "其他 agent（非架构师）回复结束后默认应回到架构师：写 [NEXT_AGENT: architect]。\n"
            "不要在标记的同一行写任何其他内容。"
        )

    # ---------- core processing ----------

    def process(self, requirement: str, conversation_history: str) -> AgentResponse:
        """Query RAG, call LLM, parse response, return AgentResponse."""
        # Scrub surrogate code points up-front — bad terminal encoding
        # (LANG not set to a UTF-8 locale) can leave \udcXX bytes in the
        # input strings, which would later crash httpx when serializing
        # the HTTP body. Cheap to do, prevents an obscure failure mode.
        requirement = _scrub_surrogates(requirement)
        conversation_history = _scrub_surrogates(conversation_history)

        rag_context = self.rag_tool.retrieve(requirement)
        rag_text = (
            "\n".join(d.as_context_line() for d in rag_context)
            if rag_context
            else "(暂无相关历史信息)"
        )
        rag_sources = [d.metadata.get("source", "") for d in rag_context]

        user_prompt = self._build_user_prompt(
            requirement=requirement,
            history=conversation_history,
            rag_context=rag_text,
        )
        system_prompt = _scrub_surrogates(
            self.system_prompt + self._routing_instructions()
        )

        try:
            response = self._llm.invoke(
                [
                    SystemMessage(content=system_prompt),
                    HumanMessage(content=_scrub_surrogates(user_prompt)),
                ]
            )
            text = response.content if isinstance(response.content, str) else str(response.content)
        except Exception as exc:
            logger.error("[%s] LLM call failed: %s", self.name, exc)
            text = (
                f"(LLM 调用失败: {exc})\n"
                f"[NEXT_AGENT: {ARCHITECT}]"
            )

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

    # ---------- helpers ----------

    def _build_user_prompt(self, requirement: str, history: str, rag_context: str) -> str:
        return (
            f"## 项目当前需求\n{requirement}\n\n"
            f"## 已有讨论历史\n{history or '(尚无讨论)'}\n\n"
            f"## 你的私有知识库 (RAG 检索结果)\n{rag_context}\n\n"
            "## 你的任务\n"
            f"以 {ROLE_DESCRIPTIONS.get(self.name, self.name)} 的身份基于上述信息发表你的看法、"
            "建议或下一步行动，然后按系统指示选择下一个 agent。"
        )

    @staticmethod
    def _parse_routing(text: str) -> tuple[str | None, bool]:
        if DONE_MARKER in text:
            return None, True
        match = re.search(NEXT_AGENT_PATTERN, text)
        if match:
            next_agent = match.group(1).strip().lower()
            if next_agent in AGENT_NAMES:
                return next_agent, False
        # default fallback — bounce back to architect to keep the graph alive
        return ARCHITECT, False
