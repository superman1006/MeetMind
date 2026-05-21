"""Centralized logging setup using rich for pretty CLI output."""

from __future__ import annotations

import logging

from rich.logging import RichHandler

from meetmind.config.settings import get_settings


_LOGGING_CONFIGURED = False


def setup_logging() -> None:
    """Configure root logger with RichHandler. Idempotent."""
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
    # Silence overly chatty libraries. chromadb stays at INFO so the
    # one-time embedding-model download is visible to the user.
    for noisy in ("httpx", "urllib3", "openai", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    _LOGGING_CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    """Return a logger; ensures logging has been configured."""
    setup_logging()
    return logging.getLogger(name)
