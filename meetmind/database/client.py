"""Elasticsearch 单例 client + 每 agent 的 index 管理。

每个 agent 一个独立 index（默认名 `meetmind_<agent>`），mapping 同时包含：
  - `content`   text 字段，由 ES 内置 standard 分词器索引 → BM25 检索
  - `embedding` dense_vector 字段，维度由 embedding 模型决定 → kNN 向量检索
  - `metadata.*` keyword 字段，便于回查来源

这样一份文档同时支持 BM25 关键词检索 和 dense kNN 向量检索，无需另开存储。
"""

from __future__ import annotations

from functools import lru_cache

from elasticsearch import Elasticsearch

from meetmind.config.settings import get_settings
from meetmind.database.constants import get_index_name
from meetmind.database.embedding import get_embed_model_dim
from meetmind.utils.logger import get_logger

logger = get_logger(__name__)


@lru_cache(maxsize=1)
def get_es_client() -> Elasticsearch:
    """返回进程内单例的 Elasticsearch client。"""
    settings = get_settings()

    kwargs: dict = {"hosts": [settings.es_url]}

    # 如果有远程 ES 需要认证，API key 来自 settings.es_api_key（.env 里的 ES_API_KEY）
    if settings.es_api_key:
        kwargs["api_key"] = settings.es_api_key

    client = Elasticsearch(**kwargs)
    return client


def ping_es() -> bool:
    """检查 ES 是否可达。失败不抛错，只返回 False，由调用方友好提示。"""
    try:
        client = get_es_client()
        ok = client.ping()
        return bool(ok)
    except Exception as exc:
        logger.warning(f"[es] ping 失败: {exc}")
        return False


# 主要方法
def get_agent_index(agent_name: str) -> str:
    """确保某 agent 的 index 存在；返回 index 名字。

    第一次调用会用 dense_vector + text 混合 mapping 建 index；
    已存在则什么都不做（mapping 不会被覆盖）。
    """
    client = get_es_client()
    index_name = get_index_name(agent_name)

    # 如果 index 已存在，直接返回名字；否则创建新的 index
    if client.indices.exists(index=index_name):
        return index_name

    dim = get_embed_model_dim()
    mapping = {
        "settings": {
            "number_of_shards": 1,
            "number_of_replicas": 0,
        },
        "mappings": {
            "properties": {
                "content": {
                    # standard 分词器即可：对中文按字符切，召回不算精细，
                    # 但后面有 Cohere rerank 兜底，关键词检索粗一点没关系
                    "type": "text",
                    "analyzer": "standard",
                },
                "embedding": {
                    "type": "dense_vector",
                    "dims": dim,
                    "index": True,
                    "similarity": "cosine",
                },
                "metadata": {
                    "properties": {
                        "type": {"type": "keyword"},
                        "date": {"type": "keyword"},
                        "source": {"type": "keyword"},
                    }
                },
            }
        },
    }

    client.indices.create(index=index_name, body=mapping)
    logger.info(f"[es] 已创建 index {index_name}（dense_vector dim={dim}）")
    return index_name


def count_docs(agent_name: str) -> int:
    """返回某 agent index 当前的文档数（用于 CLI 打印 / 调试）。不存在则返回 0。"""
    client = get_es_client()
    index_name = get_index_name(agent_name)
    if not client.indices.exists(index=index_name):
        return 0
    resp = client.count(index=index_name)
    return int(resp.get("count", 0))


def delete_agent_index(agent_name: str) -> None:
    """清掉某 agent 的整个 index（重灌前用）。"""
    client = get_es_client()
    index_name = get_index_name(agent_name)
    if client.indices.exists(index=index_name):
        client.indices.delete(index=index_name)
        logger.info(f"[es] 已删除 index {index_name}")
