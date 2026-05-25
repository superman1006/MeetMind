"""MeetMind 的交互式 CLI 入口。"""

from __future__ import annotations

import os
import sys
from datetime import datetime

from dotenv import load_dotenv

# uv run meetmind 直接调用 cli.main:main，不会经过根目录 main.py，
# 所以这里也要 load_dotenv() 确保 os.environ 里有 LANGSMITH_* 变量。
# load_dotenv() 是幂等的：若变量已在环境中则不覆盖。
# load_dotenv()

from rich.console import Console
from rich.panel import Panel

from meetmind.config.constants import AGENT_NAMES, ROLE_DESCRIPTIONS
from meetmind.config.settings import get_settings
from meetmind.database.client import count_docs, ping_es
from meetmind.database.initializer import build_agents_indices
from meetmind.graph.builder import build_graph
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
    """bootstrap是引导,导入配置文件,构建知识库"""
    setup_logging()
    settings = get_settings()
    print("="*40,"get_settings()拿到配置", "="*40)
    for setting in settings:
        print(f"配置项 {setting}")
    print("="*100)
    print()



    # ---------- ES 健康检查（启动硬依赖） ----------
    print_system(f"Elasticsearch 地址: [cyan]{settings.es_url}[/cyan]")
    es_ok = ping_es()
    if not es_ok:
        print_system(
            "[bold red]✗ 无法连接到 Elasticsearch[/bold red]\n"
            "请先在项目根目录执行 [bold]docker compose up -d[/bold] 启动本地 ES，"
            "或修改 .env 中的 ES_URL 指向已有实例。"
        )
        sys.exit(1)
    print_system("[green]✓ Elasticsearch 已就绪[/green]")

    # ---------- Cohere key 检查 ----------
    if not settings.cohere_api_key:
        print_system(
            "[bold red]✗ 缺少 COHERE_API_KEY[/bold red]\n"
            "请在 .env 中配置 COHERE_API_KEY（用于检索后的 rerank 阶段）。"
        )
        sys.exit(1)
    print_system(
        f"Cohere Rerank: [cyan]{settings.cohere_rerank_model}[/cyan]  "
        f"(混合检索捞 [bold]{settings.retrieve_top_n}[/bold] → rerank 取 [bold]{settings.rerank_top_n}[/bold])"
    )

    # ---------- LangSmith 追踪状态 ----------
    langsmith_on = os.getenv("LANGSMITH_TRACING", "").lower() == "true"
    if langsmith_on:
        project = os.getenv("LANGSMITH_PROJECT", "default")
        print_system(
            f"LangSmith 追踪: [bold green]已启用[/bold green]  "
            f"项目: [cyan]{project}[/cyan]  "
            f"→ https://smith.langchain.com/projects/p/{project}"
        )
    else:
        print_system(
            "LangSmith 追踪: [dim]未启用（在 .env 中设置 LANGSMITH_TRACING=true 可开启）[/dim]"
        )

    # ---------- 扫描种子目录 ----------
    print_system("扫描各 Agent 的 seed 文件目录：")
    for agent in AGENT_NAMES:
        agent_dir = settings.seed_data_path / agent
        if not agent_dir.exists():
            print_system(f"   · [yellow]{agent}[/yellow]: (目录不存在，将走旧 *_seeds.json 兜底)")
            continue
        all_paths = agent_dir.iterdir()
        file_names = []
        for p in all_paths:
            if p.is_file() and not p.name.startswith("."):
                file_names.append(p.name)
        files = sorted(file_names)
        if not files:
            print_system(f"   · [yellow]{agent}[/yellow]: 目录为空")
        else:
            print_system(f"   · [cyan]{agent}[/cyan]: {len(files)} 个文件 → {', '.join(files)}")
    print()

    # ---------- 预热 embedding 模型 ----------
    # sentence-transformers 从磁盘加载到内存约 5-10 秒，且只发生一次（lru_cache）。
    # 首次启动还会从 HuggingFace 下载约 80MB 模型到 ~/.cache/huggingface/。
    from meetmind.database.embedding import get_embedder_model
    with console.status("[bold cyan]预热 embedding 模型 (80MB)...",spinner="dots"):
        get_embedder_model()
    print_system("[green]✓[/green] embedding 模型已加载到内存")

    # ---------- 灌库 (幂等) ----------
    with console.status("[bold cyan]初始化 5 个 Agent 的 ES index...", spinner="dots"):
        added = build_agents_indices()

    # 灌入结果 + index 当前总文档数（让用户看到 PDF 这类文件之前到底有没有进库）
    for agent in AGENT_NAMES:
        new = added.get(agent, 0)
        if new:
            status = f"新增 [bold green]{new}[/bold green] 条，"
        else:
            status = "[dim]无新增[/dim]，"
        print_system(f"  ✓ [bold]{agent}[/bold]: {status}index 现共 {count_docs(agent)} 条文档")


def _run_one_discussion(graph, requirement: str) -> AgentState:
    """ Session 其中的一个完整的讨论会话：从架构师输入需求开始，图驱动 agent 讨论，直到架构师宣布完成。"""
    initial_state: AgentState = {
        "requirement": requirement,
        "messages": [],
        "next_agent": None,
        "done": False,
        "iteration": 0,
    }

    console.print()
    console.print(format_separator(f"讨论开始: {datetime.now().strftime('%H:%M:%S')}"))
    console.print()

    # 初始 AgentState传入图。
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


def _next_round_or_not(state: AgentState) -> bool:
    """由人类架构师决定是否继续；返回 True 表示继续。"""
    msgs = state.get("messages") or []
    n_turns = len(msgs) # agent 发言的次数
    done = state.get("done", False)

    console.print(
        Panel(
            f"本轮共 {n_turns} 次 agent 发言；"
            + ("[bold green]架构师已宣布完成 ✅[/bold green]" if done else "[yellow]架构师未宣布完成[/yellow]"),
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
    """CLI 主循环：架构师输入需求 → 图驱动 5 个 agent 讨论 → 架构师复盘 → 重复或退出。"""
    _print_banner()
    _bootstrap()

    graph = build_graph()

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

        if not _next_round_or_not(final_state):
            console.print("\n[bold]再见！[/bold]")
            return


if __name__ == "__main__":
    main()
