"""使用 rich 的集中式日志配置，用于美观的 CLI 输出。"""

from __future__ import annotations

import logging

from rich.logging import RichHandler

from meetmind.config.settings import get_settings


_LOGGING_CONFIGURED = False


def setup_logging() -> None:
    """使用 RichHandler 配置根日志器。幂等。"""
    global _LOGGING_CONFIGURED
    if _LOGGING_CONFIGURED:
        return

    settings = get_settings()
    logging.basicConfig(
        level=settings.log_level.upper(),
        format="%(message)s",
        datefmt="[%X]",
        handlers=[
            RichHandler(
                rich_tracebacks=True,
                show_time=True,
                show_path=False,
                markup=True,
            )
        ],
    )
    # 降低过于冗长的第三方库日志级别。chromadb 保持 INFO，
    # 以便用户能看到一次性 embedding 模型下载。
    for noisy in ("httpx", "urllib3", "openai", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    _LOGGING_CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    """返回 logger；确保日志已配置。"""
    setup_logging()
    return logging.getLogger(name)
