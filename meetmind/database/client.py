"""Chroma 持久化客户端管理 — 每个 agent 独立数据库。"""

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
    """返回指向该 agent 目录的缓存 PersistentClient。"""
    # PersistentClient 是 Chroma 的嵌入式模式（chromadb 提供的底层能力），对应本地 SQLite 文件
    return chromadb.PersistentClient(path=str(_agent_db_dir(agent_name)))


def get_agent_collection(agent_name: str) -> Collection:
    """返回（必要时创建）该 agent 的知识集合。"""
    client = get_agent_client(agent_name)
    # 拿到客户端后, 在数据库中创建一个自己的表,一个 agent 对应一个表,create 只是创建,并没有把 doc 存进去
    return client.get_or_create_collection(
        name=collection_name_for(agent_name),
        metadata={"description": f"{agent_name} agent knowledge base"},
    )
