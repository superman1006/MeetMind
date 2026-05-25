"""使用 rich 的集中式日志配置，用于美观的 CLI 输出。"""

from __future__ import annotations

import logging
import os
import warnings

from rich.logging import RichHandler

from meetmind.config.settings import get_settings


_LOGGING_CONFIGURED = False


def _silence_huggingface_hub_warnings() -> None:
    """屏蔽 sentence-transformers 间接触发的 HF Hub 噪音。

    第一次没有 HF_TOKEN 拉模型时，huggingface_hub 会同时通过两条路径输出：
      1) `warnings.warn(...)` → 直接打到 stderr（顶部那行裸 "Warning: ..."）
      2) 标准 logging → 经过 RichHandler 渲染成带时间戳的 WARNING
    这里把两条路一起堵掉。
    """
    # ① warnings 路：按消息内容过滤掉 HF Hub 的"未鉴权"提示
    warnings.filterwarnings(
        "ignore",
        message=r".*HF[\s_]?Hub.*",
    )
    warnings.filterwarnings(
        "ignore",
        message=r".*HF_TOKEN.*",
    )
    # ② logging 路：把相关 logger 全部压到 ERROR，连 WARNING 都不打
    for hf_logger in (
        "huggingface_hub",
        "huggingface_hub.utils._auth",
        "huggingface_hub.file_download",
        "filelock",
    ):
        logging.getLogger(hf_logger).setLevel(logging.ERROR)

    # ③ 如果 hf_hub 暴露官方 verbosity API，就一并调用（不同版本可能没有，try 一下）
    try:
        from huggingface_hub.utils import logging as hf_logging  # type: ignore
        hf_logging.set_verbosity_error()
    except Exception:
        pass

    # ④ 环境变量兜底，对某些 hf 子包有效
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")


def setup_logging() -> None:
    """使用 RichHandler 配置根日志器。幂等。"""
    global _LOGGING_CONFIGURED
    if _LOGGING_CONFIGURED:
        return

    # 先把 HF Hub 噪音堵掉（要在 sentence-transformers 真正下载/加载前生效）
    _silence_huggingface_hub_warnings()

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
    # 降低过于冗长的第三方库日志级别。sentence-transformers / transformers 默认 INFO
    # 会一次性吐很多模型加载日志，统一压成 WARNING。
    for noisy in (
        "httpx", "urllib3", "openai", "httpcore",
        "elastic_transport", "elasticsearch",
        "sentence_transformers", "transformers",
    ):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    _LOGGING_CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    """返回 logger；确保日志已配置。"""
    setup_logging()
    return logging.getLogger(name)
