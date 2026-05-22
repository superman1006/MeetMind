"""BaseAgent — 所有协作 Agent 的公共接口。"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_openai import ChatOpenAI

from meetmind.config.constants import (
    AGENT_NAMES,
    ARCHITECT,
    DONE_MARKER,
    NEXT_AGENT_PATTERN,
    ROLE_DESCRIPTIONS,
)
from meetmind.config.settings import get_settings
from meetmind.database.rag_retriever import RAGRetriever
from meetmind.utils.logger import get_logger

# 单轮 process 内允许 LLM 最多发起多少次 tool_calls，防止无限循环。
_MAX_TOOL_ITERATIONS = 5

logger = get_logger(__name__)


def clean_bad_chars(text: str) -> str:
    """清除字符串中孤立的 UTF-16 代理码点（如 \\udce5），用 `?` 占位。

    背景：当终端 locale 不是 UTF-8 时，Python 会用 `surrogateescape`
    把无法解码的字节保存成 \\udcXX。这些"半字符"在后续传给 httpx
    发送 HTTP body 时会因 UTF-8 编码失败而抛出
    `'utf-8' codec can't encode ... surrogates not allowed`。
    本函数在 LLM 调用前统一清理一次，作为最后一道防线。
    """
    if not text:
        return text
    return text.encode("utf-8", errors="replace").decode("utf-8", errors="replace")


@dataclass
class AgentResponse:
    """一次 Agent.process() 的产物。

    内容分两类：
      - 给人看的：`message` 由 CLI 的 rich 面板渲染展示；
      - 给图用的：`output_role` / `done` / `used_rag` / `rag_sources`
        由 graph/builder._make_node_fn 提取后写入共享的 `AgentState`，
        驱动后续条件边路由。
    """
    agent_name: str
    role: str
    message: str
    output_role: str | None  # 下一个发言 agent；None 表示讨论结束
    done: bool = False
    used_rag: bool = False
    rag_sources: list[str] = field(default_factory=list)


class BaseAgent(ABC):
    """所有协作 Agent 的抽象基类。

    子类只需重写 `system_prompt` 属性来定义角色人设；公共能力（绑定 LLM、
    持有专属 RAGRetriever、tool_calls 循环、路由标记解析）都在这里实现。
    """

    name: str
    role: str

    def __init__(self, name: str, role: str):
        self.name = name
        self.role = role
        self.RAGRetriever = RAGRetriever(agent_name=name)

        settings = get_settings()
        self._model = ChatOpenAI(
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
        """子类必须实现：返回该角色专属的 system prompt（人设 + 工作风格 + 约束）。"""
        pass

    def _build_user_prompt(self, requirement: str, history: str) -> str:
        """构建用户提示词，包含需求和已有讨论历史。

        注意：私有知识库（RAG）不再预先注入到提示词里，而是作为工具暴露给 LLM；
        LLM 自己根据问题判断是否调用 `rag_search_<agent>` 来检索历史经验。
        """
        return (
            f"## 项目当前需求\n{requirement}\n\n"
            f"## 已有讨论历史\n{history or '(尚无讨论)'}\n\n"
            "## 你的任务\n"
            f"以 {ROLE_DESCRIPTIONS.get(self.name, self.name)} 的身份发表看法、建议或下一步行动。"
            "如果需要参考你过去的工作经验 / 代码 / 文档，请调用提供的 RAG 工具进行检索；"
            "如果问题完全无需历史背景，可直接回答。最后按系统指示选择下一个 agent。"
        )

    def _routing_instructions(self) -> str:
        """返回拼接到 system_prompt 末尾的路由指令文本。

        告诉 LLM：回复最后必须用 `[NEXT_AGENT: xxx]` 或 `[DONE]` 单行标注，
        以便 `_parse_routing()` 能把发言权稳定地交给下一个 agent。
        """
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

    def invoke(self, requirement: str, conversation_history: str) -> AgentResponse:
        """运行一次 Agent 推理：可选地调用 RAG 工具，最终返回 AgentResponse。

        流程：
          1. 清洗输入中的代理码点，避免 httpx 编码崩溃；
          2. 构造 system / user 消息，把 RAG 检索器作为 LangChain Tool 绑定到 LLM；
          3. 进入 tool_calls 循环：
             - 调用 LLM；若返回里有 tool_calls，按 ID 执行对应工具，把结果包装成
               ToolMessage 追加到消息列表，再继续下一轮；
             - 若 LLM 不再要求调用工具，跳出循环，把它的 content 作为最终回复；
          4. 用正则解析最终回复中的 `[NEXT_AGENT: …]` / `[DONE]` 路由标记。
        """

        # 1) 预清理代理码点 — 终端非 UTF-8 区域时 Python 会用 surrogateescape
        #    把高位字节存成 \udcXX，httpx 序列化 HTTP body 会因此崩溃。
        requirement = clean_bad_chars(requirement)
        conversation_history = clean_bad_chars(conversation_history)

        # 2) 准备 prompts + 绑定 RAG 工具到 LLM
        self.RAGRetriever.restart()
        rag_tool = self.RAGRetriever.as_langchain_tool()
        model_with_tools = self._model.bind_tools([rag_tool])

        system_prompt = clean_bad_chars(
            # 两段文字: 1) 角色人设与指令；2) 路由指令（非常重要）
            self.system_prompt + self._routing_instructions()
        )
        user_prompt = clean_bad_chars(
            self._build_user_prompt(
                requirement=requirement,
                history=conversation_history,
            )
        )

        messages: list = [
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_prompt),
        ]

        # 3) tool_calls 循环：让 LLM 自主决定是否调用 RAG
        final_text = ""
        try:
            for _ in range(_MAX_TOOL_ITERATIONS):
                ai_msg: AIMessage = model_with_tools.invoke(messages)
                messages.append(ai_msg)

                tool_calls = getattr(ai_msg, "tool_calls", None) or []
                if not tool_calls:
                    # 模型不再要求调用工具 → 把这一轮的回答作为最终输出
                    final_text = (
                        ai_msg.content
                        if isinstance(ai_msg.content, str)
                        else str(ai_msg.content)
                    )
                    break

                # 执行每一个 tool_call，把结果追加为 ToolMessage
                for tc in tool_calls:
                    tool_name = tc.get("name", "")
                    tool_args = tc.get("args", {}) or {}
                    tool_id = tc.get("id", "")
                    logger.info(
                        "[%s] → 调用工具 %s args=%s", self.name, tool_name, tool_args
                    )
                    if tool_name == rag_tool.name:
                        tool_result = rag_tool.invoke(tool_args)
                    else:
                        tool_result = f"(未知工具: {tool_name})"
                    messages.append(
                        ToolMessage(content=tool_result, tool_call_id=tool_id)
                    )
            else:
                # 循环用尽仍在调用工具：fallback 让架构师接手
                final_text = (
                    "(工具调用次数已达上限，未能给出最终结论)\n"
                    f"[NEXT_AGENT: {ARCHITECT}]"
                )
        except Exception as exc:
            logger.error("[%s] LLM 调用失败: %s", self.name, exc)
            final_text = (
                f"(LLM 调用失败: {exc})\n"
                # 其他角色回答出错后默认回退给架构师
                f"[NEXT_AGENT: {ARCHITECT}]"
            )

        # 4) 解析路由标记
        output_role, done = self._parse_routing(final_text)

        return AgentResponse(
            agent_name=self.name,
            role=self.role,
            message=final_text.strip(),
            output_role=output_role,
            done=done,
            used_rag=self.RAGRetriever.call_count > 0,
            rag_sources=list(self.RAGRetriever.last_query_sources),
        )

    # ---------- 辅助方法 ----------

    @staticmethod
    def _parse_routing(text: str) -> tuple[str | None, bool]:
        """从 LLM 回复中提取路由信号，返回 `(next_agent, done)`。

        - 若文本含 `[DONE]` → 返回 `(None, True)`，整轮讨论结束。
          （提示词里只允许架构师产出 [DONE]，其他角色出现一律视为同样语义。）
        - 否则按正则 `[NEXT_AGENT: name]` 提取下一发言人；若 name 不在
          已知 agent 列表中或正则匹配失败，则兜底回到架构师，保证图不会卡死。
        """

        # `[DONE]` 是终止标记：理论上只有架构师会输出，命中即结束本轮
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
