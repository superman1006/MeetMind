"""基于 Pydantic 的应用配置，从环境变量 / .env 加载。"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


PROJECT_ROOT = Path(__file__).resolve().parents[2]
# parent[0]是当前目录，parent[1]是上一级目录，parent[2]是上上一级目录，也就是项目根目录


class Settings(BaseSettings):
    """MeetMind 的全部运行时配置。

    从环境变量与项目根目录 .env 读取。
    字段名与环境变量大小写不敏感映射
    （例如 `api_key` <- `API_KEY`）。
    """
    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # 兼容 OpenAI 的 LLM 端点（如小米 MiMo）
    api_key: str = Field(default="", description="LLM API key")
    base_url: str = Field(default="", description="LLM API base URL")
    model_name: str = Field(default="", description="Model identifier")

    # 生成参数
    max_tokens: int = Field(default=2000)
    temperature: float = Field(default=0.4)

    # 数据库 — RAG 数据位于项目根目录（与 data/、tests/ 同级）
    chroma_base_path: Path = Field(default=PROJECT_ROOT / "chroma_data")
    seed_data_path: Path = Field(default=PROJECT_ROOT / "data" / "seed")

    # 日志
    log_level: str = Field(default="INFO")

    # 运行时限制
    max_iterations: int = Field(default=15, description="Safety cap on graph loops")
    rag_top_k: int = Field(default=3)

    # ---- 路径校验：把 .env 里写的相对路径锚定到项目根，避免不同 cwd 下解析到错位 ----
    @field_validator("chroma_base_path", "seed_data_path", mode="after")
    @classmethod
    def _resolve_relative_to_project_root(cls, v: Path) -> Path:
        """把相对路径解析为相对 PROJECT_ROOT 的绝对路径。

        例如 `.env` 里写 `CHROMA_BASE_PATH=./chroma_data`，无论从哪个 cwd
        启动都会解析为 `<PROJECT_ROOT>/chroma_data`，而不是当前目录下的同名目录。
        """
        if not v.is_absolute():
            return (PROJECT_ROOT / v).resolve()
        return v



# @lru_cache 让 get_settings() 在第一次调用时创建一个 Settings 实例并将其缓存起来。
# 之后的调用的都是缓存的实例。确保了整个程序中使用同一个对象，避免了重复读取。
# 是单例——整个程序生命周期只读一次 .env，不管被谁调用多少次，永远返回同一个 Settings 对象。
@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """单例配置访问器。"""
    return Settings()
