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

# 单轮 invoke 内允许 LLM 最多发起多少次 tool_calls，防止无限循环。
_MAX_TOOL_ITERATIONS = 5

logger = get_logger(__name__)


def clean_bad_chars(text: str) -> str:
    """清除字符串中孤立的 UTF-16 代理码点，用 `?` 占位。
    """
    if not text:
        return text
    return text.encode("utf-8", errors="replace").decode("utf-8", errors="replace")


@dataclass
class AgentResponse:
    """
    一次 Agent.invoke() 的产物，后续会被选择部分参数放到 AgentState 中。
    """
    agent_name: str
    role: str
    message: str
    next_agent: str | None  # 下一个发言 agent；None 表示讨论结束
    done: bool = False
    used_rag: bool = False


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

    def _user_prompt(self, requirement: str, history: str) -> str:
        """构建用户提示词。

        三个关键设计：
        1) 标签写"用户输入"而非"项目需求" —— 后者会让 LLM 把闲聊也当成项目去拆解；
        2) 把"字面指令优先"作为元规则放在最前面，且优先级高于角色默认行为；
        3) 私有知识库（RAG）不预注入到提示词里，由 LLM 自主决定是否调用
           `rag_search_<agent>` 工具检索历史经验。
        """
        return (
            f"## 用户输入\n{requirement}\n\n"
            f"## 已有讨论历史\n{history or '(尚无讨论)'}\n\n"
            "## 元规则（优先级最高，高于你的角色默认行为）\n"
            "1. 如果用户输入里有明确的字面指令（例如：『不用查数据库』『简短回答』"
            "『每个人都说 hello』『直接回答即可』），**必须严格遵守**，不要无视、"
            "不要扩展、不要加戏。\n"
            "2. 如果用户输入只是闲聊或简单指令（不是真正的项目/技术需求），就照字面"
            "意思回应一句即可，不要拆解、不要写用户故事、不要写接口设计。\n"
            "3. 仅当用户输入确实是一个项目/技术需求时，才以下面的角色身份做拆解、"
            "设计、用例规划等动作。\n\n"
            "## 你的任务\n"
            f"以 {ROLE_DESCRIPTIONS.get(self.name, self.name)} 的身份回应上面的输入。"
            "若问题与你的过往经验 / 代码 / 文档可能相关，可调用 RAG 工具检索；"
            "若用户明确说不用 RAG，或问题与历史无关，直接回答即可。"
            "最后按系统指示选择下一个 agent。"
        )

    def _routing_prompt(self) -> str:
        """返回拼接到 system_prompt 末尾的路由指令文本。

        告诉 LLM：回复最后必须用 `[NEXT_AGENT: xxx]` 或 `[DONE]` 单行标注，
        以便 `_parse_routing()` 能把发言权稳定地交给下一个 agent。
        """
        peers_list = []
        for a in AGENT_NAMES:
            if a != self.name:
                peers_list.append(a)
        peers = ", ".join(peers_list)
        return (
            "\n\n=== 路由指令（非常重要） ===\n"
            "你的回复必须在最后一行单独标注路由指令，格式严格如下之一：\n"
            f"  [NEXT_AGENT: <agent_name>]   # 把发言权交给指定 agent，可选项: {peers}\n"
            "  [DONE]                       # 架构师专用：用户需求已处理完毕，结束本轮讨论\n"
            "其他 agent（非架构师）回复结束后默认应回到架构师：写 [NEXT_AGENT: architect]。\n"
            "不要在标记的同一行写任何其他内容。\n\n"
            "=== 反循环硬规则（违反会让讨论卡到 max_iterations）===\n"
            "1. 严禁重复别人或自己之前说过的话：先扫一眼上面的「已有讨论历史」，\n"
            "   如果你打算说的内容已经有人说过类似的，要么补充新角度，要么不说。\n"
            "2. 如果用户输入只是闲聊/打招呼/简单 Q&A，架构师应该自己一句话回完就 [DONE]，\n"
            "   不要无意义地路由到 pm / backend / frontend / tester。\n"
            "3. 如果你（非架构师）发现自己只能输出寒暄性回复、没有专业信息可补充，\n"
            "   仍然要交回 architect（写 [NEXT_AGENT: architect]），由 architect 决定 [DONE]。\n"
            "4. **反喧宾夺主**：如果用户输入里点名了具体角色（如「pm 查 X」「让 backend 做 Y」），\n"
            "   架构师【绝不能】自己先调用 rag_search_architect 等工具去做那件事，\n"
            "   也不能自己代答；唯一动作是简短引导一句 + [NEXT_AGENT: <被点名的角色>]，\n"
            "   让该角色用它自己的 RAG / 专业能力去完成。"
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

        # 1) clean_bad_chars 清理乱码
        requirement = clean_bad_chars(requirement)
        conversation_history = clean_bad_chars(conversation_history)

        # 2) 准备 prompts + 绑定 RAG 工具到 LLM
        self.RAGRetriever.restart()
        rag_tool = self.RAGRetriever.get_tool()
        model_with_tools = self._model.bind_tools([rag_tool])

        user_prompt = clean_bad_chars(
            self._user_prompt(
                requirement=requirement,
                history=conversation_history,
            )
        )
        system_prompt = clean_bad_chars(
            # 两段文字: 1) 角色人设与指令；2) 路由指令（非常重要）
            self.system_prompt + self._routing_prompt()
        )

        messages: list = [
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_prompt),
        ]

        # 3) tool_calls 循环：让 LLM 自主决定是否调用 RAG
        final_text = ""
        try:
            for _ in range(_MAX_TOOL_ITERATIONS):
                # 调用模型得到 AIMessage
                ai_msg: AIMessage = model_with_tools.invoke(messages)
                messages.append(ai_msg)

                # 拿到所有 tool 的列表
                # getattr 可以获取 ai_msg 中的 tool_calls 属性，没有则返回 []
                tool_calls = getattr(ai_msg, "tool_calls", [])

                # 当前轮没有 tool_calls 了 → 认为 LLM 的回答已经完成，跳出循环
                if not tool_calls:
                    # 模型调用完 tool_calls里面的工具后,整理 final_text准备路由解析
                    if isinstance(ai_msg.content, str):
                        final_text = ai_msg.content        # 本来就是字符串，直接用
                    else:
                        final_text = str(ai_msg.content)   # 不是字符串，强制转成字符串
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
            logger.error(f"[{self.name}] LLM 调用失败: {exc}")
            final_text = (
                f"(LLM 调用失败: {exc})\n"
                # 其他角色回答出错后默认回退给架构师
                f"[NEXT_AGENT: {ARCHITECT}]"
            )

        # 4) 解析路由标记
        output_role, done = self._get_next_agent(final_text)

        return AgentResponse(
            agent_name=self.name,
            role=self.role,
            message=final_text.strip(),
            next_agent=output_role,
            done=done,
            used_rag=self.RAGRetriever.call_count > 0,
        )

    # ---------- 辅助方法 ----------

    @staticmethod
    def _get_next_agent(text: str) -> tuple[str | None, bool]:
        """从 LLM 回复中提取路由信号，返回 `(next_agent, done)`。
        - 若文本含 `[DONE]` → 返回 `(None, True)`
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
