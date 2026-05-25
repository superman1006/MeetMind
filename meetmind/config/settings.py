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
    pydantic 的 BaseSettings 会从 model_config 定义的 env_file（这里是项目根目录下的 .env）
    加载环境变量，并把它们映射到类属性上。
    """
    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ---------- LLM (OpenAI 兼容) ----------
    api_key: str = Field(default="", description="LLM API key")
    base_url: str = Field(default="", description="LLM API base URL")
    model_name: str = Field(default="", description="Chat model identifier")
    max_tokens: int = Field(default=2000)
    temperature: float = Field(default=0.4)

    # ---------- 种子文件（输入） ----------
    seed_data_path: Path = Field(default=PROJECT_ROOT / "data" / "seed")

    # ---------- Elasticsearch (存储 + BM25 + 向量) ----------
    es_url: str = Field(default="http://localhost:9200")
    es_api_key: str = Field(default="", description="可空；本地 docker ES 默认关闭鉴权时留空即可")
    es_index_prefix: str = Field(default="meetmind", description="实际 index 名 = <prefix>_<agent>")

    # ---------- Embedding (本地 sentence-transformers) ----------
    embedding_model_name: str = Field(default="sentence-transformers/all-MiniLM-L6-v2")
    # 模型缓存目录：默认放项目内 ./models/，避免依赖用户家目录的 ~/.cache/huggingface/
    # 这样首次下载也在项目内，换机/拷贝项目就能带走，不会要重下
    embedding_cache_dir: Path = Field(default=PROJECT_ROOT / "models")

    # ---------- Cohere Rerank ----------
    cohere_api_key: str = Field(default="")
    cohere_rerank_model: str = Field(default="rerank-v4.0-pro")

    # ---------- 检索参数 ----------
    retrieve_top_n: int = Field(default=20, description="ES BM25 + kNN 各自捞这么多候选送 rerank")
    rerank_top_n: int = Field(default=5, description="Cohere rerank 后给 LLM 的最终条数")

    # ---------- 日志 / 安全阀 ----------
    log_level: str = Field(default="INFO")
    max_iterations: int = Field(default=15, description="LangGraph 单轮最大节点数")

    # ---- 路径校验：把 .env 里写的相对路径锚定到项目根 ----
    @field_validator("seed_data_path", "embedding_cache_dir", mode="after")
    @classmethod
    def _resolve_relative_to_project_root(cls, v: Path) -> Path:
        """把相对路径解析为相对 PROJECT_ROOT 的绝对路径。

        例如 `.env` 里写 `SEED_DATA_PATH=./data/seed`，无论从哪个 cwd
        启动都会解析为 `<PROJECT_ROOT>/data/seed`，而不是当前目录下的同名目录。
        """
        if v.is_absolute():
            return v
        resolved = (PROJECT_ROOT / v).resolve()
        return resolved


# @lru_cache 让 get_settings() 在第一次调用时创建一个 Settings 实例并将其 缓存 起来。
# 之后的调用都是缓存的实例。是单例——整个程序生命周期只读一次 .env。
@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """单例配置访问器。"""
    return Settings()
