"""用种子文档初始化每个 agent 的 ES index。

种子目录结构：
    data/seed/
        architect/    ← 这个子目录里的所有支持格式文件都会被灌入 architect 的 index
            seeds.json
            roadmap.pdf
            decisions.md
        backend/
            seeds.json
            api_spec.docx
        ...

每个文件按其后缀走 `loaders.py` 里对应的 loader，然后过 `splitters.split_docs`
按文件类型切块，再用 `embedding.embed_batch` 算向量，最后用 ES 的 bulk API
批量写入。doc_id 基于内容 md5，保证幂等。
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from elasticsearch.helpers import bulk

from meetmind.config.constants import AGENT_NAMES
from meetmind.config.settings import get_settings
from meetmind.database.client import (
    delete_agent_index,
    get_agent_index,
    get_es_client,
)
from meetmind.database.embedding import embed_batch
from meetmind.database.loaders import load_file
from meetmind.database.splitters import split_docs
from meetmind.utils.logger import get_logger

logger = get_logger(__name__)


def _agent_seed_dir(agent_name: str) -> Path:
    """返回 `data/seed/<agent_name>/`。"""
    seed_root = get_settings().seed_data_path
    return seed_root / agent_name


def _get_seeds_content(agent_name: str) -> list[dict]:
    """扫描 agent 子目录下所有受支持的文件，返回合并后的文档列表。

    每个元素至少有 `content` 字段，其它键（type / date / source）作为 metadata 存。
    若目录不存在，回退到旧布局 `data/seed/<agent>_seeds.json`（向后兼容）。
    """
    agent_dir = _agent_seed_dir(agent_name)

    if not agent_dir.exists():
        legacy_file = get_settings().seed_data_path / f"{agent_name}_seeds.json"
        if legacy_file.exists():
            return load_file(legacy_file)
        logger.warning(f"没有 {agent_name} 的种子目录或旧种子文件")
        return []

    docs: list[dict] = []
    for path in sorted(agent_dir.iterdir()):
        if not path.is_file() or path.name.startswith("."):
            continue
        loaded = load_file(path)
        if loaded:
            logger.info(f"[{agent_name}] 从 {path.name} 加载了 {len(loaded)} 段")
        docs.extend(loaded)
    return docs


def _generate_doc_id(agent_name: str, content: str) -> str:
    """基于内容 hash 生成稳定的 doc_id —— 同内容只灌一次，幂等。"""
    digest = hashlib.md5(content.encode("utf-8")).hexdigest()[:12]
    return f"{agent_name}_{digest}"


def _get_existing_ids(index_name: str) -> set[str]:
    """读出 index 内所有现有 doc id（用于跳过已灌过的内容，保证幂等）。"""
    client = get_es_client()
    if not client.indices.exists(index=index_name):
        return set()

    existing: set[str] = set()
    # scroll 取全量；种子集合通常很小，简单实现就够
    resp = client.search(
        index=index_name,
        body={"_source": False, "query": {"match_all": {}}},
        size=10000,
    )
    for hit in resp["hits"]["hits"]:
        existing.add(hit["_id"])
    return existing


def load_seeds_to_es(agent_name: str) -> int:
    """把单个 agent 子目录下的所有种子文件灌入它的 ES index。

    步骤：
      1. 扫描 + load_file 把各种格式解析成 list[dict]
      2. split_docs 按文件类型切块
      3. 跳过已存在的 doc_id（基于内容 md5）
      4. embed_batch 算 dense vector
      5. bulk index 到 ES

    返回本次实际新增的文档条数。
    """
    seed_contents = _get_seeds_content(agent_name)
    if not seed_contents:
        return 0

    seed_chunks = split_docs(seed_contents)

    index_name = get_agent_index(agent_name)
    existing_ids = _get_existing_ids(index_name)

    new_ids: list[str] = []
    new_contents: list[str] = []
    new_metadatas: list[dict] = []

    for chunk in seed_chunks:
        content = chunk.get("content", "").strip()
        if not content:
            continue
        doc_id = _generate_doc_id(agent_name, content)
        if doc_id in existing_ids:
            continue
        new_ids.append(doc_id)
        new_contents.append(content)
        new_metadatas.append(
            {
                "type": chunk.get("type"),
                "date": chunk.get("date"),
                "source": chunk.get("source"),
            }
        )

    if not new_ids:
        logger.info(f"{agent_name} 已是最新（共 {len(existing_ids)} 条）")
        return 0

    # 批量算向量
    vectors = embed_batch(new_contents)

    # 拼 bulk 操作流
    actions = []
    for doc_id, content, meta, vec in zip(new_ids, new_contents, new_metadatas, vectors):
        action = {
            "_op_type": "index",
            "_index": index_name,
            "_id": doc_id,
            "_source": {
                "content": content,
                "embedding": vec,
                "metadata": meta,
            },
        }
        actions.append(action)

    client = get_es_client()

    # bulk API 批量写入；refresh=wait_for 确保写入后才能被搜索到（虽然会稍微慢一点，但保证了后续流程的正确性）
    success, errors = bulk(client, actions, refresh="wait_for")
    if errors:
        logger.warning(f"[{agent_name}] bulk index 部分失败: {errors}")

    logger.info(f"已为 {agent_name} 新增 {success} 条文档")
    return int(success)


def build_agents_indices() -> dict[str, int]:
    """为所有 agent 灌入种子数据。返回每个 agent 本次新增的文档数。"""

    # {
    #     "architect": 5,
    #     "backend": 3,
    #     "frontend": 0,
    #     "tester": 2,
    #     "pm": 1,
    # }
    results: dict[str, int] = {}
    for agent_name in AGENT_NAMES:
        results[agent_name] = load_seeds_to_es(agent_name)
    return results


def reset_agent_db(agent_name: str) -> None:
    """清空并重新灌入单个 agent 的 index（开发者工具，不在启动流程中调用）。"""
    delete_agent_index(agent_name)
    load_seeds_to_es(agent_name)
