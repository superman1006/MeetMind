"""Output formatting helpers for the CLI."""

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
    return _console


def format_separator(title: str = "", char: str = "=", width: int = 70) -> str:
    if not title:
        return char * width
    pad = max(0, width - len(title) - 2)
    left = pad // 2
    right = pad - left
    return f"{char * left} {title} {char * right}"


def format_agent_output(
    agent_name: str,
    message: str,
    next_role: str | None = None,
    used_rag: bool = False,
    rag_sources: list[str] | None = None,
) -> None:
    """Render an agent's response as a styled rich panel."""
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
    _console.print(f"[bold white on blue] SYSTEM [/bold white on blue] {message}")


def print_user_prompt(prompt: str) -> str:
    _console.print(f"\n[bold magenta]{prompt}[/bold magenta]")
    return input("> ").strip()
