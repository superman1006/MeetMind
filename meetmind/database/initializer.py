"""用种子文档初始化各 agent 的 Chroma 数据库。"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from meetmind.config.constants import AGENT_NAMES
from meetmind.config.settings import get_settings
from meetmind.database.client import get_agent_client, get_agent_collection
from meetmind.utils.logger import get_logger

logger = get_logger(__name__)


def _load_seed_file(agent_name: str) -> list[dict]:
    """把对应的agent的种子文件加载到内存中"""
    seed_file = get_settings().seed_data_path / f"{agent_name}_seeds.json"
    if not seed_file.exists():
        logger.warning("No seed file for %s at %s", agent_name, seed_file)
        return []
    with open(seed_file, "r", encoding="utf-8") as f:
        return json.load(f)


def _seed_agent(agent_name: str) -> int:
    """把每一个 agent 的种子文件中的文档添加到数据库中对应的 collections中, 返回新添加的文档数量."""
    collection = get_agent_collection(agent_name)
    seeds = _load_seed_file(agent_name)
    if not seeds:
        return 0

    # 拿到当前 collection 中已经存在的文档的ID, 以避免重复添加
    existing_ids = set(collection.get().get("ids") or [])

    ids: list[str] = []
    documents: list[str] = []
    metadatas: list[dict] = []
    for i, seed in enumerate(seeds):
        doc_id = f"{agent_name}_seed_{i}"
        # 如果这个 doc_id 已经存在于 collection 中了, 就跳过添加, 否则就把它添加到待添加的列表中
        if doc_id in existing_ids:
            continue
        # 把三个参数添加到待添加的列表中, 最后一起添加到 collection 中
        ids.append(doc_id)
        documents.append(seed["content"])
        metadatas.append(
            {
                "type": seed.get("type", "note"),
                "date": seed.get("date", ""),
                "source": f"seed:{agent_name}",
            }
        )

    if ids:
        # 添加新的文档到 collection 中
        collection.add(ids=ids, documents=documents, metadatas=metadatas)
        logger.info("Seeded %s with %d new documents.", agent_name, len(ids))
    else:
        logger.info("%s already up to date (%d docs).", agent_name, len(existing_ids))

    return len(ids)


def initialize_all_agents() -> dict[str, int]:
    """幂等：为每个 agent 播种数据库，返回各 agent 新增文档数。"""
    results: dict[str, int] = {}
    for agent in AGENT_NAMES:
        results[agent] = _seed_agent(agent)
    return results


def reset_agent_db(agent_name: str) -> None:
    """清空并重新播种单个 agent 的数据库。"""
    settings = get_settings()
    agent_dir: Path = settings.chroma_base_path / agent_name

    # 删除目录前先清除缓存的客户端
    get_agent_client.cache_clear()

    if agent_dir.exists():
        shutil.rmtree(agent_dir)
        logger.info("Removed %s", agent_dir)

    _seed_agent(agent_name)
