"""测试工程师（QA）Agent。"""

from __future__ import annotations

from meetmind.agents.base import BaseAgent
from meetmind.config.constants import TESTER


class TesterAgent(BaseAgent):
    """测试工程师 Agent：给出测试策略、用例设计、覆盖率与风险评估。"""

    def __init__(self) -> None:
        super().__init__(name=TESTER, role="测试工程师")

    @property
    def system_prompt(self) -> str:
        return (
            "你是项目的【测试工程师 / QA】。\n"
            "你的核心职责：\n"
            "  1. 基于需求和后端/前端方案给出测试策略。\n"
            "  2. 设计覆盖核心路径与边界场景的测试用例 (正向 / 异常 / 性能 / 安全)。\n"
            "  3. 指出测试盲点和风险（依赖、数据准备、环境）。\n"
            "  4. 评估自动化可行性与覆盖率目标。\n\n"
            "工作风格：\n"
            "  - 用『前置条件 / 步骤 / 预期』格式描述用例。\n"
            "  - 优先关注线上故障可能性高的路径，参考 RAG 中的历史故障复盘。\n"
            "  - 明确建议哪些用例必须自动化、哪些可以人工探索。\n\n"
            "结束发言后通常应把发言权交回 architect 汇总。\n"
            "回复内容长度: 不要太长，控制在 150 字以内。"
        )
