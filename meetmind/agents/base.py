"""BaseAgent — 所有协作 Agent 的公共接口。"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
import json
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage, BaseMessage
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

from meetmind.config.constants import (
    AGENT_NAMES,
    ARCHITECT,
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


class ModelOutput(BaseModel):
    """LLM 单轮回复的强约束 schema。

    用 `model.with_structured_output(ModelOutput)` 让模型按这个 schema 生成结构化输出，
    省掉以前用 `[NEXT_AGENT: …]` / `[DONE]` 自然语言标记 + 正则解析的脆弱方案。
    """

    content: str = Field(
        description="给用户与其他 agent 看的正文。本字段才是真正展示出去的回复。"
    )
    next_agent: str = Field(
        description=(
            "下一个发言 agent 的名字，必须是 architect / backend / frontend / tester / pm 之一。"
            "非架构师角色发言结束后通常应填 'architect'；架构师宣布完成时这里也填 'architect'（占位即可）。"
        )
    )
    done: str = Field(
        description=(
            "本轮讨论是否完成。只允许两个字符串值："
            "'true' —— 架构师认为整个用户需求已被处理完毕，本轮可以结束；"
            "'false' —— 还需要继续讨论。非架构师角色一律填 'false'。"
        )
    )


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

        现在不再要求 LLM 在自由文本里写 `[NEXT_AGENT: …]` / `[DONE]` 标记，
        而是依赖 `with_structured_output(ModelOutput)` 让模型直接输出结构化 JSON。
        本段提示词告诉 LLM **如何填 ModelOutput 的 next_agent / done 字段**。
        """
        peers_list = []
        for a in AGENT_NAMES:
            if a != self.name:
                peers_list.append(a)
        peers = ", ".join(peers_list)
        return (
            "\n\n=== 输出字段填写指南（你的最终回复会被强制约束为 JSON）===\n"
            "你的回复将被序列化为三字段对象 ModelOutput { content, next_agent, done }。\n"
            f"  • content    : 给用户和其他 agent 看的正文，写在这里就行，不要再额外加 [NEXT_AGENT] / [DONE] 标记。\n"
            f"  • next_agent : 下一个发言 agent 的名字。可选项: {peers}, {self.name}。\n"
            f"                 非架构师角色发言结束后通常填 'architect'；\n"
            f"                 架构师宣布完成时也填 'architect'（占位用）。\n"
            f"  • done       : 字符串 'true' 或 'false'。\n"
            f"                 仅架构师在整个用户需求都处理完时填 'true'，其它任何情况一律 'false'。\n\n"
            "=== 反循环硬规则（违反会让讨论卡到 max_iterations）===\n"
            "1. 严禁重复别人或自己之前说过的话：先扫一眼上面的「已有讨论历史」，\n"
            "   如果你打算说的内容已经有人说过类似的，要么补充新角度，要么不说。\n"
            "2. 如果用户输入只是闲聊/打招呼/简单 Q&A，架构师应该自己一句话回完就把 done 设为 'true'，\n"
            "   不要无意义地路由到 pm / backend / frontend / tester。\n"
            "3. 如果你（非架构师）发现自己只能输出寒暄性回复、没有专业信息可补充，\n"
            "   仍然把 next_agent 填 'architect'，由架构师决定是否 done='true'。\n"
            "4. **反喧宾夺主**：如果用户输入里点名了具体角色（如「pm 查 X」「让 backend 做 Y」），\n"
            "   架构师【绝不能】自己先调用 rag_search_architect 等工具去做那件事，\n"
            "   也不能自己代答；唯一动作是简短引导一句 + next_agent 填被点名的角色名。"
        )

    # ---------- 核心处理 ----------

    def invoke(self, requirement: str, conversation_history: str) -> AgentResponse:
        """运行一次 Agent 推理，分两个阶段调 LLM。

        这是 LangChain 官方推荐的「tools + structured output」组合模式。
        `bind_tools` 和 `with_structured_output` 都依赖 function-calling 协议，
        放在一次 invoke 里会让 LLM 在「该调工具还是该返回 schema」上犹豫，
        对 OpenAI 兼容端点（如小米 mimo）不稳定，所以拆成两段：

          Phase 1 —— 工具循环（只 bind_tools，不约束输出格式）
            LLM 自主决定调不调 RAG；调了就执行、把结果包成 ToolMessage 接回；
            直到 LLM 不再要工具，或循环达 _MAX_TOOL_ITERATIONS 上限。

          Phase 2 —— 结构化收尾（只 with_structured_output，不再带工具）
            在 messages 末尾追加一条 HumanMessage 明确要求按 ModelOutput 汇总，
            直接拿到 ModelOutput 实例。

        最后把 ModelOutput 三字段填进 AgentResponse（done 字符串转 bool）。
        """

        # 1) 清乱码
        requirement = clean_bad_chars(requirement)
        conversation_history = clean_bad_chars(conversation_history)

        # 2) 准备 prompts + RAG 工具
        self.RAGRetriever.restart()
        rag_tool = self.RAGRetriever.get_tool()

        user_prompt = clean_bad_chars(
            self._user_prompt(
                requirement=requirement,
                history=conversation_history,
            )
        )
        system_prompt = clean_bad_chars(
            # 两段文字: 1) 角色人设与指令；2) 输出字段填写指南 + 反循环规则
            self.system_prompt + self._routing_prompt()
        )

        messages: list[BaseMessage] = [
            SystemMessage(content=system_prompt),
            HumanMessage(content=user_prompt),
        ]

        # ===== Phase 1：工具循环 =====
        model_with_tools = self._model.bind_tools([rag_tool])

        try:
            for _ in range(_MAX_TOOL_ITERATIONS):
                ai_msg: AIMessage = model_with_tools.invoke(messages)
                messages.append(ai_msg)

                tool_calls = getattr(ai_msg, "tool_calls", []) or []
                if not tool_calls:
                    # LLM 不再调工具 → 退出循环进 Phase 2
                    break

                # 执行每个 tool_call，结果追加为 ToolMessage
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
                # 循环用尽仍在调工具：仍进 Phase 2，让模型基于现有上下文给结构化总结
                logger.warning(
                    f"[{self.name}] 工具调用次数已达上限 ({_MAX_TOOL_ITERATIONS})，"
                    "强制进入结构化收尾阶段"
                )
        except Exception as exc:
            # Phase 1 异常（API 超时 / 网络错误等）→ 直接构造 fallback，跳过 Phase 2
            logger.error(f"[{self.name}] Phase 1 工具循环失败: {exc}")
            fallback = ModelOutput(
                content=f"(LLM 调用失败: {exc})",
                next_agent=ARCHITECT,
                done="false",
            )
            return self._build_agent_response(fallback)

        # ===== Phase 2：结构化收尾 =====
        # 给模型一个明确的"按 ModelOutput 输出"指令，避免它继续说自由文本
        wrap_up_prompt = (
            "以上是你（和工具）已经产出的全部上下文。"
            "请基于以上信息，按 ModelOutput 三字段输出最终结果：\n"
            "  • content    : 给团队看的正文（不要重复罗列上面已说过的话，给出最终结论 / 建议 / 行动项即可）\n"
            "  • next_agent : 下一个发言 agent（architect / backend / frontend / tester / pm 之一）\n"
            "  • done       : 'true' 或 'false'"
        )
        messages.append(HumanMessage(content=wrap_up_prompt))

        structured_model = self._model.with_structured_output(ModelOutput)
        try:
            final_output: ModelOutput = structured_model.invoke(messages)
        except Exception as exc:
            logger.error(f"[{self.name}] Phase 2 结构化收尾失败: {exc}")
            final_output = ModelOutput(
                content=f"(结构化输出失败: {exc})",
                next_agent=ARCHITECT,
                done="false",
            )

        return self._build_agent_response(final_output)

    # ---------- 辅助方法 ----------

    def _build_agent_response(self, output: ModelOutput) -> AgentResponse:
        """把 ModelOutput 三字段规范化后填进 AgentResponse。

        - done       : 字符串 → bool（'true' / 'yes' / '1' / 'done' / '完成' 都视为 True）
        - next_agent : 小写化 + 不在 AGENT_NAMES 列表时兜底回 architect
        - content    : 直接作为对外展示的 message
        """
        done_str = output.done.strip().lower()
        is_done = done_str in {"true", "yes", "1", "y", "done", "完成"}

        next_agent_name = output.next_agent.strip().lower()
        if next_agent_name not in AGENT_NAMES:
            logger.warning(
                f"[{self.name}] next_agent='{next_agent_name}' 不在已知列表，兜底回 {ARCHITECT}"
            )
            next_agent_name = ARCHITECT

        return AgentResponse(
            agent_name=self.name,
            role=self.role,
            message=output.content.strip(),
            next_agent=next_agent_name,
            done=is_done,
            used_rag=self.RAGRetriever.call_count > 0,
        )
