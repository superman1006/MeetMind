"""CLI 输出格式化工具，统一基于 rich.console。

提供：
  - 单例 console 获取
  - 横向分隔线
  - agent 回复面板（带角色颜色、RAG 来源、下一发言人）
  - 系统级 banner / 提示
"""

from __future__ import annotations

from rich.console import Console
from rich.panel import Panel
from rich.text import Text

from meetmind.config.constants import ROLE_DESCRIPTIONS

ROLE_COLORS = {
    "architect": "bold magenta",
    "backend": "bold green",
    "frontend": "bold cyan",
    "tester": "bold yellow",
    "pm": "bold blue",
    "system": "bold white",
}

_console = Console()


def get_console() -> Console:
    """返回进程内单例 rich Console，确保全模块输出顺序一致。"""
    return _console


def format_separator(title: str = "", char: str = "=", width: int = 70) -> str:
    """生成一行横向分隔线；若给了 title 则居中嵌进去。"""
    if not title:
        return char * width
    pad = max(0, width - len(title) - 2)
    left = pad // 2
    right = pad - left
    return f"{char * left} {title} {char * right}"


def print_agent_info(
    agent_name: str,
    message: str,
    next_role: str | None = None,
    used_rag: bool = False,
    rag_sources: list[str] | None = None,
) -> None:
    """把一个 agent 的回复渲染成带颜色边框的 rich 面板并打印到 console。

    本函数只负责"展示"——不做任何路由判断或状态写入；
    后者由 graph/builder._make_node_fn 完成。
    """
    color = ROLE_COLORS.get(agent_name, "white")
    role_desc = ROLE_DESCRIPTIONS.get(agent_name, agent_name)

    body = Text(message.strip())

    footer_parts: list[str] = []
    if used_rag:
        sources_str = ", ".join(rag_sources or []) or "(unspecified)"
        footer_parts.append(f"📚 RAG sources: {sources_str}")
    if next_role:
        footer_parts.append(f"➡️  Next: [bold]{next_role}[/bold]")

    if footer_parts:
        body.append("\n\n")
        body.append(Text.from_markup(" | ".join(footer_parts), style="dim"))

    panel = Panel(
        body,
        title=f"[{color}]{role_desc}[/{color}]",
        title_align="left",
        border_style=color,
        padding=(0, 1),
    )
    _console.print(panel)


def print_system(message: str) -> None:
    """打印一行系统级提示，前缀是反色高亮的 SYSTEM 标签。"""
    _console.print(f"[bold white on blue] SYSTEM [/bold white on blue] {message}")
