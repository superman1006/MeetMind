"""MeetMind 的交互式 CLI 入口。"""

from __future__ import annotations

import sys
from datetime import datetime

from rich.console import Console
from rich.panel import Panel

from meetmind.config.constants import ROLE_DESCRIPTIONS
from meetmind.config.settings import get_settings
from meetmind.database.initializer import initialize_all_agents
from meetmind.graph.builder import build_agent_graph
from meetmind.graph.state import AgentState
from meetmind.utils.formatting import format_separator, get_console, print_system
from meetmind.utils.logger import get_logger, setup_logging


# 强制 stdin/stdout 使用 UTF-8，避免非 UTF-8 区域设置的终端
# 输入中文时产生代理码点导致 httpx 崩溃。
for stream in (sys.stdin, sys.stdout, sys.stderr):
    reconfigure = getattr(stream, "reconfigure", None)
    if reconfigure is not None:
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


logger = get_logger(__name__)
console: Console = get_console()


def _print_banner() -> None:
    """打印应用横幅和 Agent 角色介绍。"""
    console.print(
        Panel.fit(
            "[bold cyan]MeetMind[/bold cyan]   多 Agent RAG 协作系统\n"
            "[dim]架构师 → 后端 / 前端 / 测试 / 产品经理 — 基于 LangGraph + Chroma[/dim]",
            border_style="cyan",
        )
    )
    console.print()
    console.print("[bold]当前 Agent 团队:[/bold]")
    for role_id, desc in ROLE_DESCRIPTIONS.items():
        console.print(f"  • [bold]{role_id:10}[/bold] - {desc}")
    console.print()


def _bootstrap() -> None:
    """校验配置、初始化日志、播种数据库。"""
    setup_logging()
    settings = get_settings()

    missing = [
        name
        for name, value in [
            ("API_KEY", settings.api_key),
            ("BASE_URL", settings.base_url),
            ("MODEL_NAME", settings.model_name),
        ]
        if not value
    ]
    if missing:
        console.print(
            f"[bold red]✗ 缺少环境变量: {', '.join(missing)}[/bold red]\n"
            "请复制 .env.example 为 .env 并填入对应的 LLM 配置（API_KEY / BASE_URL / MODEL_NAME）。"
        )
        sys.exit(1)

    is_first_run = not settings.chroma_base_path.exists() or not any(
        settings.chroma_base_path.iterdir()
    )
    print_system(f"RAG 存储位置: [cyan]{settings.chroma_base_path}[/cyan] (本地 SQLite)")
    if is_first_run:
        print_system(
            "[yellow]首次启动：Chroma 会从 S3 下载 ~80MB 的 ONNX embedding 模型到 "
            "~/.cache/chroma/，首次约 1-2 分钟，之后启动只需几秒。[/yellow]"
        )

    with console.status(
        "[bold cyan]初始化 5 个 Agent 的知识库...", spinner="dots"
    ):
        added = initialize_all_agents()

    for agent, n in added.items():
        if n:
            print_system(f"  ✓ {agent}: 新增 {n} 条种子文档")
        else:
            print_system(f"  ✓ {agent}: 已就绪")


def _run_one_discussion(graph, requirement: str) -> AgentState:
    """使用 `stream_mode='values'` 流式运行一轮由架构师主导的讨论，
    以获取最终累积状态。"""
    initial_state: AgentState = {
        "requirement": requirement,
        "messages": [],
        "next_agent": None,
        "complete": False,
        "iteration": 0,
    }

    console.print()
    console.print(format_separator(f"讨论开始: {datetime.now().strftime('%H:%M:%S')}"))
    console.print()

    final_state: AgentState = initial_state
    for state in graph.stream(
        initial_state,
        config={"recursion_limit": 50},
        stream_mode="values",
    ):
        final_state = state  # type: ignore[assignment]

    console.print()
    console.print(format_separator("讨论结束"))
    console.print()
    return final_state


def _architect_review(state: AgentState) -> bool:
    """由人类架构师决定是否继续；返回 True 表示继续。"""
    msgs = state.get("messages") or []
    n_turns = len(msgs)
    complete = state.get("complete", False)

    console.print(
        Panel(
            f"本轮共 {n_turns} 次 agent 发言；"
            + ("[bold green]架构师已宣布完成 ✅[/bold green]" if complete else "[yellow]架构师未宣布完成[/yellow]"),
            title="[bold]架构师复盘[/bold]",
            border_style="magenta",
        )
    )

    console.print(
        "\n请选择下一步:\n"
        "  [bold]c[/bold] - 提出新的需求 / 追问 (continue)\n"
        "  [bold]q[/bold] - 结束本次会话 (quit)\n"
    )
    while True:
        choice = console.input("[bold magenta]架构师 >[/bold magenta] ").strip().lower()
        if choice in {"c", "q"}:
            return choice == "c"
        console.print("[red]请输入 c 或 q[/red]")


def main() -> None:
    _print_banner()
    _bootstrap()

    graph = build_agent_graph()

    console.print(
        Panel.fit(
            "[bold]使用说明[/bold]\n"
            "1. 架构师（你）输入需求；\n"
            "2. 系统将自动驱动 5 个 agent 讨论，按 [NEXT_AGENT: …] 路由；\n"
            "3. 架构师 agent 宣布 [DONE] 后本轮结束，由你决定继续或退出。",
            border_style="yellow",
        )
    )

    while True:
        console.print()
        console.print("[bold magenta]架构师，请输入项目需求 (输入 'quit' 退出):[/bold magenta]")
        try:
            requirement = console.input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            console.print("\n[bold]再见！[/bold]")
            return

        if not requirement:
            continue
        if requirement.lower() in {"quit", "exit", "q"}:
            console.print("\n[bold]再见！[/bold]")
            return

        final_state = _run_one_discussion(graph, requirement)

        if not _architect_review(final_state):
            console.print("\n[bold]再见！[/bold]")
            return


if __name__ == "__main__":
    main()
