"""Chroma persistent client management — one isolated DB per agent."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import chromadb
from chromadb.api import ClientAPI
from chromadb.api.models.Collection import Collection

from meetmind.config.settings import get_settings
from meetmind.database.constants import collection_name_for


def _agent_db_dir(agent_name: str) -> Path:
    base = get_settings().chroma_base_path
    path = base / agent_name
    path.mkdir(parents=True, exist_ok=True)
    return path


@lru_cache(maxsize=None)
def get_agent_client(agent_name: str) -> ClientAPI:
    """Return a cached PersistentClient pointing at the agent's directory."""
    return chromadb.PersistentClient(path=str(_agent_db_dir(agent_name)))


def get_agent_collection(agent_name: str) -> Collection:
    """Return (creating if needed) the agent's knowledge collection."""
    client = get_agent_client(agent_name)
    return client.get_or_create_collection(
        name=collection_name_for(agent_name),
        metadata={"description": f"{agent_name} agent knowledge base"},
    )
