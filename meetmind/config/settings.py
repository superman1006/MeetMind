"""Pydantic-based application settings, loaded from environment / .env."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """All runtime configuration for MeetMind.

    Reads from environment variables and the project-level .env file.
    Field names map case-insensitively to env vars
    (e.g. `api_key` <- `API_KEY`).
    """

    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # OpenAI-compatible LLM endpoint (e.g. Xiaomi MiMo)
    api_key: str = Field(default="", description="LLM API key")
    base_url: str = Field(default="", description="LLM API base URL")
    model_name: str = Field(default="", description="Model identifier")

    # Generation parameters
    max_tokens: int = Field(default=2000)
    temperature: float = Field(default=0.4)

    # Database — RAG data lives at the project root (sibling of data/ and tests/)
    chroma_base_path: Path = Field(default=PROJECT_ROOT / "chroma_data")
    seed_data_path: Path = Field(default=PROJECT_ROOT / "data" / "seed")

    # Logging
    log_level: str = Field(default="INFO")

    # Runtime limits
    max_iterations: int = Field(default=15, description="Safety cap on graph loops")
    rag_top_k: int = Field(default=3)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Singleton settings accessor."""
    return Settings()
